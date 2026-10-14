import { onBeforeUnmount, onMounted, ref } from "vue";

/** 输入类元素：软键盘会为它们弹起来 */
function isEditable(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** 键盘弹起会让可视高度明显变小；用 120px 做阈值，避免地址栏伸缩误判 */
const SHRINK_THRESHOLD = 120;

/**
 * 软键盘是否弹起。
 *
 * 判定用两条线，缺一不可：
 * 1. **输入类元素获得焦点** —— 比量视口高度可靠（不同浏览器对 `interactive-widget` 的处理不一样），
 *    而且键盘刚弹起来的那一瞬间焦点就已经在了。
 * 2. **可视高度是否恢复** —— 手机上收起键盘时，输入框**往往仍然保持焦点**，
 *    `focusout` 根本不触发；只看焦点的话导航会一直收着回不来。
 *    所以额外盯 `visualViewport`：高度明显缩过（说明键盘真的弹起过）、之后又回到静止高度，
 *    就认为键盘收起了，不管输入框是否还聚焦。
 *
 * 用途：键盘弹起时把固定底部的导航收起来（它会被顶到键盘上方白占一块）。
 */
export function useSoftKeyboardOpen() {
  const open = ref(false);
  let timer: number | undefined;
  /* 键盘收起时的可视高度（取见过的最大值） */
  let restingHeight = 0;
  /* 这次聚焦期间，可视高度是否真的明显缩过 */
  let shrunkOnce = false;

  const viewport = () => (typeof window === "undefined" ? null : window.visualViewport ?? null);

  const syncViewport = () => {
    const vv = viewport();
    if (!vv) return;
    restingHeight = Math.max(restingHeight, vv.height);
    if (vv.height < restingHeight - SHRINK_THRESHOLD) {
      shrunkOnce = true;
      return;
    }
    /* 之前确实缩过，现在又回到静止高度 → 键盘收起了 */
    if (shrunkOnce) {
      shrunkOnce = false;
      open.value = false;
    }
  };

  const onFocusIn = (event: FocusEvent) => {
    if (timer) window.clearTimeout(timer);
    if (!isEditable(event.target)) return;
    const vv = viewport();
    /* 此刻键盘还没弹起来，量到的高度就是静止高度 */
    if (vv) restingHeight = Math.max(restingHeight, vv.height);
    shrunkOnce = false;
    open.value = true;
  };

  const onFocusOut = () => {
    /* 从一个输入框点到另一个输入框会先 focusout 再 focusin：
       延后一拍再判断，避免中间闪一下 */
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!isEditable(document.activeElement)) {
        shrunkOnce = false;
        open.value = false;
      }
    }, 120);
  };

  onMounted(() => {
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const vv = viewport();
    if (vv) {
      restingHeight = vv.height;
      vv.addEventListener("resize", syncViewport);
      vv.addEventListener("scroll", syncViewport);
    }
  });

  onBeforeUnmount(() => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    const vv = viewport();
    if (vv) {
      vv.removeEventListener("resize", syncViewport);
      vv.removeEventListener("scroll", syncViewport);
    }
    if (timer) window.clearTimeout(timer);
  });

  return open;
}
