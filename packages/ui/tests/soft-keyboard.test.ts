import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { useSoftKeyboardOpen } from "../src/composables/useSoftKeyboard";

/*
 * 软键盘弹起时底部导航会被顶到键盘上方白占一块，所以要收起来。
 * 判定用「输入类元素获得焦点」——比量视口高度可靠（不同浏览器对
 * interactive-widget 的处理不一样，有的把布局视口一起缩，量高度测不出键盘）。
 */

const Host = defineComponent({
  setup() {
    const open = useSoftKeyboardOpen();
    return () => h("div", { class: open.value ? "kb-open" : "kb-closed" });
  },
});

const wait = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));

function focusElement(element: HTMLElement) {
  document.body.appendChild(element);
  element.focus();
  element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  return element;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("软键盘弹起时收起底部导航", () => {
  it("输入框获得焦点算键盘弹起，失焦后恢复", async () => {
    const wrapper = mount(Host);
    expect(wrapper.classes()).toContain("kb-closed");

    const input = focusElement(document.createElement("input"));
    await nextTick();
    expect(wrapper.classes()).toContain("kb-open");

    input.blur();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await wait();
    await nextTick();
    expect(wrapper.classes()).toContain("kb-closed");
    wrapper.unmount();
  });

  it("多行输入与可编辑区域同样算键盘弹起", async () => {
    const wrapper = mount(Host);
    const textarea = focusElement(document.createElement("textarea"));
    await nextTick();
    expect(wrapper.classes()).toContain("kb-open");

    textarea.blur();
    const editable = focusElement(document.createElement("div"));
    editable.setAttribute("contenteditable", "true");
    await wait();
    await nextTick();
    expect(wrapper.classes()).toContain("kb-open");
    wrapper.unmount();
  });

  it("点普通按钮不算键盘弹起", async () => {
    const wrapper = mount(Host);
    focusElement(document.createElement("button"));
    await nextTick();
    expect(wrapper.classes()).toContain("kb-closed");
    wrapper.unmount();
  });

  it("键盘收起后导航自己回来（输入框仍保持焦点、focusout 不触发的情况）", async () => {
    /* 手机上收起键盘时输入框往往还是聚焦的，所以不能只看焦点，还要看可视高度有没有恢复 */
    const listeners: Array<() => void> = [];
    const viewport = {
      height: 800,
      addEventListener: (_type: string, handler: () => void) => listeners.push(handler),
      removeEventListener: () => {},
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });

    try {
      const wrapper = mount(Host);
      const input = focusElement(document.createElement("input"));
      await nextTick();
      expect(wrapper.classes()).toContain("kb-open");

      /* 键盘弹起：可视高度明显变小 */
      viewport.height = 460;
      listeners.forEach((fire) => fire());
      await nextTick();
      expect(wrapper.classes()).toContain("kb-open");

      /* 键盘收起：高度回到静止值，但输入框仍然聚焦 */
      viewport.height = 800;
      listeners.forEach((fire) => fire());
      await nextTick();
      expect(wrapper.classes()).toContain("kb-closed");
      expect(document.activeElement).toBe(input);
      wrapper.unmount();
    } finally {
      delete (window as unknown as Record<string, unknown>).visualViewport;
    }
  });

  it("样式里确实有「键盘弹起时收起底部导航」这条规则", () => {
    const css = readFileSync("packages/ui/src/styles.css", "utf8");
    expect(css).toContain(".app-shell.is-keyboard-open .mobile-nav");
  });
});
