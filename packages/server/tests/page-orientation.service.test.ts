import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { databaseMigrations } from '../database/migrations';
import type { RequestUser } from '../domain/request-user';
import { processNextJob } from '../services/job-runner.service';
import { getReportPageOcrDetail, getReportPagePreviewFile, rotateReportPage } from '../services/records.service';
import { createUpload } from '../services/upload.service';

const owner: RequestUser = { id: 'orientation-owner', displayName: '合成账号', provider: 'development', authenticated: true, isGatewayAdmin: true };
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

test('saving one page orientation preserves OCR and AI results without queuing recognition for any page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'page-orientation-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,?,1)").run(owner.id, owner.displayName);
    db.prepare("INSERT INTO health_members(id,display_name,relationship,created_by) VALUES('orientation-member','合成成员','self',?)").run(owner.id);
    db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('orientation-member',?,'manager',?)").run(owner.id, owner.id);
    const upload = createUpload(owner, 'orientation-member', [
      { originalName: 'one.png', data: png },
      { originalName: 'two.png', data: Uint8Array.from([...png, 0x02]) },
    ]);
    const pageId = upload.pages[0].id;
    const secondId = upload.pages[1].id;
    const ocrJob = db.prepare("SELECT id FROM processing_jobs WHERE page_id=? AND job_type='ocr'").get(pageId) as { id: string };
    db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json,coord_width,coord_height) VALUES('old-ocr',?,?,'test','v1',?,100,100)")
      .run(ocrJob.id, pageId, JSON.stringify([{ text: '合成文字', box: [1, 2, 20, 30] }]));
    db.prepare("UPDATE report_pages SET ocr_rotation=0 WHERE id=?").run(pageId);
    db.prepare("UPDATE processing_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP WHERE report_id=?").run(upload.reportId);
    db.prepare("UPDATE reports SET status='needs_review' WHERE id=?").run(upload.reportId);
    db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key,finished_at) VALUES('old-ai',?,'ai_extract','completed','health-record-v1','old-ai',CURRENT_TIMESTAMP)").run(upload.reportId);
    db.prepare("INSERT INTO report_extractions(id,report_id,job_id,provider,model,prompt_version,fields_json,raw_response_json) VALUES('old-extraction',?,'old-ai','test','test','v1','{}','{}')").run(upload.reportId);
    const sourceVersion = db.prepare("SELECT source_version AS version FROM reports WHERE id=?").get(upload.reportId)!.version;
    const before = db.prepare("SELECT job_type AS type,COUNT(*) AS n FROM processing_jobs WHERE report_id=? GROUP BY job_type").all(upload.reportId);

    const result = rotateReportPage(owner, upload.reportId, pageId, { expectedRotation: 0, rotation: 90 });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.pages.find(page => page.id === pageId)?.rotation, 90);
    assert.equal(result.pages.find(page => page.id === pageId)?.ocrStale, 1);
    assert.equal(result.pages.find(page => page.id === secondId)?.rotation, 0);
    const added = db.prepare("SELECT page_id AS pageId,job_type AS jobType,pipeline_version AS pipelineVersion,status FROM processing_jobs WHERE report_id=? AND pipeline_version='page-orientation-v1'").all(upload.reportId);
    assert.deepEqual(added.map(row => ({ ...row })), [{ pageId, jobType: 'thumbnail', pipelineVersion: 'page-orientation-v1', status: 'queued' }]);
    assert.deepEqual(db.prepare("SELECT job_type AS type,COUNT(*) AS n FROM processing_jobs WHERE report_id=? AND pipeline_version<>'page-orientation-v1' GROUP BY job_type").all(upload.reportId).map(row => ({ ...row })), before.map(row => ({ ...row })));
    assert.equal(db.prepare("SELECT lines_json AS lines FROM ocr_results WHERE id='old-ocr'").get()!.lines,
      JSON.stringify([{ text: '合成文字', box: [1, 2, 20, 30] }]));
    assert.equal(db.prepare("SELECT fields_json AS fields FROM report_extractions WHERE id='old-extraction'").get()!.fields, '{}');
    assert.equal(db.prepare("SELECT source_version AS version FROM reports WHERE id=?").get(upload.reportId)!.version, sourceVersion);
    const detail = await getReportPageOcrDetail(owner, upload.reportId, pageId);
    assert.equal(detail?.orientationChanged, true);
    assert.equal(detail?.lines[0]?.text, '合成文字');
    assert.equal(detail?.lines[0]?.box, null);
    const previewDir = join(dir, 'previews', upload.reportId);
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, `${pageId}.jpg`), Uint8Array.from([0xff, 0xd8, 0xff, 0x01]));
    writeFileSync(join(previewDir, `${pageId}.r90.jpg`), Uint8Array.from([0xff, 0xd8, 0xff, 0x02]));
    db.prepare("UPDATE report_pages SET mime_type='application/pdf' WHERE id=?").run(pageId);
    assert.equal((await getReportPagePreviewFile(owner, upload.reportId, pageId)).path, join(previewDir, `${pageId}.r90.jpg`));
    db.prepare("UPDATE report_pages SET mime_type='image/png' WHERE id=?").run(pageId);
    assert.throws(() => rotateReportPage(owner, upload.reportId, pageId, { expectedRotation: 90, rotation: 180 }),
      error => (error as { status?: number }).status === 409);
    let thumbnailCalls = 0;
    assert.equal(await processNextJob(async request => {
      thumbnailCalls += 1;
      assert.equal(request.action, 'thumbnail');
      assert.equal(request.rotation, 90);
      assert.equal(db.prepare("SELECT status FROM reports WHERE id=?").get(upload.reportId)!.status, 'needs_review');
      writeFileSync(request.outputPath!, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
      return { ok: true, width: 100, height: 200 };
    }, async () => { throw new Error('AI must not run for orientation changes'); }), true);
    assert.equal(thumbnailCalls, 1);
    assert.equal(db.prepare("SELECT status FROM reports WHERE id=?").get(upload.reportId)!.status, 'needs_review');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM processing_jobs WHERE report_id=? AND job_type='ai_extract'").get(upload.reportId)!.n, 1);
    const restored = rotateReportPage(owner, upload.reportId, pageId, { expectedRotation: 90, rotation: 0 });
    assert.equal(restored.pages.find(page => page.id === pageId)?.ocrStale, 0);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formal v18 migration backfills old OCR orientation once and preserves installed drafts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE report_pages(id TEXT PRIMARY KEY,rotation INTEGER); CREATE TABLE ocr_results(page_id TEXT); INSERT INTO report_pages VALUES('old',90); INSERT INTO ocr_results VALUES('old')");
    databaseMigrations.find(m => m.version === 18)!.up(db);
    assert.deepEqual({ ...db.prepare("SELECT rotation,ocr_rotation AS ocrRotation FROM report_pages WHERE id='old'").get() }, { rotation: 90, ocrRotation: 90 });
    db.prepare("UPDATE report_pages SET rotation=180 WHERE id='old'").run();
    databaseMigrations.find(m => m.version === 18)!.up(db);
    assert.equal(db.prepare("SELECT ocr_rotation FROM report_pages WHERE id='old'").get()!.ocr_rotation, 90);
  } finally { db.close(); }
});


test('v17 installation upgrades to v18 with a backup and preserves data on repeat startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orientation-v18-upgrade-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
  try {
    const db = getDatabase();
    db.exec("DELETE FROM schema_migrations WHERE version=18; ALTER TABLE report_pages DROP COLUMN ocr_rotation; INSERT INTO users(id,display_name) VALUES('migration-fixture','fixture')");
    closeDatabaseForTests();
    const upgraded = getDatabase();
    assert.equal(upgraded.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()!.v, 18);
    assert.ok(upgraded.prepare('PRAGMA table_info(report_pages)').all().some(c => c.name === 'ocr_rotation'));
    assert.ok(upgraded.prepare("SELECT id FROM users WHERE id='migration-fixture'").get());
    assert.ok(readdirSync(join(dir, 'backups/db')).some(name => name.includes('v17-to-v18')));
    closeDatabaseForTests();
    assert.ok(getDatabase().prepare("SELECT id FROM users WHERE id='migration-fixture'").get());
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(dir, {recursive:true, force:true});
  }
});
