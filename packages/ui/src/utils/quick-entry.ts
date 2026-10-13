/**
 * 「快速记录」解析：把一句口语拆成一条症状或一条用药。
 *
 * 目的：手机上一句话记完，不用逐项点选。例：
 *   `5点半 37.5`              → 今天 17:30、体温 37.5℃
 *   `昨天下午体温3点 38.2度`   → 昨天 15:00、体温 38.2℃
 *   `14:20 咳嗽`              → 今天 14:20、症状「咳嗽」
 *   `下午吃氨溴特罗口服溶液5ml` → 今天 15:00、用药「氨溴特罗口服溶液」5ml
 *
 * 纯规则、不联网。识别不出来的内容原样留给用户，不做猜测；
 * **判不准时一律按症状处理**（例如「吃药后咳嗽」），用户改一下即可。
 */

export type QuickEntryKind = "symptom" | "medication";

export type QuickEntryDraft = {
  kind: QuickEntryKind;
  /** 解析出的名称（口语里剩下的中文词），没有则为 null */
  name: string | null;
  /** `YYYY-MM-DD HH:mm`，没说到时间则为 null */
  onsetAt: string | null;
  /** 症状：体温数值与单位 */
  measuredValue: string | null;
  measuredUnit: string | null;
  /** 用药：单次剂量 / 服药频次 / 用法 */
  dose: string | null;
  frequency: string | null;
  route: string | null;
  /** 是否至少识别出时间、数值或剂量（供界面决定要不要提示） */
  matched: boolean;
  /** 名称是程序按数值补出来的（「体温」），界面提示用户确认 */
  autoName: boolean;
};

const DAY_WORDS: Array<[RegExp, number]> = [
  [/前天/, -2],
  [/昨天|昨日/, -1],
  [/今天|今日/, 0],
];

const PERIOD_WORD = "(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)";
const PERIOD_WORD_ALL = new RegExp(PERIOD_WORD, "g");

/* 冒号形式 `14:20`；点钟形式 `5点半` / `14点20` / `早上8点`。
   点钟后的分钟必须**紧邻**数字（中文里「14点20」是连写的），
   这样「8点 36.8度」「下午3点 38」里的数字就不会被误当成分钟。
   时段词本身可选：它也可能离钟点很远（「下午体温3点」），由下面回退查找。 */
const TIME_PATTERN = new RegExp(
  `${PERIOD_WORD}?\\s*(\\d{1,2})\\s*(?:[:：]\\s*(\\d{1,2})|[点时](?:(\\d{1,2})\\s*分?|\\s*(半))?)`,
);

/** 体温常用范围：30–45 视为摄氏度。 */
const TEMPERATURE_MIN = 30;
const TEMPERATURE_MAX = 45;

/** 剂型 / 成药词：出现即认为在说用药。
    故意不收孤立的「药」字，免得「吃药后咳嗽」被误判成用药。 */
const MEDICATION_FORM_PATTERN =
  /(口服液|口服溶液|混悬液|混悬剂|颗粒|胶囊|糖浆|滴剂|喷雾|软膏|栓剂|片剂|注射液|溶液|药水|滴鼻液|退烧药|消炎药|抗生素|益生菌)/;

/** 单次剂量：数字 + 计量单位。 */
const DOSE_PATTERN = /(\d+(?:\.\d+)?)\s*(ml|毫升|mg|毫克|克|片|粒|袋|支|滴|喷)/i;

/** 服药动词 + 剂量同时出现也算用药（盖住「吃美林5ml」这种没写剂型的）。 */
const TAKE_VERB_PATTERN = /(吃|服用|口服|冲服|服|喂|喝|滴|喷)/;

/** 清理药名时只剥掉**开头**的服药动词：「吃美林」→「美林」。
    「氨溴特罗口服溶液」里的「口服」是药名的一部分，不能动。 */
const LEADING_TAKE_VERB_PATTERN = /^\s*(?:吃|服用|口服|冲服|服|喂|喝|滴|喷)了?\s*/;

const FREQUENCY_PATTERNS: RegExp[] = [
  /\b(?:tid|bid|qid|qd|qn|prn)\b/i,
  /(?:每日|每天|一天|一日|每隔)\s*[一二三四1-4]\s*次/,
  /(?:每|每隔)\s*\d+\s*小时/,
];

/* 「口服」单独出现算用法；但「口服液 / 口服溶液」是药名的一部分，不能被剥掉 */
const ROUTE_PATTERN = /(口服(?!液|溶液)|外用|冲服|含服|雾化|滴眼|滴鼻|涂抹|贴剂|塞肛)/;

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
  if (periodValue) {
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

function emptyDraft(): QuickEntryDraft {
  return {
    kind: "symptom",
    name: null,
    onsetAt: null,
    measuredValue: null,
    measuredUnit: null,
    dose: null,
    frequency: null,
    route: null,
    matched: false,
    autoName: false,
  };
}

/** 去掉标点与多余空白，剩下的中文就是候选名称。 */
function cleanName(value: string) {
  return value
    .replace(/[，,。、；;：:！!？?（）()【】\[\]"'“”\s]+/g, " ")
    .trim();
}

export function parseQuickEntry(rawInput: string, now: Date = new Date()): QuickEntryDraft {
  let rest = String(rawInput ?? "").trim();
  const draft = emptyDraft();
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

  /* 2) 时间（先抠，避免把时间里的数字当成测量值或剂量）。
     时段词可能没有紧贴钟点（「下午体温3点」），那就往前找最近的一个。 */
  const timeMatch = rest.match(TIME_PATTERN);
  let periodWord = timeMatch?.[1] ?? "";
  if (timeMatch && !periodWord) {
    const before = rest.slice(0, timeMatch.index ?? 0);
    const found = before.match(PERIOD_WORD_ALL);
    if (found?.length) periodWord = found[found.length - 1]!;
  }
  if (timeMatch) {
    const hour = resolveHour(Number(timeMatch[2]), periodWord, now);
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

  /* 3) 时段词只用来算时刻，绝不能落进名称里（否则「下午体温」会变成症状名） */
  rest = rest.replace(PERIOD_WORD_ALL, " ");

  /* 4) 判定这条是"用药"还是"症状"：拿不准就当症状，用户改一下即可 */
  const dose = rest.match(DOSE_PATTERN);
  const frequency = FREQUENCY_PATTERNS.map((pattern) => rest.match(pattern)?.[0]).find(Boolean) ?? null;
  const route = rest.match(ROUTE_PATTERN)?.[0] ?? null;
  const isMedication =
    MEDICATION_FORM_PATTERN.test(rest) ||
    (TAKE_VERB_PATTERN.test(rest) && Boolean(dose)) ||
    Boolean(frequency && dose);

  if (isMedication) {
    draft.kind = "medication";
    draft.dose = dose ? `${dose[1]}${(dose[2] ?? "").toLowerCase()}` : null;
    draft.frequency = frequency ? frequency.replace(/\s+/g, "") : null;
    draft.route = route;
    if (dose || frequency) draft.matched = true;
    const name = cleanName(
      rest
        .replace(DOSE_PATTERN, " ")
        .replace(ROUTE_PATTERN, " ")
        .replace(LEADING_TAKE_VERB_PATTERN, " ")
        .replace(/(?:每日|每天|一天|一日|每隔|每)\s*[一二三四1-4\d]\s*(?:次|小时)/g, " ")
        .replace(/\b(?:tid|bid|qid|qd|qn|prn)\b/gi, " "),
    );
    if (name) draft.name = name;
    return draft;
  }

  /* 5) 测量值：带「度/℃」的，或落在体温区间内的裸数字 */
  const valueMatch = rest.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(度|℃|°C|c\b)?/i);
  if (valueMatch) {
    const value = Number(valueMatch[1]);
    const hasUnitWord = Boolean(valueMatch[2]);
    if (hasUnitWord || (value >= TEMPERATURE_MIN && value <= TEMPERATURE_MAX)) {
      draft.measuredValue = valueMatch[1]!;
      draft.measuredUnit = "℃";
      draft.matched = true;
      rest = rest.replace(valueMatch[0], " ");
    }
  }

  /* 6) 剩下的中文当症状名；只说了体温没提名称时自动归到「体温」 */
  const name = cleanName(rest);
  if (name) {
    draft.name = name;
  } else if (draft.measuredValue) {
    draft.name = "体温";
    draft.autoName = true;
  }

  return draft;
}
