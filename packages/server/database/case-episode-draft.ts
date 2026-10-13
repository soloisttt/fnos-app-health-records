import type { DatabaseSync } from "node:sqlite";

// Unnumbered draft: released migrations remain immutable.
//
// 病程模块（二开）基础结构：
//   case_episodes       病程主体（含病因、转归）—— A1 / A3 / A4
//   case_symptoms       结构化症状（名称/起病/时长/程度/部位）—— A2
//   case_medications    手动补录的用药（报告未抽取或口头医嘱）—— A2 的用药侧补充
//   case_medication_intakes 服药记录（每次实际服用的量与时间）
//   case_episode_links  归集关系（病程 ↔ 报告/诊断/用药/操作）—— A1 / A6
//   diagnosis_catalog   诊断标准名 —— A7 疾病目录
//   diagnosis_aliases   诊断别名归一化 —— A7 疾病目录
//
// 设计约束：
//   * 病程**不跨成员**（member_id 直接归属）
//   * 归集粒度取「精细」：可把某一个药单独挂到某段病程
//   * 症状/归集以**人工录入**为主，字段对齐 clinical fact 表，
//     以便将来若加 AI 抽取（source='ai'）与证据回链时无需改表。
export const caseEpisodeSchemaSql = `
CREATE TABLE IF NOT EXISTS case_episodes (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (
                status IN ('active', 'resolved', 'chronic', 'unknown')
              ),
  onset_at    TEXT,
  resolved_at TEXT,
  cause_text  TEXT,
  summary     TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS case_episodes_member_idx
  ON case_episodes(member_id, onset_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS case_symptoms (
  id                 TEXT PRIMARY KEY,
  episode_id         TEXT NOT NULL REFERENCES case_episodes(id) ON DELETE CASCADE,
  member_id          TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  onset_at           TEXT,
  duration_text      TEXT,
  severity           TEXT,
  body_part          TEXT,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'present' CHECK (
                       status IN ('present', 'improved', 'worse', 'resolved', 'unknown')
                     ),
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  report_id          TEXT REFERENCES reports(id) ON DELETE SET NULL,
  measured_value     TEXT,
  measured_unit      TEXT,
  evidence_json      TEXT NOT NULL DEFAULT '[]',
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS case_symptoms_episode_idx
  ON case_symptoms(episode_id, onset_at, id);
CREATE INDEX IF NOT EXISTS case_symptoms_report_idx
  ON case_symptoms(report_id);
CREATE INDEX IF NOT EXISTS case_symptoms_member_name_idx
  ON case_symptoms(member_id, name, is_deleted);

-- 手动补录的用药（报告里没抽到、或医生口头嘱咐的药）。
-- 与报告展开出来的用药并列展示在病程时间轴上；字段对齐 report_medications，
-- 将来若加 AI 抽取（source='ai'）与证据回链无需改表。
CREATE TABLE IF NOT EXISTS case_medications (
  id                 TEXT PRIMARY KEY,
  episode_id         TEXT NOT NULL REFERENCES case_episodes(id) ON DELETE CASCADE,
  member_id          TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  dose               TEXT,
  dose_unit          TEXT,
  frequency          TEXT,
  route              TEXT,
  start_at           TEXT,
  end_at             TEXT,
  description        TEXT,
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  report_id          TEXT REFERENCES reports(id) ON DELETE SET NULL,
  evidence_json      TEXT NOT NULL DEFAULT '[]',
  manual_fields_json TEXT NOT NULL DEFAULT '[]',
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS case_medications_episode_idx
  ON case_medications(episode_id, start_at, id);
CREATE INDEX IF NOT EXISTS case_medications_member_name_idx
  ON case_medications(member_id, name, is_deleted);

-- 服药记录：**每次实际服用**记一条（几点、吃了多少）。
-- 与 case_medications 区分：那是「医生开的药 / 自己补录的药」，
-- 这是「今天 14:00 喂了 4ml」这类流水，用来回答"这一天吃了几次退烧药"。
CREATE TABLE IF NOT EXISTS case_medication_intakes (
  id               TEXT PRIMARY KEY,
  episode_id       TEXT NOT NULL REFERENCES case_episodes(id) ON DELETE CASCADE,
  member_id        TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  medication_name  TEXT NOT NULL,
  dose             TEXT,
  dose_unit        TEXT,
  route            TEXT,
  taken_at         TEXT,
  note             TEXT,
  source_report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  is_deleted       INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS case_medication_intakes_episode_idx
  ON case_medication_intakes(episode_id, taken_at, id);
CREATE INDEX IF NOT EXISTS case_medication_intakes_member_name_idx
  ON case_medication_intakes(member_id, medication_name, is_deleted);

CREATE TABLE IF NOT EXISTS case_episode_links (
  id         TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES case_episodes(id) ON DELETE CASCADE,
  fact_type  TEXT NOT NULL CHECK (
               fact_type IN ('report', 'diagnosis', 'medication',
                             'procedure', 'vaccination', 'observation', 'section')
             ),
  fact_id    TEXT NOT NULL,
  note       TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(episode_id, fact_type, fact_id)
);
CREATE INDEX IF NOT EXISTS case_episode_links_fact_idx
  ON case_episode_links(fact_type, fact_id);

CREATE TABLE IF NOT EXISTS diagnosis_catalog (
  id             TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  category       TEXT,
  icd_code       TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS diagnosis_aliases (
  id               TEXT PRIMARY KEY,
  catalog_id       TEXT NOT NULL REFERENCES diagnosis_catalog(id) ON DELETE CASCADE,
  alias_name       TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'builtin')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS diagnosis_aliases_lookup_idx
  ON diagnosis_aliases(normalized_alias, enabled);

-- 疾病目录「隐藏」名单：只影响目录展示，不改动报告里的诊断原文与病程里的症状，可随时恢复。
-- 报告被删除或进入回收站时，目录条目本就不再聚合出来，这里的记录只会在「已隐藏」中保留，
-- 若源数据恢复，隐藏状态依然有效。
CREATE TABLE IF NOT EXISTS catalog_exclusions (
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
  fact_kind       TEXT NOT NULL CHECK (fact_kind IN ('diagnosis', 'symptom')),
  normalized_name TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (member_id, fact_kind, normalized_name)
);
CREATE INDEX IF NOT EXISTS catalog_exclusions_member_idx
  ON catalog_exclusions(member_id, fact_kind);
`;

/**
 * 给已存在的表补列。
 * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以先查 `table_info` 再决定加不加；
 * 这样老库启动时会自动补齐新列，不需要新增编号迁移。
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * `status` 的取值集合要加一个「加重（worse）」。
 * SQLite 改不了 CHECK 约束，只能重建表再搬数据。
 * 列名用 `PRAGMA table_info` 动态取（老库的列顺序与新建库不同，`SELECT *` 会错位），
 * 建完重建索引。**只在缺少 worse 时执行**，已经是新结构就直接跳过。
 */
function ensureSymptomStatusValues(db: DatabaseSync) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'case_symptoms'")
    .get() as { sql: string | null } | undefined;
  if (!row?.sql || row.sql.includes("'worse'")) return;

  const columns = (db.prepare("PRAGMA table_info(case_symptoms)").all() as Array<{ name: string }>).map(
    (item) => item.name,
  );
  const list = columns.map((name) => `"${name}"`).join(", ");

  db.exec("SAVEPOINT case_symptom_status_rebuild");
  try {
    db.exec(`
      CREATE TABLE case_symptoms_rebuilt (
        id                 TEXT PRIMARY KEY,
        episode_id         TEXT NOT NULL REFERENCES case_episodes(id) ON DELETE CASCADE,
        member_id          TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
        name               TEXT NOT NULL,
        onset_at           TEXT,
        duration_text      TEXT,
        severity           TEXT,
        body_part          TEXT,
        description        TEXT,
        status             TEXT NOT NULL DEFAULT 'present' CHECK (
                             status IN ('present', 'improved', 'worse', 'resolved', 'unknown')
                           ),
        source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
        report_id          TEXT REFERENCES reports(id) ON DELETE SET NULL,
        measured_value     TEXT,
        measured_unit      TEXT,
        evidence_json      TEXT NOT NULL DEFAULT '[]',
        manual_fields_json TEXT NOT NULL DEFAULT '[]',
        is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
        created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO case_symptoms_rebuilt (${list}) SELECT ${list} FROM case_symptoms;
      DROP TABLE case_symptoms;
      ALTER TABLE case_symptoms_rebuilt RENAME TO case_symptoms;
      CREATE INDEX IF NOT EXISTS case_symptoms_episode_idx
        ON case_symptoms(episode_id, onset_at, id);
      CREATE INDEX IF NOT EXISTS case_symptoms_report_idx
        ON case_symptoms(report_id);
      CREATE INDEX IF NOT EXISTS case_symptoms_member_name_idx
        ON case_symptoms(member_id, name, is_deleted);
      RELEASE case_symptom_status_rebuild;
    `);
  } catch (error) {
    db.exec("ROLLBACK TO case_symptom_status_rebuild; RELEASE case_symptom_status_rebuild");
    throw error;
  }
}

export function ensureCaseEpisodeDraft(db: DatabaseSync) {
  db.exec("SAVEPOINT case_episode_draft");
  try {
    db.exec(caseEpisodeSchemaSql);
    /* 老库补列：症状的「测量值 / 单位」，给体温、血压这类带数值的症状用 */
    ensureColumn(db, "case_symptoms", "measured_value", "TEXT");
    ensureColumn(db, "case_symptoms", "measured_unit", "TEXT");
    db.exec("RELEASE case_episode_draft");
  } catch (error) {
    db.exec("ROLLBACK TO case_episode_draft; RELEASE case_episode_draft");
    throw error;
  }
  /* 重建表不能放在上面的 SAVEPOINT 里：DROP TABLE 会与外层事务互相干扰 */
  ensureSymptomStatusValues(db);
}
