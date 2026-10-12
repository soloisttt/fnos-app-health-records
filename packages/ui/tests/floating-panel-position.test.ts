import { describe, expect, it } from "vitest";
import { resolveFloatingPanelPosition } from "../src/utils/floating-panel-position";

/* 桌面端常见尺寸：视口 1024×800，面板 340×300（与 DateTimePicker 的 PC 样式一致） */
const base = {
  panelWidth: 340,
  panelHeight: 300,
  viewportWidth: 1024,
  viewportHeight: 800,
};

describe("浮层面板落位", () => {
  it("下方空间充足时贴在触发器下方", () => {
    const result = resolveFloatingPanelPosition({
      ...base,
      trigger: { top: 100, bottom: 140, left: 200 },
    });
    expect(result.top).toBe(148);
    expect(result.left).toBe(200);
    expect(result.flipped).toBe(false);
  });

  it("下方放不下时翻到触发器上方，面板底边不越出窗口下缘", () => {
    /* 这正是「添加家庭成员 → 出生日期」的位置：输入框靠近窗口底部 */
    const result = resolveFloatingPanelPosition({
      ...base,
      trigger: { top: 700, bottom: 740, left: 200 },
    });
    expect(result.flipped).toBe(true);
    expect(result.top).toBe(392);
    expect(result.top + base.panelHeight).toBeLessThanOrEqual(base.viewportHeight - 16);
  });

  it("上下都放不下时夹进视口，顶边不越出、不出现负值", () => {
    /* 面板高度超过可用空间时无法完整放下，此处只保证顶边落在视口内，
       底部溢出由面板自身的 max-height + 内部滚动兜底。 */
    const result = resolveFloatingPanelPosition({
      ...base,
      panelHeight: 780,
      trigger: { top: 400, bottom: 440, left: 200 },
    });
    expect(result.top).toBe(16);
    expect(result.flipped).toBe(false);
  });

  it("面板低于可用空间时底边一定留在视口内", () => {
    const result = resolveFloatingPanelPosition({
      ...base,
      panelHeight: 700,
      trigger: { top: 500, bottom: 540, left: 200 },
    });
    expect(result.top + 700).toBeLessThanOrEqual(base.viewportHeight - 16);
    expect(result.top).toBeGreaterThanOrEqual(16);
  });

  it("水平方向越界时夹在视口内", () => {
    const leftEdge = resolveFloatingPanelPosition({
      ...base,
      trigger: { top: 100, bottom: 140, left: 0 },
    });
    expect(leftEdge.left).toBe(16);

    const rightEdge = resolveFloatingPanelPosition({
      ...base,
      trigger: { top: 100, bottom: 140, left: 1000 },
    });
    expect(rightEdge.left).toBe(base.viewportWidth - base.panelWidth - 16);
  });

  it("触发器贴住窗口顶部时至少留出上边距", () => {
    const result = resolveFloatingPanelPosition({
      ...base,
      trigger: { top: 0, bottom: 40, left: 200 },
    });
    expect(result.top).toBeGreaterThanOrEqual(16);
    expect(result.flipped).toBe(false);
  });

  it("间距与留白可自定义", () => {
    const result = resolveFloatingPanelPosition({
      ...base,
      gap: 2,
      margin: 4,
      trigger: { top: 100, bottom: 140, left: 0 },
    });
    expect(result.top).toBe(142);
    expect(result.left).toBe(4);
  });
});
