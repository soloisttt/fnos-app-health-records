import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { assertMemberAccess } from "./member.service";

/**
 * 体检报告「与上次对比」。
 *
 * 为什么只做体检：体检是**同一套项目反复做**（血常规、肝功能…），单看一次没有意义，
 * 价值全在"这次和上次比变了没有"。看病报告项目各不相同，做对比反而噪音大。
 *
 * 纯只读：找同一成员**上一份**体检报告（按报告日期，日期相同用创建时间兜底），
 * 按归一化后的指标名配对，逐项给出方向与好转 / 变差。
 */

export type CheckupComparisonItem = {
  name: string;
  unit: string | null;
  /** 这次的读数（原样保留，可能是 "<0.5" 这种文字） */
  current: string;
  /** 上次的读数；上次没这一项时为 null */
  previous: string | null;
  /** 数值方向；非数值项为 null */
  direction: "up" | "down" | "same" | "new" | null;
  /** 这次是否超出参考范围 */
  abnormal: boolean;
  /** 上次是否超出参考范围 */
  previousAbnormal: boolean;
  /** 相对上次：好转 / 变差 / 没变 / 新增项 */
  trend: "better" | "worse" | "flat" | "new";
};

export type CheckupComparison = {
  report: { id: string; title: string; issuedAt: string | null };
  previous: { id: string; title: string; issuedAt: string | null } | null;
  summary: { total: number; better: number; worse: number; worseNames: string[] };
  items: CheckupComparisonItem[];
};

type ObservationRow = {
  name: string;
  normalizedName: string | null;
  resultText: string;
  numericValue: number | null;
  unit: string | null;
  abnormalFlag: string | null;
};

type ReportHead = { id: string; title: string; issuedAt: string | null };

/** 归一化后的指标名：优先用库里算好的，没有就退化成原名的去空格小写 */
function itemKey(row: ObservationRow) {
  const raw = row.normalizedName || row.name || "";
  return raw.replace(/\s+/g, "").toLowerCase();
}

function isAbnormal(flag: string | null | undefined) {
  return flag === "high" || flag === "low" || flag === "abnormal";
}

export function compareCheckupReport(user: RequestUser, reportId: string): CheckupComparison {
  const db = getDatabase();
  const head = db
    .prepare(
      `SELECT id, member_id AS memberId, title, report_issued_at AS issuedAt
       FROM reports WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(reportId) as (ReportHead & { memberId: string }) | undefined;
  if (!head) throw new Error("报告不存在");
  assertMemberAccess(user, head.memberId);

  const readObservations = (id: string) =>
    db
      .prepare(
        `SELECT item_name AS name, normalized_name AS normalizedName, result_text AS resultText,
                numeric_value AS numericValue, unit,
                COALESCE(display_abnormal_flag, abnormal_flag) AS abnormalFlag
         FROM observations WHERE report_id = ? ORDER BY id`,
      )
      .all(id) as ObservationRow[];

  /* 上一份体检：按「报告日期，缺失则用创建时间」排，取紧挨着这份之前的那份 */
  const anchor = db
    .prepare("SELECT COALESCE(report_issued_at, created_at) AS at FROM reports WHERE id = ?")
    .get(reportId) as { at: string | null } | undefined;
  const previous = anchor?.at
    ? (db
        .prepare(
          `SELECT id, title, report_issued_at AS issuedAt
           FROM reports
           WHERE member_id = ? AND report_type = 'checkup' AND deleted_at IS NULL AND status <> 'trashed'
             AND id <> ? AND COALESCE(report_issued_at, created_at) < ?
           ORDER BY COALESCE(report_issued_at, created_at) DESC LIMIT 1`,
        )
        .get(head.memberId, reportId, anchor.at) as ReportHead | undefined)
    : undefined;

  const currentRows = readObservations(reportId);
  const previousRows = previous ? readObservations(previous.id) : [];
  const previousByKey = new Map<string, ObservationRow>();
  for (const row of previousRows) {
    const key = itemKey(row);
    if (key && !previousByKey.has(key)) previousByKey.set(key, row);
  }

  const items: CheckupComparisonItem[] = currentRows.map((row) => {
    const before = previousByKey.get(itemKey(row));
    const abnormal = isAbnormal(row.abnormalFlag);
    const previousAbnormal = before ? isAbnormal(before.abnormalFlag) : false;

    let direction: CheckupComparisonItem["direction"] = null;
    if (!before) {
      direction = "new";
    } else if (row.numericValue !== null && before.numericValue !== null) {
      if (row.numericValue > before.numericValue) direction = "up";
      else if (row.numericValue < before.numericValue) direction = "down";
      else direction = "same";
    }

    let trend: CheckupComparisonItem["trend"] = "flat";
    if (!before) trend = "new";
    /* 「变好 / 变差」只认参考范围：这次异常、上次正常 → 变差，反之为变好。
       两边都正常只是数值浮动，不算“变差”，免得把人吓着。 */
    else if (abnormal && !previousAbnormal) trend = "worse";
    else if (!abnormal && previousAbnormal) trend = "better";

    return {
      name: row.name,
      unit: row.unit,
      current: row.resultText,
      previous: before?.resultText ?? null,
      direction,
      abnormal,
      previousAbnormal,
      trend,
    };
  });

  const worseItems = items.filter((item) => item.trend === "worse");
  return {
    report: { id: head.id, title: head.title, issuedAt: head.issuedAt ?? null },
    previous: previous ? { id: previous.id, title: previous.title, issuedAt: previous.issuedAt ?? null } : null,
    summary: {
      total: items.length,
      better: items.filter((item) => item.trend === "better").length,
      worse: worseItems.length,
      worseNames: worseItems.map((item) => item.name),
    },
    items,
  };
}
