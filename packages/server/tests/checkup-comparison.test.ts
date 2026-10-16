import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import { compareCheckupReport } from "../services/checkup-comparison.service.ts";

function setup(label: string) {
  const storageDir = mkdtempSync(join(tmpdir(), `health-records-${label}-`));
  process.env.STORAGE_DIR = storageDir;
  const owner: RequestUser = {
    id: "owner",
    displayName: "管理员",
    provider: "development",
    authenticated: true,
    isGatewayAdmin: true,
  };
  const db = getDatabase();
  db.exec(`
    INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
    INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '宝宝', 'owner');
    INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member', 'owner', 'manager', 'owner');
  `);
  return { storageDir, owner, db };
}

function teardown(storageDir: string) {
  closeDatabaseForTests();
  rmSync(storageDir, { recursive: true, force: true });
}

test("体检对比：逐项给出上次的值、方向与好转 / 变差", () => {
  const { storageDir, owner, db } = setup("checkup-compare");
  try {
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
        VALUES ('old', 'member', 'owner', 'checkup', '入园体检', 'ready', '2026-03-08'),
               ('new', 'member', 'owner', 'checkup', '年度体检', 'ready', '2026-09-20');
      INSERT INTO observations (
        id, report_id, item_name, normalized_name, result_text, numeric_value, unit,
        reference_low, reference_high, abnormal_flag
      ) VALUES
        ('o1', 'old', '血红蛋白', '血红蛋白', '124', 124, 'g/L', 110, 160, 'normal'),
        ('o2', 'old', '白细胞',   '白细胞',   '7.2', 7.2, '10^9/L', 4, 10, 'normal'),
        ('o3', 'new', '血红蛋白', '血红蛋白', '118', 118, 'g/L', 110, 160, 'normal'),
        ('o4', 'new', '白细胞',   '白细胞',   '12.5', 12.5, '10^9/L', 4, 10, 'high'),
        ('o5', 'new', '血小板',   '血小板',   '210', 210, '10^9/L', 100, 300, 'normal');
    `);

    const result = compareCheckupReport(owner, "new");
    assert.equal(result.previous?.id, "old", "上一份找的是同一成员早于它的体检");
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.worse, 1);
    assert.deepEqual(result.summary.worseNames, ["白细胞"]);

    const at = (name: string) => result.items.find((item) => item.name === name)!;
    /* 两边都正常、数值只是浮动：算「没变」，不该吓人 */
    assert.equal(at("血红蛋白").trend, "flat");
    assert.equal(at("血红蛋白").direction, "down");
    assert.equal(at("血红蛋白").previous, "124");
    assert.equal(at("血红蛋白").abnormal, false);
    /* 上次正常、这次超出参考范围 → 变差 */
    assert.equal(at("白细胞").trend, "worse");
    assert.equal(at("白细胞").direction, "up");
    assert.equal(at("白细胞").abnormal, true);
    assert.equal(at("白细胞").previousAbnormal, false);
    /* 上次没有这一项 → 新增，没有上次的值可显示 */
    assert.equal(at("血小板").trend, "new");
    assert.equal(at("血小板").previous, null);
    assert.equal(at("血小板").direction, "new");
  } finally {
    teardown(storageDir);
  }
});

test("体检对比：上一份只认体检报告，普通门诊报告不拿来比", () => {
  const { storageDir, owner, db } = setup("checkup-first");
  try {
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
        VALUES ('out1', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '2026-06-01'),
               ('new', 'member', 'owner', 'checkup', '年度体检', 'ready', '2026-09-20');
      INSERT INTO observations (id, report_id, item_name, result_text, numeric_value, unit, abnormal_flag)
        VALUES ('o5', 'new', '血红蛋白', '118', 118, 'g/L', 'normal');
    `);

    const result = compareCheckupReport(owner, "new");
    assert.equal(result.previous, null, "前面那份是门诊，不能当上一次体检");
    assert.equal(result.items[0]!.trend, "new");
    assert.equal(result.items[0]!.previous, null);
  } finally {
    teardown(storageDir);
  }
});
