import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import Picker from "../src/components/DateTimePicker.vue";

/*
 * `disable-future` 给「已经发生过」的时间用（起病、症状、服药、报告时间…）。
 * 滚轮里直接**不生成**晚于现在的选项，用户想选未来也选不到 ——
 * 比「选完再报错」友好，也从源头上堵住「记录时间落到未来」的脏数据。
 * 反例：提醒日期、下次接种时间本来就该是未来，那些字段不加这个属性。
 */

const NOW = new Date("2026-10-14T15:30:00");
let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** 打开滚轮，按 年 / 月 / 日 / 时 / 分 的顺序返回每列渲染出来的数字 */
async function openWheels(props: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  wrapper = mount(Picker, { attachTo: document.body, props: { modelValue: null, showTime: true, ...props } });
  await wrapper.get(".datetime-picker-trigger").trigger("click");
  await nextTick();
  return [...document.querySelectorAll<HTMLElement>(".wheel-scroll")].map((wheel) =>
    [...wheel.querySelectorAll<HTMLElement>(".datetime-wheel-item")].map((item) => Number(item.textContent)),
  );
}

describe("日期选择器 · 不允许选未来", () => {
  it("年、月、日、时、分都不生成晚于现在的选项", async () => {
    const [years, months, days, hours, minutes] = await openWheels({ disableFuture: true });

    expect(Math.max(...years!)).toBe(2026);
    /* 滚到今年时，月份最多到当前月（10 月） */
    expect(Math.max(...months!)).toBe(10);
    /* 今年当月时，日期最多到当天（14 日） */
    expect(Math.max(...days!)).toBe(14);
    /* 选中当天时，时刻最多到此刻（15:30） */
    expect(Math.max(...hours!)).toBe(15);
    expect(Math.max(...minutes!)).toBe(30);
  });

  it("不开启时可以一路选到未来（默认到 +20 年）", async () => {
    /* 列顺序是 年 / 月 / 日 / 时 / 分 */
    const [years, months, , hours, minutes] = await openWheels({});

    expect(Math.max(...years!)).toBe(2046);
    expect(Math.max(...months!)).toBe(12);
    expect(Math.max(...hours!)).toBe(23);
    expect(Math.max(...minutes!)).toBe(59);
  });

  it("打开时带着今天的未来时刻，会被收到最近的可选值", async () => {
    /* 例如旧数据里存了今天 22:45 —— 滚轮里没有 22 点，定位不到会空转 */
    const [, , , hours, minutes] = await openWheels({ disableFuture: true, modelValue: "2026-10-14T22:45" });

    expect(Math.max(...hours!)).toBe(15);
    expect(Math.max(...minutes!)).toBe(30);
  });
});
