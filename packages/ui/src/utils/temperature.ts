export type TemperatureLevel = "normal" | "mid" | "high";

/** 体温分档：38.5 是常见「要不要吃退烧药」的门槛，所以低热单独一档 */
export function temperatureLevel(value: string | null, unit: string | null) {
  if (!value) return null;
  const number = Number(value);
  const looksLikeTemperature = unit === "℃" || (number >= 30 && number <= 45);
  if (!looksLikeTemperature || !Number.isFinite(number)) return null;
  const level: TemperatureLevel = number >= 38.5 ? "high" : number >= 37.5 ? "mid" : "normal";
  /* `reading` / `unit` 分开给：时间轴上体温是「大数字 + 小单位」单开一套长相 */
  return { text: `${value}${unit ?? ""}`, reading: value, unit: unit ?? "", level } as const;
}

export type TemperatureInfo = NonNullable<ReturnType<typeof temperatureLevel>>;

export type TemperatureRun = { text: string; level?: TemperatureLevel };

/**
 * 把一段文字里的体温数值挑出来切成若干段，供渲染时按高低上色。
 * 只认「数字 + ℃」这种写法（摘要、小结里的体温都是这个格式），其余原样保留，
 * 因此对没有体温的文本是零影响。
 */
export function temperatureRuns(text: string): TemperatureRun[] {
  const runs: TemperatureRun[] = [];
  const pattern = /(\d+(?:\.\d+)?)\s*℃/g;
  let cursor = 0;
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(text))) {
    if (hit.index > cursor) runs.push({ text: text.slice(cursor, hit.index) });
    runs.push({ text: hit[0], level: temperatureLevel(hit[1]!, "℃")?.level });
    cursor = hit.index + hit[0].length;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs.length ? runs : [{ text }];
}
