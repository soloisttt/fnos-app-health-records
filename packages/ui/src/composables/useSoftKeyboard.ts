import { onBeforeUnmount, onMounted, ref } from "vue";

/** 输入类元素：软键盘会为它们弹起来 */
function isEditable(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * 软键盘是否弹起。
 *
 * 判定方式是「输入类元素获得焦点」，而不是量视口高度 ——
 * 不同浏览器对 `interactive-widget` 的处理不一样：有的只缩可视视口，
 * 有的连布局视口一起缩，量高度在后者身上根本测不出键盘。
 *
 * 用途：键盘弹起时把固定底部的导航收起来。它会被顶到键盘上方白占一块，
 * 手机上打字时能看到的有效内容就少了一截。
 */
export function useSoftKeyboardOpen() {
  const open = ref(false);
  let timer: number | undefined;

  const onFocusIn = (event: FocusEvent) => {
    if (timer) window.clearTimeout(timer);
    if (isEditable(event.target)) open.value = true;
  };

  const onFocusOut = () => {
    /* 从一个输入框点到另一个输入框会先 focusout 再 focusin：
       延后一拍再判断，避免中间闪一下 */
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!isEditable(document.activeElement)) open.value = false;
    }, 120);
  };

  onMounted(() => {
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    if (timer) window.clearTimeout(timer);
  });

  return open;
}
