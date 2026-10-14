import { describe, expect, it } from "vitest";
import { mount, RouterLinkStub } from "@vue/test-utils";
import CaseViewTabs from "../src/components/CaseViewTabs.vue";

/*
 * 疾病并进了病程页当「按病看」：两个页面顶部放的是同一排切换条，
 * 而且仍然用老地址（/episodes、/diseases）—— 老链接、收藏、分享都不能失效。
 */
describe("按次看 / 按病看 的切换条", () => {
  it("两个视角都指向老地址，方便收藏和分享", () => {
    const wrapper = mount(CaseViewTabs, { global: { stubs: { RouterLink: RouterLinkStub } } });
    const links = wrapper.findAllComponents(RouterLinkStub);
    expect(links.map((link) => link.props("to"))).toEqual(["/episodes", "/diseases"]);
    expect(wrapper.text()).toContain("按次看");
    expect(wrapper.text()).toContain("按病看");
  });

  it("拿不到 route 时（测试环境 / 没有 router）默认点亮「按次看」，不报错", () => {
    const wrapper = mount(CaseViewTabs, { global: { stubs: { RouterLink: RouterLinkStub } } });
    const tabs = wrapper.findAll(".case-view-tab");
    expect(tabs[0]!.classes()).toContain("is-active");
    expect(tabs[1]!.classes()).not.toContain("is-active");
  });
});
