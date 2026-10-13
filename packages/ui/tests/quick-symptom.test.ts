import { describe, expect, it } from "vitest";
import { parseQuickSymptomInput } from "../src/utils/quick-symptom";

/* 固定"现在"为 2026-10-13 14:50，避免用例随实际时间漂移 */
const NOW = new Date(2026, 9, 13, 14, 50);

describe("快速输入解析", () => {
  it("口语时间 + 裸体温：5点半 37.5", () => {
    const result = parseQuickSymptomInput("5点半 37.5", NOW);
    expect(result.onsetAt).toBe("2026-10-13 17:30");
    expect(result.measuredValue).toBe("37.5");
    expect(result.measuredUnit).toBe("℃");
    expect(result.name).toBeNull();
    expect(result.matched).toBe(true);
  });

  it("24 小时时间 + 带「度」的体温", () => {
    const result = parseQuickSymptomInput("14:20 38.2度", NOW);
    expect(result.onsetAt).toBe("2026-10-13 14:20");
    expect(result.measuredValue).toBe("38.2");
    expect(result.measuredUnit).toBe("℃");
  });

  it("「昨天 + 下午」都识别", () => {
    const result = parseQuickSymptomInput("昨天下午3点 38", NOW);
    expect(result.onsetAt).toBe("2026-10-12 15:00");
    expect(result.measuredValue).toBe("38");
  });

  it("名称、时间、体温可以同时出现", () => {
    const result = parseQuickSymptomInput("早上8点 36.8度 咳嗽", NOW);
    expect(result.onsetAt).toBe("2026-10-13 08:00");
    expect(result.measuredValue).toBe("36.8");
    expect(result.name).toBe("咳嗽");
  });

  it("只说症状名时不编造时间", () => {
    const result = parseQuickSymptomInput("咳嗽", NOW);
    expect(result.name).toBe("咳嗽");
    expect(result.onsetAt).toBeNull();
    expect(result.measuredValue).toBeNull();
    expect(result.matched).toBe(false);
  });

  it("空输入不出内容", () => {
    const result = parseQuickSymptomInput("   ", NOW);
    expect(result).toEqual({ name: null, onsetAt: null, measuredValue: null, measuredUnit: null, matched: false });
  });

  it("没写上下午时，取离现在更近的那个时刻", () => {
    /* 现在 14:50：9 点更近今早 9:00，5 点更近今晚 17:00 */
    expect(parseQuickSymptomInput("9点", NOW).onsetAt).toBe("2026-10-13 09:00");
    expect(parseQuickSymptomInput("5点", NOW).onsetAt).toBe("2026-10-13 17:00");
  });

  it("大于 12 的小时按 24 小时制直接使用", () => {
    expect(parseQuickSymptomInput("20点30", NOW).onsetAt).toBe("2026-10-13 20:30");
  });

  it("不在体温区间的裸数字不当作测量值", () => {
    const result = parseQuickSymptomInput("喝水120", NOW);
    expect(result.measuredValue).toBeNull();
    expect(result.name).toBe("喝水120");
  });
});
