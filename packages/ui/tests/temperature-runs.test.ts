import { describe, expect, it } from "vitest";
import { temperatureLevel, temperatureRuns } from "../src/utils/temperature";

/*
 * 体温在摘要 / 痊愈总结里按高低上色，靠 temperatureRuns() 把文本切成片段。
 * 它只认「数字 + ℃」，所以对没有体温的文本必须零影响。
 */

describe("体温分档与上色切分", () => {
  it("按 37.5 / 38.5 分三档", () => {
    expect(temperatureLevel("36.8", "℃")?.level).toBe("normal");
    expect(temperatureLevel("37.5", "℃")?.level).toBe("mid");
    expect(temperatureLevel("38.4", "℃")?.level).toBe("mid");
    expect(temperatureLevel("38.5", "℃")?.level).toBe("high");
    expect(temperatureLevel("39", "℃")?.level).toBe("high");
  });

  it("不是体温的数值不参与上色", () => {
    expect(temperatureLevel("120", "mmHg")).toBeNull();
    expect(temperatureLevel("", "℃")).toBeNull();
    expect(temperatureLevel(null, null)).toBeNull();
  });

  it("把文本里的「数字℃」切成带档位的片段，其余原样保留", () => {
    const text = "体温：37℃（12:00）→ 38.5℃（19:42）";
    const runs = temperatureRuns(text);
    expect(runs.map((run) => run.text).join("")).toBe(text);
    expect(runs.filter((run) => run.level).map((run) => [run.text, run.level])).toEqual([
      ["37℃", "normal"],
      ["38.5℃", "high"],
    ]);
  });

  it("没有体温时原样返回一段", () => {
    const text = "咳嗽：昨天 08:00 出现 → 今天 12:00 已消失";
    expect(temperatureRuns(text)).toEqual([{ text }]);
  });
});
