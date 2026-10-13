import { describe, expect, it } from "vitest";
import { isFutureMoment } from "../src/utils/time";

/** 本地时间串（`YYYY-MM-DD HH:mm`）晚于「现在」时要能拦下来 */
function localMoment(offsetMinutes: number) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("isFutureMoment", () => {
  it("过去的时间不算未来", () => {
    expect(isFutureMoment(localMoment(-120))).toBe(false);
    expect(isFutureMoment("2026-01-01 08:00")).toBe(false);
  });

  it("留 1 分钟容差：面板刚填的「现在」不会被判成未来", () => {
    expect(isFutureMoment(localMoment(0))).toBe(false);
    expect(isFutureMoment(localMoment(0).replace(" ", "T"))).toBe(false);
  });

  it("确实晚于现在（例如下午填 22:30）要判成未来", () => {
    expect(isFutureMoment(localMoment(180))).toBe(true);
  });

  it("空值与非法值不拦，交给别处校验", () => {
    expect(isFutureMoment("")).toBe(false);
    expect(isFutureMoment(null)).toBe(false);
    expect(isFutureMoment("随便写的")).toBe(false);
  });
});
