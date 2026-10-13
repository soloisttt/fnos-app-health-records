import { describe, expect, it } from "vitest";
import { parseQuickEntry } from "../src/utils/quick-entry";

/* 固定"现在"为 2026-10-13 14:50，避免用例随实际时间漂移 */
const NOW = new Date(2026, 9, 13, 14, 50);

describe("快速记录解析 · 症状", () => {
  it("口语时间 + 裸体温：5点半 37.5", () => {
    const result = parseQuickEntry("5点半 37.5", NOW);
    expect(result.onsetAt).toBe("2026-10-13 17:30");
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

  it("没写上下午时，取离现在更近的那个时刻", () => {
    /* 现在 14:50：9 点更近今早 9:00，5 点更近今晚 17:00 */
    expect(parseQuickEntry("9点", NOW).onsetAt).toBe("2026-10-13 09:00");
    expect(parseQuickEntry("5点", NOW).onsetAt).toBe("2026-10-13 17:00");
  });

  it("大于 12 的小时按 24 小时制直接使用", () => {
    expect(parseQuickEntry("20点30", NOW).onsetAt).toBe("2026-10-13 20:30");
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
});
