import { describe, expect, it } from "vitest";
import { feedbackEnvironment } from "../src/utils/feedback-environment";
describe("feedback environment allowlist", () => {
  it("selects safe fields and identifies Edge without sending the raw user agent", () => {
    const source = { appVersion: "1.0", accessMode: "port", secret: "SYNTHETIC_SECRET", database: { appliedSchemaVersion: 17, schemaVersion: 18 } };
    const result = feedbackEnvironment(source, { userAgent: "Windows Chrome/130.0 Safari/537.36 Edg/130.1", width: 400, height: 800 });
    expect(result).toContainEqual({ label: "浏览器", value: "Edge 130.1" });
    expect(result).toContainEqual({ label: "数据库版本", value: "v17" });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    expect(JSON.stringify(result)).not.toContain("Safari/537.36");
    expect(JSON.stringify(result)).not.toContain("Docker");
  });
  it("keeps client information when server information is unavailable", () => {
    const result = feedbackEnvironment(null, { userAgent: "unknown", width: 360, height: 740 });
    expect(result).toContainEqual({ label: "应用版本", value: "未获取" });
    expect(result).toContainEqual({ label: "页面尺寸", value: "360 × 740" });
    expect(result).toContainEqual({ label: "浏览器", value: "未获取" });
  });
});
