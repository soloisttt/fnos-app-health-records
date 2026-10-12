/**
 * 从报告的「主诉」里提取初始症状。
 *
 * 业务前提（2026-10-12 用户确认）：**主诉就是这次就医的起始症状**，
 * 所以把报告挂进病程时应当自动带出来，不该让人再手打一遍。
 *
 * 这里只做**规则拆分**，不调用 AI：
 * 医疗文本上宁可少拆、也不要猜错；拆出来的条目用户可在病程里修改或删除。
 * 只处理"拆条"与"末尾时长"，不做任何症状归一或推断。
 */

export type ExtractedSymptom = {
  name: string;
  durationText: string | null;
};

/** 常见分隔：顿号/逗号/分号/斜杠/换行，以及「伴」「及」这类连接词。 */
const SPLIT_PATTERN = /[、,，;；/\\|\n]+|伴有|伴发|伴|以及|合并|及/;

/** 结尾的时长描述：半天 / 3天 / 1周 / 两月 / 今天 / 昨日 等。 */
const DURATION_PATTERN =
  /(半天|(?:今天|今晨|今日|昨日|昨晚|前天|前天起)|[0-9一二三四五六七八九十两]{1,3}\s*(?:个)?(?:小时|分钟|天|日|周|星期|月|个月|年))$/;

function tidy(value: string) {
  return value
    .replace(/^[\s，,、；;。.：:（）()【】\[\]"'“”]+/, "")
    .replace(/[\s，,、；;。.：:（）()【】\[\]"'“”]+$/, "")
    .trim();
}

/**
 * 拆分主诉。例：
 * - `咳嗽半天`          → [{ 咳嗽, 半天 }]
 * - `咳嗽伴喘息`        → [{ 咳嗽, null }, { 喘息, null }]
 * - `发热3天，咳嗽1天`  → [{ 发热, 3天 }, { 咳嗽, 1天 }]
 * - `发热、咳嗽、流涕`  → 三条
 */
export function parseChiefComplaint(text: string | null | undefined): ExtractedSymptom[] {
  const out: ExtractedSymptom[] = [];
  const seen = new Set<string>();

  for (const raw of String(text ?? "").split(SPLIT_PATTERN)) {
    let piece = tidy(raw);
    if (!piece) continue;

    /* 末尾时长单独摘出来：只在时长前面还有实质内容时才摘，
       避免把「半天」这种本身就很短的整体当成纯时长丢掉。 */
    let durationText: string | null = null;
    const matched = piece.match(DURATION_PATTERN);
    if (matched && typeof matched.index === "number" && matched.index > 0) {
      const head = tidy(piece.slice(0, matched.index));
      if (head) {
        durationText = matched[1]!.trim();
        piece = head;
      }
    }

    const key = piece.replace(/\s+/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: piece, durationText });
  }

  return out;
}

/** 症状名归一：用于"同一段病程里不重复补录同一条症状"。 */
export function normalizeSymptomName(value: string) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}
