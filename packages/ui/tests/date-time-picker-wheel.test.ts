import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import Picker from "../src/components/DateTimePicker.vue";

/*
 * 两件事：
 * 1. **滚轮不循环** —— 以前首尾各补一段做无限滚动，滑到 2026 年下面直接蹦出 1900 年，
 *    用户以为坏了。现在滑到头就停住。
 * 2. **没填过就默认今天** —— 新建病程的起病日期这类「已经发生过」的字段，
 *    一打开表单就该是今天，不用每次自己点一遍。
 */

const NOW = new Date("2026-10-14T15:30:00");
let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function freeze() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

describe("日期选择器 · 滚轮不循环（滑到头就停）", () => {
  it("每一列都只渲染一遍，没有首尾重复的缓冲项", async () => {
    freeze();
    wrapper = mount(Picker, { attachTo: document.body, props: { modelValue: null, showTime: true } });
    await wrapper.get(".datetime-picker-trigger").trigger("click");
    await nextTick();

    const wheels = [...document.querySelectorAll<HTMLElement>(".wheel-scroll")].map((wheel) =>
      [...wheel.querySelectorAll<HTMLElement>(".datetime-wheel-item")].map((item) => Number(item.textContent)),
    );
    const [years, months, days, hours, minutes] = wheels;

    /* 年份：从 1900 一路到今年，没有重复项 */
    expect(years![0]).toBe(1900);
    expect(years!.at(-1)).toBe(2046);
    expect(new Set(years).size).toBe(years!.length);
    /* 月 / 日 / 时 / 分 各只出现一遍 */
    expect(months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(days).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(hours).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(minutes!.length).toBe(60);
  });

  it("开了「不许选未来」时，年份列表的末项就是今年（到底就是底）", async () => {
    freeze();
    wrapper = mount(Picker, { attachTo: document.body, props: { modelValue: null, disableFuture: true } });
    await wrapper.get(".datetime-picker-trigger").trigger("click");
    await nextTick();

    const years = [...document.querySelectorAll<HTMLElement>(".wheel-scroll")[0]!.querySelectorAll(".datetime-wheel-item")].map(
      (item) => Number(item.textContent),
    );
    expect(years.at(-1)).toBe(2026);
    expect(new Set(years).size).toBe(years.length);
  });
});

describe("日期选择器 · 没填过就默认今天", () => {
  it("只到日期的字段：挂载时就填今天", async () => {
    freeze();
    wrapper = mount(Picker, { props: { modelValue: null, defaultToday: true } });
    await nextTick();
    expect(wrapper.emitted("update:modelValue")).toEqual([["2026-10-14"]]);
  });

  it("带时刻的字段：填到今天此刻（到分钟）", async () => {
    freeze();
    wrapper = mount(Picker, { props: { modelValue: null, showTime: true, defaultToday: true } });
    await nextTick();
    expect(wrapper.emitted("update:modelValue")).toEqual([["2026-10-14T15:30"]]);
  });

  it("已经有值就不覆盖", async () => {
    freeze();
    wrapper = mount(Picker, { props: { modelValue: "2026-10-05", defaultToday: true } });
    await nextTick();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("没加这个属性的字段照旧留空（出生日期、列表筛选不该被填今天）", async () => {
    freeze();
    wrapper = mount(Picker, { props: { modelValue: null } });
    await nextTick();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.get("input").element.value).toBe("");
  });
});
