import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureCaseEpisodeDraft } from "../database/case-episode-draft.ts";

const expectedTables = [
  "case_episodes",
  "case_symptoms",
  "case_medications",
  "case_medication_intakes",
  "case_episode_links",
  "diagnosis_catalog",
  "diagnosis_aliases",
  "catalog_exclusions",
];

function tableNames(db: DatabaseSync) {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

test("病程草案创建全部表，且重复执行幂等", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureCaseEpisodeDraft(db);
    ensureCaseEpisodeDraft(db);
    const names = tableNames(db);
    for (const expected of expectedTables) {
      assert.ok(names.has(expected), `缺少表 ${expected}`);
    }
  } finally {
    db.close();
  }
});

test("病程草案的索引已建立", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureCaseEpisodeDraft(db);
    const indexes = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const expected of [
      "case_episodes_member_idx",
      "case_symptoms_episode_idx",
      "case_symptoms_member_name_idx",
      "case_medications_episode_idx",
      "case_medications_member_name_idx",
      "case_medication_intakes_episode_idx",
      "case_episode_links_fact_idx",
      "diagnosis_aliases_lookup_idx",
    ]) {
      assert.ok(indexes.has(expected), `缺少索引 ${expected}`);
    }
  } finally {
    db.close();
  }
});

test("病程状态与症状状态的取值受约束", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureCaseEpisodeDraft(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO case_episodes(id, member_id, title, created_by) VALUES (?, ?, ?, ?)",
    ).run("ep1", "m1", "测试病程", "u1");
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO case_episodes(id, member_id, title, status, created_by) VALUES (?, ?, ?, ?, ?)",
        )
        .run("ep2", "m1", "非法状态", "bogus", "u1"),
    );
    db.prepare(
      "INSERT INTO case_symptoms(id, episode_id, member_id, name) VALUES (?, ?, ?, ?)",
    ).run("sym1", "ep1", "m1", "咳嗽");
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO case_symptoms(id, episode_id, member_id, name, status) VALUES (?, ?, ?, ?, ?)",
        )
        .run("sym2", "ep1", "m1", "发烧", "bogus"),
    );
  } finally {
    db.close();
  }
});

test("归集关系禁止重复挂同一条事实", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureCaseEpisodeDraft(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO case_episodes(id, member_id, title, created_by) VALUES (?, ?, ?, ?)",
    ).run("ep1", "m1", "测试病程", "u1");
    const insert = db.prepare(
      "INSERT INTO case_episode_links(id, episode_id, fact_type, fact_id, created_by) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("l1", "ep1", "medication", "med1", "u1");
    assert.throws(() => insert.run("l2", "ep1", "medication", "med1", "u1"));
  } finally {
    db.close();
  }
});

test("老库的症状表缺「加重」时自动重建，且旧数据不丢", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    /* 复刻上一版结构：CHECK 里没有 worse，且 measured_* 是靠 ALTER 追加到**末尾**的
       （列顺序与新建库不同，所以重建必须按列名复制而不是 SELECT *） */
    db.exec(`
      CREATE TABLE case_symptoms (
        id                 TEXT PRIMARY KEY,
        episode_id         TEXT NOT NULL,
        member_id          TEXT NOT NULL,
        name               TEXT NOT NULL,
        onset_at           TEXT,
        duration_text      TEXT,
        severity           TEXT,
        body_part          TEXT,
        description        TEXT,
        status             TEXT NOT NULL DEFAULT 'present' CHECK (
                             status IN ('present', 'improved', 'resolved', 'unknown')
                           ),
        source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
        report_id          TEXT,
        evidence_json      TEXT NOT NULL DEFAULT '[]',
        manual_fields_json TEXT NOT NULL DEFAULT '[]',
        is_deleted         INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        measured_value     TEXT,
        measured_unit      TEXT
      );
      INSERT INTO case_symptoms (id, episode_id, member_id, name, status, measured_value, measured_unit)
        VALUES ('sym1', 'ep1', 'm1', '体温', 'present', '37.5', '℃');
    `);

    ensureCaseEpisodeDraft(db);
    ensureCaseEpisodeDraft(db);

    const row = db
      .prepare(
        "SELECT name, status, measured_value AS measuredValue, measured_unit AS measuredUnit FROM case_symptoms WHERE id = 'sym1'",
      )
      .get() as { name: string; status: string; measuredValue: string; measuredUnit: string };
    assert.equal(row.name, "体温");
    assert.equal(row.status, "present");
    assert.equal(row.measuredValue, "37.5", "重建后原有的测量值不能丢");
    assert.equal(row.measuredUnit, "℃");

    /* 新结构接受「加重」，仍然拒绝非法值，索引也回来了 */
    db.prepare(
      "INSERT INTO case_symptoms(id, episode_id, member_id, name, status) VALUES (?, ?, ?, ?, ?)",
    ).run("sym2", "ep1", "m1", "咳嗽", "worse");
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO case_symptoms(id, episode_id, member_id, name, status) VALUES (?, ?, ?, ?, ?)",
        )
        .run("sym3", "ep1", "m1", "发烧", "bogus"),
    );
    const indexes = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
      ).map((item) => item.name),
    );
    for (const expected of ["case_symptoms_episode_idx", "case_symptoms_member_name_idx"]) {
      assert.ok(indexes.has(expected), `重建后缺少索引 ${expected}`);
    }
  } finally {
    db.close();
  }
});
