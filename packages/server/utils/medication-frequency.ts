/*
 * 用药频次的通俗说明（服务端）。
 *
 * 用于把频次代码与剂量/途径拼成病程时间轴上直接可读的一行文字。
 * 与 packages/ui/src/utils/medication-frequency.ts 是同一份实现
 * （前后端未共享代码，改动时请同步两边）。
 */

const frequencyNotes: Record<string, string> = {
  qd: "每日一次",
  bid: "每日两次",
  tid: "每日三次",
  qid: "每日四次",
  qod: "隔日一次",
  qw: "每周一次",
  biw: "每周两次",
  tiw: "每周三次",
  qn: "每晚一次",
  hs: "睡前一次",
  qm: "每晨一次",
  am: "早晨一次",
  pm: "下午一次",
  prn: "需要时服用",
  sos: "需要时服用",
  st: "立即一次",
  stat: "立即一次",
  ac: "饭前服用",
  pc: "饭后服用",
  qh: "每小时一次",
};

/** 把频次代码翻成中文说明；原文已是中文、或不是已知写法时返回 null。 */
export function medicationFrequencyNote(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  /* 含中文就不再解释——「每日三次」「3次/日」这类本来就能看懂 */
  if (/[\u4e00-\u9fff]/.test(raw)) return null;
  const key = raw.toLowerCase().replace(/[\s.。·、,，/]/g, "");
  const hourly = /^q(\d{1,2})h$/.exec(key);
  if (hourly) return `每${Number(hourly[1])}小时一次`;
  return frequencyNotes[key] ?? null;
}

/** 展示用：保留原标签并在后面补中文说明，如 `tid（每日三次）`；没有可补的说明时原样返回。 */
export function withFrequencyNote(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const note = medicationFrequencyNote(text);
  return note ? `${text}（${note}）` : text;
}
