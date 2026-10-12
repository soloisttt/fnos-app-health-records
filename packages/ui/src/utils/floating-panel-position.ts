/*
 * 浮层面板（日期选择器等）相对触发元素的落位计算。
 *
 * 原实现只把面板贴在触发器下方，不做边界判断：当触发器靠近窗口底部时，
 * 面板会伸出窗口下缘被裁掉，用户看到的就是「日期显示不全」。
 * 这里统一处理：优先向下、放不下向上翻转、上下都不够则夹进视口。
 */

export type FloatingPanelPlacement = {
  top: number;
  left: number;
  /** 是否因下方空间不足而翻到了触发器上方 */
  flipped: boolean;
};

export type FloatingPanelPositionInput = {
  /** 触发元素的视口矩形（只需 top/bottom/left） */
  trigger: { top: number; bottom: number; left: number };
  panelWidth: number;
  panelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** 触发器与面板之间的间距，默认 8 */
  gap?: number;
  /** 面板与视口边缘的最小留白，默认 16 */
  margin?: number;
};

export function resolveFloatingPanelPosition(input: FloatingPanelPositionInput): FloatingPanelPlacement {
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 16;
  const { trigger, panelWidth, panelHeight, viewportWidth, viewportHeight } = input;

  /* 水平：优先与触发器左对齐，越界时夹在视口内 */
  const left = Math.max(margin, Math.min(trigger.left, viewportWidth - panelWidth - margin));

  /* 垂直：向下 → 放不下则向上翻转 → 仍放不下则夹进视口 */
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panelHeight;
  let top = below;
  let flipped = false;
  if (below + panelHeight > viewportHeight - margin) {
    if (above >= margin) {
      top = above;
      flipped = true;
    } else {
      top = Math.max(margin, viewportHeight - margin - panelHeight);
    }
  }
  if (top < margin) top = margin;

  return { top, left, flipped };
}
