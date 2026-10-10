import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureCaseEpisodeDraft } from "../database/case-episode-draft.ts";

const expectedTables = [
  "case_episodes",
  "case_symptoms",
  "case_episode_links",
  "diagnosis_catalog",
  "diagnosis_aliases",
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
