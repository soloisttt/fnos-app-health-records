import { describe, expect, it } from "vitest";
import { medicationFrequencyNote, withFrequencyNote } from "../src/utils/medication-frequency";

describe("用药频次的中文说明", () => {
  it("保留原标签并在后面括号补中文", () => {
    expect(withFrequencyNote("tid")).toBe("tid（每日三次）");
    expect(withFrequencyNote("bid")).toBe("bid（每日两次）");
    expect(withFrequencyNote("qd")).toBe("qd（每日一次）");
    expect(withFrequencyNote("qid")).toBe("qid（每日四次）");
  });

  it("大小写、附加标点与常见变体都能识别", () => {
    expect(withFrequencyNote("TID")).toBe("TID（每日三次）");
    expect(withFrequencyNote("BID")).toBe("BID（每日两次）");
    expect(withFrequencyNote("t.i.d.")).toBe("t.i.d.（每日三次）");
    expect(withFrequencyNote(" qd ")).toBe("qd（每日一次）");
    expect(withFrequencyNote("qn")).toBe("qn（每晚一次）");
    expect(withFrequencyNote("prn")).toBe("prn（需要时服用）");
  });

  it("间隔小时数按数字生成说明", () => {
    expect(withFrequencyNote("q8h")).toBe("q8h（每8小时一次）");
    expect(withFrequencyNote("Q12H")).toBe("Q12H（每12小时一次）");
    expect(withFrequencyNote("qh")).toBe("qh（每小时一次）");
  });

  it("原文已是中文或无法识别时保持原样，不硬猜", () => {
    expect(withFrequencyNote("每日三次")).toBe("每日三次");
    expect(withFrequencyNote("3次/日")).toBe("3次/日");
    expect(withFrequencyNote("按需服用")).toBe("按需服用");
    expect(withFrequencyNote("custom")).toBe("custom");
    expect(medicationFrequencyNote("custom")).toBe(null);
  });

  it("空值返回 null", () => {
    expect(withFrequencyNote("")).toBe(null);
    expect(withFrequencyNote("   ")).toBe(null);
    expect(withFrequencyNote(null)).toBe(null);
    expect(withFrequencyNote(undefined)).toBe(null);
  });
});
