export const DATE_WHEEL_ITEM_HEIGHT = 40;

// Mouse notches move one item; small trackpad deltas accumulate instead of
// turning every high-frequency event into a date change.
export function dateWheelStep(previous: number, deltaY: number, deltaMode: number) {
  const delta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 40 : deltaY;
  if (!Number.isFinite(delta) || delta === 0) return { remainder: previous, step: 0 };
  const total = (Math.sign(previous) === Math.sign(delta) ? previous : 0) + delta;
  if (Math.abs(total) < DATE_WHEEL_ITEM_HEIGHT) return { remainder: total, step: 0 };
  return { remainder: 0, step: Math.sign(total) };
}

/**
 * 滚轮**不做循环**：滑到头就停住，越界的索引夹到两端。
 * （以前是无限循环的，滑到 2026 年下面直接蹦出 1900 年，用户以为坏了。）
 */
export function clampWheelIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function clampCalendarDay(year: number, month: number, day: number) {
  return Math.min(day, new Date(year, month, 0).getDate());
}
