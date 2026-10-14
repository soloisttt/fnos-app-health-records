import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TemperatureCurve from "../src/components/TemperatureCurve.vue";
import type { TemperatureLevel } from "../src/utils/temperature";

/*
 * 体温在时间轴上「单开一套长相」，点一下就滑到这里看整条曲线。
 * 曲线是纯 SVG 画的（不引图表库），所以这里守的是：点、折线、两条参考线、最高值标注。
 */

const point = (at: string, reading: string, level: TemperatureLevel) => ({ at, reading, level });

describe("体温曲线", () => {
  it("每个读数画一个点，并按高低上色", () => {
    const wrapper = mount(TemperatureCurve, {
      props: {
        points: [
          point("2026-10-12 08:00", "36.8", "normal"),
          point("2026-10-13 15:30", "38.5", "high"),
          point("2026-10-13 23:00", "37.6", "mid"),
        ],
      },
    });

    /* 3 个读数 + 最高点再叠一个圈 */
    expect(wrapper.findAll(".episode-temp-curve-dot").length).toBe(4);
    expect(wrapper.find(".episode-temp-curve-dot.is-normal").exists()).toBe(true);
    expect(wrapper.find(".episode-temp-curve-dot.is-mid").exists()).toBe(true);
    expect(wrapper.find(".episode-temp-curve-dot.is-high").exists()).toBe(true);
    expect(wrapper.find(".episode-temp-curve-top").text()).toBe("38.5℃");
  });

  it("两点以上连成折线，并画出 37.5 / 38.5 两条参考线", () => {
    const wrapper = mount(TemperatureCurve, {
      props: {
        points: [point("2026-10-12 08:00", "36.8", "normal"), point("2026-10-13 15:30", "38.5", "high")],
      },
    });

    const line = wrapper.find(".episode-temp-curve-line");
    expect(line.exists()).toBe(true);
    expect(line.attributes("points")?.split(" ").length).toBe(2);
    expect(wrapper.findAll(".episode-temp-curve-guide").length).toBe(2);

    const axisLabels = wrapper.findAll(".episode-temp-curve-axis").map((item) => item.text());
    expect(axisLabels).toContain("37.5");
    expect(axisLabels).toContain("38.5");
    /* 首尾时间标在横轴上 */
    expect(axisLabels).toContain("10-12 08:00");
    expect(axisLabels).toContain("10-13 15:30");
  });

  it("只记了一次时不连线，点与最高值标注照旧", () => {
    const wrapper = mount(TemperatureCurve, { props: { points: [point("2026-10-13 15:30", "38.5", "high")] } });
    expect(wrapper.find(".episode-temp-curve-line").exists()).toBe(false);
    expect(wrapper.findAll(".episode-temp-curve-dot").length).toBe(2);
  });

  it("没有读数时整张图是空的，不报错", () => {
    const wrapper = mount(TemperatureCurve, { props: { points: [] } });
    expect(wrapper.findAll(".episode-temp-curve-dot").length).toBe(0);
    expect(wrapper.find(".episode-temp-curve-line").exists()).toBe(false);
  });

  it("无障碍：说明了共几次、最高多少", () => {
    const wrapper = mount(TemperatureCurve, {
      props: {
        points: [point("2026-10-12 08:00", "36.8", "normal"), point("2026-10-13 15:30", "38.5", "high")],
      },
    });
    expect(wrapper.attributes("aria-label")).toBe("这次生病的体温曲线，共 2 次记录，最高 38.5℃");
  });
});
