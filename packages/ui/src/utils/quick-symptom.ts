/**
 * 「快速输入」解析：把一句口语拆成症状字段。
 *
 * 目的：手机上一句话记完，不用逐项点选。例：
 *   `5点半 37.5`        → 今天 17:30、体温 37.5℃
 *   `昨天下午3点 38.2度` → 昨天 15:00、体温 38.2℃
 *   `14:20 咳嗽`        → 今天 14:20、名称「咳嗽」
 *
 * 纯规则、不联网。识别不出来的部分原样留给用户，不做猜测。
 */

export type QuickSymptomDraft = {
  /** 解析出的名称（口语里剩下的中文词），没有则为 null */
  name: string | null;
  /** `YYYY-MM-DD HH:mm`，没说到时间则为 null */
  onsetAt: string | null;
  measuredValue: string | null;
  measuredUnit: string | null;
  /** 是否至少识别出时间或数值（供界面决定要不要提示） */
  matched: boolean;
};

const DAY_WORDS: Array<[RegExp, number]> = [
  [/前天/, -2],
  [/昨天|昨日/, -1],
  [/今天|今日/, 0],
];

const PERIOD_WORDS = /(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)/;

/* 冒号形式 `14:20`；点钟形式 `5点半` / `14点20` / `早上8点`。
   点钟后的分钟必须**紧邻**数字（中文里「14点20」是连写的），
   这样「8点 36.8度」「下午3点 38」里的数字就不会被误当成分钟。 */
const TIME_PATTERN =
  /(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{1,2})|[点时](?:(\d{1,2})\s*分?|\s*(半))?)/;

/** 体温常用范围：30–45 视为摄氏度。 */
const BODY_TEMPERATURE_MIN = 30;
const BODY_TEMPERATURE_MAX = 45;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatLocal(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 没写「早上/下午」时，在"当天这个点"和"再加 12 小时"之间取**离现在更近**的那个。
 * 下午两点说「5点半」→ 17:30；早上十点说「9点」→ 当天 9:00。
 */
function resolveHour(hour: number, period: string | undefined, now: Date) {
  const periodValue = period ?? "";
  if (PERIOD_WORDS.test(periodValue)) {
    if (/凌晨/.test(periodValue)) return hour >= 12 ? hour - 12 : hour;
    if (/中午/.test(periodValue)) return hour <= 12 ? 12 : hour;
    if (/下午|傍晚|晚上|夜里|夜晚/.test(periodValue)) return hour <= 12 ? hour + 12 : hour;
    return hour;
  }
  if (hour > 12) return hour;
  const nowHours = now.getHours() + now.getMinutes() / 60;
  const sameDay = hour;
  const plusTwelve = hour + 12;
  return Math.abs(nowHours - sameDay) > Math.abs(plusTwelve - nowHours) ? plusTwelve : sameDay;
}

export function parseQuickSymptomInput(rawInput: string, now: Date = new Date()): QuickSymptomDraft {
  let rest = String(rawInput ?? "").trim();
  const draft: QuickSymptomDraft = {
    name: null,
    onsetAt: null,
    measuredValue: null,
    measuredUnit: null,
    matched: false,
  };
  if (!rest) return draft;

  /* 1) 日期词 */
  let dayOffset = 0;
  for (const [pattern, offset] of DAY_WORDS) {
    if (pattern.test(rest)) {
      dayOffset = offset;
      rest = rest.replace(pattern, " ");
      break;
    }
  }

  /* 2) 时间（先抠，避免把时间里的数字当成测量值） */
  const timeMatch = rest.match(TIME_PATTERN);
  if (timeMatch) {
    const hour = resolveHour(Number(timeMatch[2]), timeMatch[1], now);
    const minuteText = timeMatch[3] ?? timeMatch[4];
    const minute = timeMatch[5] ? 30 : Number(minuteText ?? 0);
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute);
    draft.onsetAt = formatLocal(date);
    draft.matched = true;
    rest = rest.replace(timeMatch[0], " ");
  } else if (dayOffset !== 0) {
    /* 只说了"昨天"没说几点：按当天同一时刻算 */
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, now.getHours(), now.getMinutes());
    draft.onsetAt = formatLocal(date);
    draft.matched = true;
  }

  /* 3) 测量值：带「度/℃」的，或落在体温区间内的裸数字 */
  const valueMatch = rest.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(度|℃|°C|c\b)?/i);
  if (valueMatch) {
    const value = Number(valueMatch[1]);
    const hasUnitWord = Boolean(valueMatch[2]);
    if (hasUnitWord || (value >= BODY_TEMPERATURE_MIN && value <= BODY_TEMPERATURE_MAX)) {
      draft.measuredValue = valueMatch[1]!;
      draft.measuredUnit = "℃";
      draft.matched = true;
      rest = rest.replace(valueMatch[0], " ");
    }
  }

  /* 4) 剩下的中文当症状名 */
  const name = rest
    .replace(/[，,。、；;：:！!？?（）()【】\[\]"'“”\s]+/g, " ")
    .trim();
  if (name) draft.name = name;

  return draft;
}
