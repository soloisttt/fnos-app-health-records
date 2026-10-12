import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { indicatorNameCandidates } from '../services/indicator-normalization.service';
import { runIndicatorDictionaryBackfillIfNeeded } from '../services/maintenance-runner.service';
import { listTrendSeries } from '../services/records.service';

const manager = { id: 'insulin-test-user', displayName: '合成账号', provider: 'development', authenticated: true, isGatewayAdmin: true } as const;

test('historical fasting insulin names form one trend without changing source observations', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'fasting-insulin-trend-'));
  const previousStorageDir = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare('INSERT INTO users(id, display_name) VALUES(?, ?)').run(manager.id, manager.displayName);
    db.prepare("INSERT INTO health_members(id, display_name, relationship, created_by) VALUES('insulin-test-member', '合成成员', 'self', ?)").run(manager.id);
    db.prepare("INSERT INTO member_permissions(member_id, user_id, permission, granted_by) VALUES('insulin-test-member', ?, 'manager', ?)").run(manager.id, manager.id);
    const insertReport = db.prepare(`
      INSERT INTO reports(id, member_id, created_by, title, report_type, status, report_issued_at, hospital_name_raw)
      VALUES(?, 'insulin-test-member', ?, '合成报告', 'laboratory', 'ready', ?, '合成机构')
    `);
    const insertObservation = db.prepare(`
      INSERT INTO observations(id, report_id, section_name, item_name, result_text, numeric_value, unit,
        reference_low, reference_high, reference_text, evidence_json)
      VALUES(?, ?, '胰岛功能', ?, ?, ?, ?, 2, 20, '2-20', ?)
    `);
    const cases = [
      ['first', '2026-01-01', '空腹胰岛素', 8, 'μU/ml'],
      ['second', '2026-02-01', '1 *空腹胰岛素(INS0)', 11, 'μU/ml'],
      ['postprandial', '2026-03-01', '餐后2小时胰岛素', 30, 'μU/ml'],
      ['unspecified', '2026-04-01', '胰岛素', 12, 'μU/ml'],
      ['different-unit', '2026-05-01', '空腹胰岛素', 1, 'ng/mL'],
      ['other-allowed-unit', '2026-06-01', '空腹胰岛素', 7, 'μIU/mL'],
    ] as const;
    for (const [id, date, name, value, unit] of cases) {
      insertReport.run(id, manager.id, date);
      insertObservation.run(id, id, name, String(value), value, unit,
        JSON.stringify([{ pageNumber: 1, quote: `${name} ${value} ${unit}` }]));
    }
    const oldNormalization = db.prepare(`
      INSERT INTO observation_normalizations(observation_id, confidence, quality, matched_by, match_reason, version)
      VALUES(?, 0, 'low', 'none', '历史未命中', 'core-r17')
    `);
    oldNormalization.run('first');
    oldNormalization.run('second');
    db.prepare("INSERT INTO app_settings(setting_key, value_json) VALUES('maintenance.indicator_normalization_version', '\"old-version\"')").run();

    assert.deepEqual(indicatorNameCandidates('1 *空腹胰岛素(INS0)'), ['空腹胰岛素', 'ins0']);
    assert.ok(indicatorNameCandidates('24小时尿蛋白').includes('24小时尿蛋白'));
    const backfill = runIndicatorDictionaryBackfillIfNeeded();
    assert.ok(backfill);
    assert.equal(backfill.previousVersion, 'old-version');
    assert.ok(backfill.updated >= 2);
    const normalized = db.prepare(`
      SELECT o.id, o.item_name AS itemName, o.numeric_value AS numericValue,
        n.canonical_key AS canonicalKey, n.canonical_unit AS canonicalUnit, n.quality
      FROM observations o JOIN observation_normalizations n ON n.observation_id = o.id ORDER BY o.id
    `).all() as Array<{ id: string; itemName: string; numericValue: number; canonicalKey: string | null; canonicalUnit: string | null; quality: string }>;
    const byId = new Map(normalized.map(row => [row.id, row]));
    assert.deepEqual(['first', 'second'].map(id => [byId.get(id)?.canonicalKey, byId.get(id)?.canonicalUnit, byId.get(id)?.quality]), [
      ['insulin_fasting', 'μU/mL', 'high'],
      ['insulin_fasting', 'μU/mL', 'high'],
    ]);
    assert.equal(byId.get('second')?.itemName, '1 *空腹胰岛素(INS0)');
    assert.equal(byId.get('second')?.numericValue, 11);
    assert.notEqual(byId.get('postprandial')?.canonicalKey, 'insulin_fasting');
    assert.notEqual(byId.get('unspecified')?.canonicalKey, 'insulin_fasting');
    assert.equal(byId.get('different-unit')?.quality, 'low');
    assert.equal(byId.get('different-unit')?.canonicalUnit, null);
    assert.equal(byId.get('other-allowed-unit')?.canonicalUnit, 'μIU/mL');

    const fasting = listTrendSeries(manager, 'insulin-test-member')
      .filter(series => series.indicatorKey === 'insulin_fasting' && series.unit === 'μU/mL');
    assert.equal(fasting.length, 1);
    assert.equal(fasting[0].kind, 'standard');
    assert.equal(fasting[0].pointCount, 2);
    assert.deepEqual(fasting[0].points.map(point => point.numericValue), [8, 11]);
    assert.equal(listTrendSeries(manager, 'insulin-test-member')
      .find(series => series.indicatorKey === 'insulin_fasting' && series.unit === 'μIU/mL')?.pointCount, 1,
    'units without an explicit conversion remain separate');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()!.count, 0,
      'dictionary backfill does not queue OCR or AI work');
    assert.equal(runIndicatorDictionaryBackfillIfNeeded(), null, 'a second maintenance cycle does not reprocess observations');
  } finally {
    closeDatabaseForTests();
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    rmSync(storageDir, { recursive: true, force: true });
  }
});
