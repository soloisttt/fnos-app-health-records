import { describe, expect, it } from "vitest";
import { parseQuickEntry } from "../src/utils/quick-entry";

/* 固定"现在"为 2026-10-13 14:50，避免用例随实际时间漂移 */
const NOW = new Date(2026, 9, 13, 14, 50);

describe("快速记录解析 · 症状", () => {
  it("口语时间 + 裸体温：5点半 37.5", () => {
    const result = parseQuickEntry("5点半 37.5", NOW);
    /* 现在 14:50：不写时段词时优先落在过去 → 今早 5:30（今晚 17:30 还没到，存不进去） */
    expect(result.onsetAt).toBe("2026-10-13 05:30");
    expect(result.measuredValue).toBe("37.5");
    expect(result.measuredUnit).toBe("℃");
    /* 只说数值没提名称 → 自动归到「体温」 */
    expect(result.name).toBe("体温");
    expect(result.autoName).toBe(true);
    expect(result.matched).toBe(true);
  });

  it("24 小时时间 + 带「度」的体温", () => {
    const result = parseQuickEntry("14:20 38.2度", NOW);
    expect(result.onsetAt).toBe("2026-10-13 14:20");
    expect(result.measuredValue).toBe("38.2");
    expect(result.measuredUnit).toBe("℃");
  });

  it("「昨天 + 下午」都识别", () => {
    const result = parseQuickEntry("昨天下午3点 38", NOW);
    expect(result.onsetAt).toBe("2026-10-12 15:00");
    expect(result.measuredValue).toBe("38");
  });

  it("时段词与钟点之间夹了别的字也要认出时段", () => {
    /* 用户实测报错的那句：原来名称会变成「下午体温」 */
    const result = parseQuickEntry("昨天下午体温3点 38.2度", NOW);
    expect(result.onsetAt).toBe("2026-10-12 15:00");
    expect(result.measuredValue).toBe("38.2");
    expect(result.measuredUnit).toBe("℃");
    expect(result.name).toBe("体温");
  });

  it("时段词永远不进症状名", () => {
    const result = parseQuickEntry("昨天上午3点 37.8度", NOW);
    expect(result.onsetAt).toBe("2026-10-12 03:00");
    expect(result.name).toBe("体温");
  });

  it("名称、时间、体温可以同时出现", () => {
    const result = parseQuickEntry("早上8点 36.8度 咳嗽", NOW);
    expect(result.onsetAt).toBe("2026-10-13 08:00");
    expect(result.measuredValue).toBe("36.8");
    expect(result.name).toBe("咳嗽");
    expect(result.autoName).toBe(false);
  });

  it("只说症状名时不编造时间", () => {
    const result = parseQuickEntry("咳嗽", NOW);
    expect(result.kind).toBe("symptom");
    expect(result.name).toBe("咳嗽");
    expect(result.onsetAt).toBeNull();
    expect(result.measuredValue).toBeNull();
    expect(result.matched).toBe(false);
  });

  it("空输入不出内容", () => {
    expect(parseQuickEntry("   ", NOW)).toEqual({
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
    });
  });

  it("没写上下午时，优先取不晚于现在的那个时刻", () => {
    /* 现在 14:50：9 点 → 今早 9:00；5 点 → 今早 5:00（今晚 17:00 在未来，存不进去） */
    expect(parseQuickEntry("9点", NOW).onsetAt).toBe("2026-10-13 09:00");
    expect(parseQuickEntry("5点", NOW).onsetAt).toBe("2026-10-13 05:00");
  });

  it("两个候选都晚于现在时取较早的那个（交给上层提示不能晚于现在）", () => {
    const morning = new Date(2026, 9, 13, 9, 0);
    expect(parseQuickEntry("十点 37", morning).onsetAt).toBe("2026-10-13 10:00");
  });

  it("用户实测那句：21 点说「今天十点」，要落在早上 10 点而不是晚上 10 点", () => {
    const night = new Date(2026, 9, 13, 21, 10);
    const result = parseQuickEntry("今天十点体温37.5度", night);
    expect(result.onsetAt).toBe("2026-10-13 10:00");
    expect(result.measuredValue).toBe("37.5");
    expect(result.name).toBe("体温");
  });

  it("大于 12 的小时按 24 小时制直接使用", () => {
    expect(parseQuickEntry("20点30", NOW).onsetAt).toBe("2026-10-13 20:30");
  });

  it("中文数字时间也要认（三点五十 / 十点半 / 两点二十 / 十二点）", () => {
    /* 现在 14:50：三点五十 → 凌晨 3:50（15:50 还没到）；十点半 → 10:30；两点二十 → 14:20 */
    expect(parseQuickEntry("三点五十 37.8", NOW).onsetAt).toBe("2026-10-13 03:50");
    expect(parseQuickEntry("十点半 37.5", NOW).onsetAt).toBe("2026-10-13 10:30");
    expect(parseQuickEntry("两点二十 38", NOW).onsetAt).toBe("2026-10-13 14:20");
    /* 12 点不能因为"再加 12 小时"滚到第二天 */
    expect(parseQuickEntry("十二点 37", NOW).onsetAt).toBe("2026-10-13 12:00");
    expect(parseQuickEntry("上午九点 37.2", NOW).onsetAt).toBe("2026-10-13 09:00");
  });

  it("用户实测那句：三点五十吃氨溴特罗口服溶液5ml", () => {
    const result = parseQuickEntry("三点五十吃氨溴特罗口服溶液5ml", NOW);
    expect(result.kind).toBe("medication");
    /* 名称不能带时间与服药动词 */
    expect(result.name).toBe("氨溴特罗口服溶液");
    expect(result.dose).toBe("5ml");
    expect(result.onsetAt).toBe("2026-10-13 03:50");
  });

  it("不在体温区间的裸数字不当作测量值", () => {
    const result = parseQuickEntry("喝水120", NOW);
    expect(result.measuredValue).toBeNull();
    expect(result.name).toBe("喝水120");
  });
});

describe("快速记录解析 · 用药", () => {
  it("用户举的例子：下午吃氨溴特罗口服溶液5ml", () => {
    const result = parseQuickEntry("下午吃氨溴特罗口服溶液5ml", NOW);
    expect(result.kind).toBe("medication");
    expect(result.name).toBe("氨溴特罗口服溶液");
    expect(result.dose).toBe("5ml");
    /* 只说「下午」没写钟点，不编造时刻（由表单默认填当前时间） */
    expect(result.onsetAt).toBeNull();
  });

  it("没写剂型的品牌药，靠「服药动词 + 剂量」认出：吃美林5ml", () => {
    const result = parseQuickEntry("吃美林5ml", NOW);
    expect(result.kind).toBe("medication");
    expect(result.name).toBe("美林");
    expect(result.dose).toBe("5ml");
  });

  it("频次一起写上", () => {
    const result = parseQuickEntry("早上8点 氨溴特罗口服溶液5ml bid", NOW);
    expect(result.kind).toBe("medication");
    expect(result.name).toBe("氨溴特罗口服溶液");
    expect(result.dose).toBe("5ml");
    expect(result.frequency).toBe("bid");
    expect(result.onsetAt).toBe("2026-10-13 08:00");
  });

  it("用药的剂量不会被当成体温", () => {
    const result = parseQuickEntry("喂了布洛芬混悬液4ml", NOW);
    expect(result.kind).toBe("medication");
    expect(result.dose).toBe("4ml");
    expect(result.measuredValue).toBeNull();
    expect(result.name).toBe("布洛芬混悬液");
  });

  it("只是提到「药」而没有剂量时，仍按症状处理（宁可少认）", () => {
    const result = parseQuickEntry("吃药后咳嗽", NOW);
    expect(result.kind).toBe("symptom");
    expect(result.name).toBe("吃药后咳嗽");
  });

  it("用户实测：吃了布洛芬（没剂量也没剂型词）也算服药", () => {
    const result = parseQuickEntry("昨天17:30 吃了布洛芬", NOW);
    expect(result.kind).toBe("medication");
    expect(result.name).toBe("布洛芬");
    expect(result.onsetAt).toBe("2026-10-12 17:30");
    /* 认出药名就算「识别到了」，预览要亮出来 */
    expect(result.matched).toBe(true);
  });

  it("「吃了 / 服用了 / 喂了」都认，且不会把动词留在药名里", () => {
    expect(parseQuickEntry("服用了美林", NOW)).toMatchObject({ kind: "medication", name: "美林" });
    expect(parseQuickEntry("喂了泰诺林", NOW)).toMatchObject({ kind: "medication", name: "泰诺林" });
  });

  it("「吃了两次」「喝了奶」这类不能被当成服药", () => {
    expect(parseQuickEntry("吃了两次", NOW).kind).toBe("symptom");
    expect(parseQuickEntry("喝了奶", NOW).kind).toBe("symptom");
    expect(parseQuickEntry("吃了点东西", NOW).kind).toBe("symptom");
  });
});
