import { createError } from "h3";
import { getDatabase, rollbackAfterError } from "../database/client";
import type {
  CaseEpisode,
  CaseEpisodeLink,
  CaseEpisodeLinkFactType,
  CaseEpisodeStatus,
  CaseSymptom,
  CaseSymptomStatus,
} from "../domain/health-record";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";
import { assertMemberAccess, assertMemberManage } from "./member.service";

const episodeStatuses: readonly CaseEpisodeStatus[] = ["active", "resolved", "chronic", "unknown"];
const symptomStatuses: readonly CaseSymptomStatus[] = ["present", "improved", "resolved", "unknown"];
const linkFactTypes: readonly CaseEpisodeLinkFactType[] = [
  "report",
  "diagnosis",
  "medication",
  "procedure",
  "vaccination",
  "observation",
  "section",
];

function text(value: unknown, maxLength = 500) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, maxLength) || null;
}

function requiredText(value: unknown, label: string, maxLength = 500) {
  const parsed = text(value, maxLength);
  if (!parsed) throw createError({ statusCode: 400, statusMessage: `${label}不能为空` });
  return parsed;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = String(value ?? "");
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

/** 统一的诊断名归一化规则；写入别名表与查询匹配时都必须用它。 */
export function normalizeDiagnosisName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function appendAudit(
  user: RequestUser,
  action: "create" | "update" | "delete",
  targetType: "case_episode" | "case_symptom" | "case_episode_link",
  targetId: string,
  detail: Record<string, unknown>,
) {
  getDatabase()
    .prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(createId("audit"), user.id, `${targetType}.${action}`, targetType, targetId, JSON.stringify(detail));
}

/** 读病程并用其成员归属校验权限。 */
function episodeForAccess(user: RequestUser, episodeId: string, manage: boolean) {
  const row = getDatabase()
    .prepare("SELECT id, member_id AS memberId FROM case_episodes WHERE id = ? AND deleted_at IS NULL")
    .get(episodeId) as { id: string; memberId: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "病程不存在" });
  if (manage) assertMemberManage(user, row.memberId);
  else assertMemberAccess(user, row.memberId);
  return row;
}

function symptomForAccess(user: RequestUser, symptomId: string) {
  const row = getDatabase()
    .prepare(
      `SELECT s.id, s.episode_id AS episodeId, e.member_id AS memberId
       FROM case_symptoms s JOIN case_episodes e ON e.id = s.episode_id
       WHERE s.id = ? AND s.is_deleted = 0 AND e.deleted_at IS NULL`,
    )
    .get(symptomId) as { id: string; episodeId: string; memberId: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "症状不存在" });
  assertMemberManage(user, row.memberId);
  return row;
}

function readEpisode(episodeId: string): CaseEpisode {
  const row = getDatabase()
    .prepare(
      `SELECT id, member_id AS memberId, title, status, onset_at AS onsetAt, resolved_at AS resolvedAt,
              cause_text AS causeText, summary, created_by AS createdBy, created_at AS createdAt,
              updated_at AS updatedAt
       FROM case_episodes WHERE id = ?`,
    )
    .get(episodeId) as CaseEpisode | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: "病程不存在" });
  return row;
}

function readSymptoms(episodeId: string): CaseSymptom[] {
  return getDatabase()
    .prepare(
      `SELECT id, episode_id AS episodeId, member_id AS memberId, name, onset_at AS onsetAt,
              duration_text AS durationText, severity, body_part AS bodyPart, description, status,
              source, report_id AS reportId, evidence_json AS evidenceJson,
              manual_fields_json AS manualFieldsJson
       FROM case_symptoms
       WHERE episode_id = ? AND is_deleted = 0
       ORDER BY COALESCE(onset_at, created_at), id`,
    )
    .all(episodeId)
    .map((row) => {
      const item = row as Record<string, string | null>;
      return {
        id: item.id as string,
        episodeId: item.episodeId as string,
        memberId: item.memberId as string,
        name: item.name as string,
        onsetAt: item.onsetAt,
        durationText: item.durationText,
        severity: item.severity,
        bodyPart: item.bodyPart,
        description: item.description,
        status: item.status as CaseSymptomStatus,
        source: item.source as "manual" | "ai",
        reportId: item.reportId,
        evidence: JSON.parse(item.evidenceJson || "[]"),
        manualFields: JSON.parse(item.manualFieldsJson || "[]"),
      } satisfies CaseSymptom;
    });
}

function readLinks(episodeId: string): CaseEpisodeLink[] {
  return getDatabase()
    .prepare(
      `SELECT id, episode_id AS episodeId, fact_type AS factType, fact_id AS factId, note,
              created_by AS createdBy, created_at AS createdAt
       FROM case_episode_links WHERE episode_id = ? ORDER BY created_at, id`,
    )
    .all(episodeId) as CaseEpisodeLink[];
}

export type EpisodeLinkedFact = {
  linkId: string;
  factType: CaseEpisodeLinkFactType;
  factId: string;
  label: string;
  detail: string | null;
  reportId: string | null;
  reportTitle: string | null;
  hospitalName: string | null;
  occurredAt: string | null;
  /** 事实已不存在（如报告被彻底删除），界面据此提示并允许清理挂链。 */
  missing: boolean;
};

type FactHit = { label: string; detail: string | null; reportId: string | null; occurredAt: string | null };

/** 把归集关系解析成可以直接展示的文字（含来源报告信息）。 */
function resolveLinkedFacts(episodeId: string): EpisodeLinkedFact[] {
  const db = getDatabase();
  const links = readLinks(episodeId);
  const hits = new Map<string, FactHit>();
  const reportIds = new Set<string>();

  const record = (link: CaseEpisodeLink, hit: FactHit | undefined) => {
    if (!hit) return;
    hits.set(`${link.factType}:${link.factId}`, hit);
    if (hit.reportId) reportIds.add(hit.reportId);
  };

  for (const link of links) {
    if (link.factType === "report") {
      const row = db
        .prepare("SELECT id, title, report_issued_at AS issuedAt FROM reports WHERE id = ?")
        .get(link.factId) as { id: string; title: string; issuedAt: string | null } | undefined;
      record(link, row && { label: row.title, detail: "报告", reportId: row.id, occurredAt: row.issuedAt });
    } else if (link.factType === "diagnosis") {
      const row = db
        .prepare(
          "SELECT report_id AS reportId, diagnosis_text AS label FROM report_diagnoses WHERE id = ? AND is_deleted = 0",
        )
        .get(link.factId) as { reportId: string; label: string } | undefined;
      record(link, row && { label: row.label, detail: "诊断", reportId: row.reportId, occurredAt: null });
    } else if (link.factType === "medication") {
      const row = db
        .prepare(
          `SELECT report_id AS reportId, medication_name AS label, dose, dose_unit AS doseUnit,
                  route, frequency, quantity, quantity_unit AS quantityUnit
           FROM report_medications WHERE id = ? AND is_deleted = 0`,
        )
        .get(link.factId) as
        | {
            reportId: string;
            label: string;
            dose: string | null;
            doseUnit: string | null;
            route: string | null;
            frequency: string | null;
            quantity: string | null;
            quantityUnit: string | null;
          }
        | undefined;
      record(
        link,
        row && {
          label: row.label,
          detail: [row.dose && row.doseUnit ? `${row.dose}${row.doseUnit}` : row.dose, row.route, row.frequency]
            .filter(Boolean)
            .join(" ") || "用药",
          reportId: row.reportId,
          occurredAt: null,
        },
      );
    } else if (link.factType === "procedure") {
      const row = db
        .prepare(
          "SELECT report_id AS reportId, procedure_name AS label, performed_at AS performedAt FROM report_procedures WHERE id = ? AND is_deleted = 0",
        )
        .get(link.factId) as { reportId: string; label: string; performedAt: string | null } | undefined;
      record(link, row && { label: row.label, detail: "操作", reportId: row.reportId, occurredAt: row.performedAt });
    } else if (link.factType === "vaccination") {
      const row = db
        .prepare(
          "SELECT report_id AS reportId, vaccine_name AS label, administered_at AS administeredAt FROM vaccination_records WHERE id = ? AND is_deleted = 0",
        )
        .get(link.factId) as { reportId: string; label: string; administeredAt: string | null } | undefined;
      record(link, row && { label: row.label, detail: "疫苗", reportId: row.reportId, occurredAt: row.administeredAt });
    } else if (link.factType === "observation") {
      const row = db
        .prepare(
          "SELECT report_id AS reportId, item_name AS label, result_text AS resultText, unit FROM observations WHERE id = ?",
        )
        .get(link.factId) as
        | { reportId: string; label: string; resultText: string; unit: string | null }
        | undefined;
      record(
        link,
        row && {
          label: row.label,
          detail: ["指标", `${row.resultText}${row.unit ?? ""}`].filter(Boolean).join(" "),
          reportId: row.reportId,
          occurredAt: null,
        },
      );
    } else if (link.factType === "section") {
      const row = db
        .prepare(
          "SELECT report_id AS reportId, title AS label, content FROM report_structured_sections WHERE id = ? AND is_deleted = 0",
        )
        .get(link.factId) as { reportId: string; label: string; content: string | null } | undefined;
      record(
        link,
        row && {
          label: row.label,
          detail: row.content ? row.content.slice(0, 120) : "报告章节",
          reportId: row.reportId,
          occurredAt: null,
        },
      );
    }
  }

  const reportInfo = new Map<string, { title: string; hospitalName: string | null; issuedAt: string | null }>();
  if (reportIds.size) {
    const ids = [...reportIds];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, title, hospital_name_raw AS hospitalName,
                COALESCE(report_issued_at, created_at) AS issuedAt
         FROM reports WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: string; title: string; hospitalName: string | null; issuedAt: string | null }>;
    for (const row of rows) reportInfo.set(row.id, row);
  }

  return links.map((link) => {
    const hit = hits.get(`${link.factType}:${link.factId}`);
    const info = hit?.reportId ? reportInfo.get(hit.reportId) : undefined;
    return {
      linkId: link.id,
      factType: link.factType,
      factId: link.factId,
      label: hit?.label ?? "内容已不存在",
      detail: hit?.detail ?? null,
      reportId: hit?.reportId ?? null,
      reportTitle: info?.title ?? null,
      hospitalName: info?.hospitalName ?? null,
      occurredAt: hit?.occurredAt ?? info?.issuedAt ?? null,
      missing: !hit,
    };
  });
}

// ---------------------------------------------------------------- 病程

export function createEpisode(
  user: RequestUser,
  memberId: string,
  input: Record<string, unknown>,
) {
  assertMemberManage(user, memberId);
  const id = createId("episode");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO case_episodes (id, member_id, title, status, onset_at, resolved_at, cause_text, summary, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      memberId,
      requiredText(input.title, "病程标题", 200),
      enumValue(input.status, episodeStatuses, "active"),
      text(input.onsetAt, 32),
      text(input.resolvedAt, 32),
      text(input.causeText, 1000),
      text(input.summary, 4000),
      user.id,
    );
    appendAudit(user, "create", "case_episode", id, { memberId });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return getEpisode(user, id);
}

export function listEpisodes(user: RequestUser, memberId: string) {
  assertMemberAccess(user, memberId);
  const rows = getDatabase()
    .prepare(
      `SELECT e.id, e.member_id AS memberId, e.title, e.status, e.onset_at AS onsetAt,
              e.resolved_at AS resolvedAt, e.cause_text AS causeText, e.summary,
              e.created_by AS createdBy, e.created_at AS createdAt, e.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM case_symptoms s WHERE s.episode_id = e.id AND s.is_deleted = 0) AS symptomCount,
              (SELECT COUNT(*) FROM case_episode_links l WHERE l.episode_id = e.id) AS linkCount
       FROM case_episodes e
       WHERE e.member_id = ? AND e.deleted_at IS NULL
       ORDER BY COALESCE(e.onset_at, e.created_at) DESC, e.id DESC`,
    )
    .all(memberId);
  return rows;
}

export function getEpisode(user: RequestUser, episodeId: string) {
  episodeForAccess(user, episodeId, false);
  return {
    episode: readEpisode(episodeId),
    symptoms: readSymptoms(episodeId),
    links: readLinks(episodeId),
    linkedFacts: resolveLinkedFacts(episodeId),
  };
}

export function updateEpisode(
  user: RequestUser,
  episodeId: string,
  input: Record<string, unknown>,
) {
  episodeForAccess(user, episodeId, true);
  const fields = new Map<string, string | null>();
  const putText = (key: string, column: string, maxLength?: number) => {
    if (key in input) fields.set(column, text(input[key], maxLength));
  };
  const putEnum = (key: string, column: string, allowed: readonly CaseEpisodeStatus[], fallback: CaseEpisodeStatus) => {
    if (key in input) fields.set(column, enumValue(input[key], allowed, fallback));
  };
  if ("title" in input) fields.set("title", requiredText(input.title, "病程标题", 200));
  putEnum("status", "status", episodeStatuses, "active");
  putText("onsetAt", "onset_at", 32);
  putText("resolvedAt", "resolved_at", 32);
  putText("causeText", "cause_text", 1000);
  putText("summary", "summary", 4000);
  if (!fields.size) throw createError({ statusCode: 400, statusMessage: "没有需要更新的字段" });

  const columns = [...fields.keys()];
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE case_episodes SET ${columns.map((column) => `${column} = ?`).join(", ")},
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(...fields.values(), episodeId);
    appendAudit(user, "update", "case_episode", episodeId, { fields: columns });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return getEpisode(user, episodeId);
}

export function deleteEpisode(user: RequestUser, episodeId: string) {
  episodeForAccess(user, episodeId, true);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE case_episodes SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(episodeId);
    appendAudit(user, "delete", "case_episode", episodeId, {});
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return { id: episodeId };
}

// ---------------------------------------------------------------- 症状

export function createSymptom(
  user: RequestUser,
  episodeId: string,
  input: Record<string, unknown>,
) {
  const episode = episodeForAccess(user, episodeId, true);
  const id = createId("symptom");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO case_symptoms
        (id, episode_id, member_id, name, onset_at, duration_text, severity, body_part, description, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    ).run(
      id,
      episodeId,
      episode.memberId,
      requiredText(input.name, "症状名称", 200),
      text(input.onsetAt, 32),
      text(input.durationText, 100),
      text(input.severity, 100),
      text(input.bodyPart, 200),
      text(input.description, 2000),
      enumValue(input.status, symptomStatuses, "present"),
    );
    db.prepare("UPDATE case_episodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(episodeId);
    appendAudit(user, "create", "case_symptom", id, { episodeId });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return getEpisode(user, episodeId);
}

export function updateSymptom(
  user: RequestUser,
  symptomId: string,
  input: Record<string, unknown>,
) {
  const symptom = symptomForAccess(user, symptomId);
  const fields = new Map<string, string | null>();
  if ("name" in input) fields.set("name", requiredText(input.name, "症状名称", 200));
  if ("onsetAt" in input) fields.set("onset_at", text(input.onsetAt, 32));
  if ("durationText" in input) fields.set("duration_text", text(input.durationText, 100));
  if ("severity" in input) fields.set("severity", text(input.severity, 100));
  if ("bodyPart" in input) fields.set("body_part", text(input.bodyPart, 200));
  if ("description" in input) fields.set("description", text(input.description, 2000));
  if ("status" in input) fields.set("status", enumValue(input.status, symptomStatuses, "present"));
  if (!fields.size) throw createError({ statusCode: 400, statusMessage: "没有需要更新的字段" });

  const columns = [...fields.keys()];
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE case_symptoms SET ${columns.map((column) => `${column} = ?`).join(", ")},
       source = 'manual', manual_fields_json = '["*"]', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(...fields.values(), symptomId);
    appendAudit(user, "update", "case_symptom", symptomId, { fields: columns });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return getEpisode(user, symptom.episodeId);
}

export function deleteSymptom(user: RequestUser, symptomId: string) {
  const symptom = symptomForAccess(user, symptomId);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE case_symptoms SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(symptomId);
    appendAudit(user, "delete", "case_symptom", symptomId, { episodeId: symptom.episodeId });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return getEpisode(user, symptom.episodeId);
}

// ---------------------------------------------------------------- 归集

export function linkEpisodeFact(
  user: RequestUser,
  episodeId: string,
  input: Record<string, unknown>,
) {
  episodeForAccess(user, episodeId, true);
  const factType = enumValue(input.factType, linkFactTypes, "report");
  if (!(linkFactTypes as readonly string[]).includes(String(input.factType ?? ""))) {
    throw createError({ statusCode: 400, statusMessage: "归集类型无效" });
  }
  const factId = requiredText(input.factId, "归集对象", 200);
  const id = createId("episodeLink");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO case_episode_links (id, episode_id, fact_type, fact_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(episode_id, fact_type, fact_id) DO UPDATE SET note = excluded.note`,
    ).run(id, episodeId, factType, factId, text(input.note, 500), user.id);
    appendAudit(user, "create", "case_episode_link", id, { episodeId, factType, factId });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return getEpisode(user, episodeId);
}

export function unlinkEpisodeFact(
  user: RequestUser,
  episodeId: string,
  input: Record<string, unknown>,
) {
  episodeForAccess(user, episodeId, true);
  const factType = String(input.factType ?? "");
  const factId = requiredText(input.factId, "归集对象", 200);
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db
      .prepare("DELETE FROM case_episode_links WHERE episode_id = ? AND fact_type = ? AND fact_id = ?")
      .run(episodeId, factType, factId);
    if (Number(result.changes) < 1) {
      throw createError({ statusCode: 404, statusMessage: "未找到该归集关系" });
    }
    appendAudit(user, "delete", "case_episode_link", `${factType}:${factId}`, { episodeId });
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterError(db);
    throw error;
  }
  return getEpisode(user, episodeId);
}

// ---------------------------------------------------------------- A7 疾病目录

export type DiseaseCatalogEntry = {
  kind: "diagnosis" | "symptom";
  name: string;
  count: number;
  lastAt: string | null;
};

/**
 * 疾病目录：按成员聚合诊断与症状。
 * 诊断名经 diagnosis_aliases 归一化后合并（未命中别名的按原文保留）。
 */
export function listDiseaseCatalog(user: RequestUser, memberId: string): DiseaseCatalogEntry[] {
  assertMemberAccess(user, memberId);
  const db = getDatabase();

  const aliasRows = db
    .prepare(
      `SELECT a.normalized_alias AS normalizedAlias, c.canonical_name AS canonicalName
       FROM diagnosis_aliases a JOIN diagnosis_catalog c ON c.id = a.catalog_id
       WHERE a.enabled = 1`,
    )
    .all() as Array<{ normalizedAlias: string; canonicalName: string }>;
  const aliasMap = new Map(aliasRows.map((row) => [row.normalizedAlias, row.canonicalName]));

  const diagnosisRows = db
    .prepare(
      `SELECT d.diagnosis_text AS diagnosisText, r.report_issued_at AS reportIssuedAt,
              r.created_at AS createdAt
       FROM report_diagnoses d JOIN reports r ON r.id = d.report_id
       WHERE r.member_id = ? AND r.status <> 'trashed' AND d.is_deleted = 0`,
    )
    .all(memberId) as Array<{ diagnosisText: string; reportIssuedAt: string | null; createdAt: string }>;

  const symptomRows = db
    .prepare(
      `SELECT name, onset_at AS onsetAt, created_at AS createdAt
       FROM case_symptoms
       WHERE member_id = ? AND is_deleted = 0`,
    )
    .all(memberId) as Array<{ name: string; onsetAt: string | null; createdAt: string }>;

  const merged = new Map<string, DiseaseCatalogEntry>();
  const bump = (kind: "diagnosis" | "symptom", name: string, at: string | null) => {
    const key = `${kind}:${name}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { kind, name, count: 1, lastAt: at });
      return;
    }
    existing.count += 1;
    if (at && (!existing.lastAt || at > existing.lastAt)) existing.lastAt = at;
  };

  for (const row of diagnosisRows) {
    const canonical = aliasMap.get(normalizeDiagnosisName(row.diagnosisText)) ?? row.diagnosisText.trim();
    bump("diagnosis", canonical, row.reportIssuedAt ?? row.createdAt);
  }
  for (const row of symptomRows) {
    bump("symptom", row.name.trim(), row.onsetAt ?? row.createdAt);
  }

  return [...merged.values()].sort((left, right) => {
    const leftAt = left.lastAt ?? "";
    const rightAt = right.lastAt ?? "";
    if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

// ------------------------------------------------- 疾病目录下钻：历史就诊记录

export type DiseaseVisitMedication = {
  name: string;
  dose: string | null;
  frequency: string | null;
  route: string | null;
};

export type DiseaseVisit = {
  reportId: string;
  title: string;
  hospitalName: string | null;
  departmentName: string | null;
  issuedAt: string | null;
  diagnoses: string[];
  medications: DiseaseVisitMedication[];
};

/** 加载诊断别名字典（归一化写法的映射）。 */
function loadDiagnosisAliasMap() {
  const rows = getDatabase()
    .prepare(
      `SELECT a.normalized_alias AS normalizedAlias, c.canonical_name AS canonicalName
       FROM diagnosis_aliases a JOIN diagnosis_catalog c ON c.id = a.catalog_id
       WHERE a.enabled = 1`,
    )
    .all() as Array<{ normalizedAlias: string; canonicalName: string }>;
  return new Map(rows.map((row) => [row.normalizedAlias, row.canonicalName]));
}

function canonicalDiagnosisText(value: string, aliasMap: Map<string, string>) {
  return aliasMap.get(normalizeDiagnosisName(value)) ?? value.trim();
}

/** 沿病程的归集关系反解出报告 id；已挂到病程上的报告、诊断、用药、操作、疫苗都能回溯到那次就诊。 */
function collectReportIdsByEpisode(
  memberId: string,
  match: (episode: { id: string; title: string; causeText: string | null }) => boolean,
) {
  const db = getDatabase();
  const episodes = db
    .prepare(
      "SELECT id, title, cause_text AS causeText FROM case_episodes WHERE member_id = ? AND deleted_at IS NULL",
    )
    .all(memberId) as Array<{ id: string; title: string; causeText: string | null }>;
  const matched = episodes.filter(match).map((episode) => episode.id);
  const ids = new Set<string>();
  if (!matched.length) return ids;

  const factTables: Record<string, string> = {
    diagnosis: "report_diagnoses",
    medication: "report_medications",
    procedure: "report_procedures",
    vaccination: "vaccination_records",
    observation: "observations",
    section: "report_structured_sections",
  };
  const placeholders = matched.map(() => "?").join(", ");
  const links = db
    .prepare(
      `SELECT fact_type AS factType, fact_id AS factId FROM case_episode_links
       WHERE episode_id IN (${placeholders})`,
    )
    .all(...matched) as Array<{ factType: string; factId: string }>;

  for (const link of links) {
    if (link.factType === "report") {
      ids.add(link.factId);
      continue;
    }
    const table = factTables[link.factType];
    if (!table) continue;
    const row = db
      .prepare(`SELECT report_id AS reportId FROM ${table} WHERE id = ?`)
      .get(link.factId) as { reportId: string } | undefined;
    if (row?.reportId) ids.add(row.reportId);
  }
  return ids;
}

/** 按症状名条件收集报告 id（先定位病程，再沿归集关系反解）。 */
function collectReportIdsBySymptom(memberId: string, match: (name: string) => boolean) {
  const db = getDatabase();
  const symptoms = db
    .prepare(
      "SELECT DISTINCT name FROM case_symptoms WHERE member_id = ? AND is_deleted = 0",
    )
    .all(memberId) as Array<{ name: string }>;
  const matched = symptoms.filter((row) => match(row.name)).map((row) => row.name);
  if (!matched.length) return new Set<string>();

  const placeholders = matched.map(() => "?").join(", ");
  const episodeIds = db
    .prepare(
      `SELECT DISTINCT episode_id AS episodeId FROM case_symptoms
       WHERE member_id = ? AND is_deleted = 0 AND name IN (${placeholders})`,
    )
    .all(memberId, ...matched) as Array<{ episodeId: string }>;
  const ids = new Set<string>();
  for (const { episodeId } of episodeIds) {
    for (const id of collectReportIdsByEpisode(memberId, (episode) => episode.id === episodeId)) {
      ids.add(id);
    }
  }
  return ids;
}

/** 按诊断名条件收集报告 id（经别名归一后再比较）。 */
function collectReportIdsByDiagnosis(memberId: string, match: (canonical: string) => boolean) {
  const db = getDatabase();
  const aliasMap = loadDiagnosisAliasMap();
  const rows = db
    .prepare(
      `SELECT d.report_id AS reportId, d.diagnosis_text AS diagnosisText
       FROM report_diagnoses d JOIN reports r ON r.id = d.report_id
       WHERE r.member_id = ? AND r.status <> 'trashed' AND d.is_deleted = 0`,
    )
    .all(memberId) as Array<{ reportId: string; diagnosisText: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    if (match(canonicalDiagnosisText(row.diagnosisText, aliasMap))) ids.add(row.reportId);
  }
  return ids;
}

/** 按用药名条件收集报告 id。 */
function collectReportIdsByMedication(memberId: string, match: (name: string) => boolean) {
  const rows = getDatabase()
    .prepare(
      `SELECT m.report_id AS reportId, m.medication_name AS name
       FROM report_medications m JOIN reports r ON r.id = m.report_id
       WHERE r.member_id = ? AND r.status <> 'trashed' AND m.is_deleted = 0`,
    )
    .all(memberId) as Array<{ reportId: string; name: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    if (match(row.name)) ids.add(row.reportId);
  }
  return ids;
}

/** 把报告 id 集合装配成可展示的就诊记录（时间 / 医院 / 诊断 / 用药）。 */
function buildVisits(reportIds: Iterable<string>): DiseaseVisit[] {
  const ids = [...new Set(reportIds)];
  if (!ids.length) return [];
  const db = getDatabase();
  const placeholders = ids.map(() => "?").join(", ");

  const reportRows = db
    .prepare(
      `SELECT id AS reportId, title, hospital_name_raw AS hospitalName,
              COALESCE(reporting_department, visit_department, ordering_department) AS departmentName,
              COALESCE(report_issued_at, created_at) AS issuedAt
       FROM reports WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<Omit<DiseaseVisit, "diagnoses" | "medications">>;

  const diagnosisRows = db
    .prepare(
      `SELECT report_id AS reportId, diagnosis_text AS diagnosisText
       FROM report_diagnoses WHERE report_id IN (${placeholders}) AND is_deleted = 0`,
    )
    .all(...ids) as Array<{ reportId: string; diagnosisText: string }>;

  const medicationRows = db
    .prepare(
      `SELECT report_id AS reportId, medication_name AS name, dose, frequency, route
       FROM report_medications WHERE report_id IN (${placeholders}) AND is_deleted = 0`,
    )
    .all(...ids) as Array<{ reportId: string } & DiseaseVisitMedication>;

  const byReport = new Map<string, DiseaseVisit>();
  for (const row of reportRows) byReport.set(row.reportId, { ...row, diagnoses: [], medications: [] });
  for (const row of diagnosisRows) byReport.get(row.reportId)?.diagnoses.push(row.diagnosisText);
  for (const row of medicationRows) {
    byReport.get(row.reportId)?.medications.push({
      name: row.name,
      dose: row.dose,
      frequency: row.frequency,
      route: row.route,
    });
  }

  return [...byReport.values()].sort((left, right) => {
    const leftAt = left.issuedAt ?? "";
    const rightAt = right.issuedAt ?? "";
    if (leftAt === rightAt) return left.reportId < right.reportId ? -1 : 1;
    return leftAt < rightAt ? 1 : -1;
  });
}

/**
 * 按疾病目录条目下钻，返回历史就诊记录（时间 / 医院 / 诊断 / 用药）。
 *
 * kind='diagnosis'：取诊断名（经别名归一后）等于 name 的报告。
 * kind='symptom'  ：取含该症状的病程，再沿归集关系反解出相关报告。
 *   —— 这正是「精细归集」的价值：即使只挂了一个药，也能定位到它所在的那次就诊。
 */
export function listDiseaseRecords(
  user: RequestUser,
  memberId: string,
  kind: "diagnosis" | "symptom",
  name: string,
): DiseaseVisit[] {
  assertMemberAccess(user, memberId);
  const ids =
    kind === "diagnosis"
      ? collectReportIdsByDiagnosis(memberId, (canonical) => canonical === name)
      : collectReportIdsBySymptom(memberId, (symptomName) => symptomName === name);
  return buildVisits(ids);
}

/**
 * A6 综合检索：输入一个关键词，跨「症状 / 病因 / 病程标题 / 诊断 / 用药」一起匹配，
 * 返回符合条件的历次就诊（什么时候、在哪家医院、开了什么药）。
 */
export function searchVisits(user: RequestUser, memberId: string, keyword: string): DiseaseVisit[] {
  assertMemberAccess(user, memberId);
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [];
  const hit = (value: string | null | undefined) => Boolean(value && value.toLowerCase().includes(needle));

  const ids = new Set<string>();
  for (const id of collectReportIdsByDiagnosis(memberId, hit)) ids.add(id);
  for (const id of collectReportIdsBySymptom(memberId, hit)) ids.add(id);
  for (const id of collectReportIdsByMedication(memberId, hit)) ids.add(id);
  for (const id of collectReportIdsByEpisode(memberId, (episode) => hit(episode.title) || hit(episode.causeText))) {
    ids.add(id);
  }
  return buildVisits(ids);
}
