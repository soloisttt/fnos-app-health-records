import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { mount, RouterLinkStub } from "@vue/test-utils";
import SettingsPage from "../src/pages/SettingsPage.vue";
import MaintenanceSettingsPage from "../src/pages/settings/MaintenanceSettingsPage.vue";

const { useAppContext } = vi.hoisted(() => ({ useAppContext: vi.fn() }));
vi.mock("../src/composables/useAppContext", () => ({ useAppContext }));

vi.mock("../src/composables/useTheme", () => ({ useTheme: () => ({ setting: ref("system") }) }));

function render(isAdmin: boolean) {
  useAppContext.mockReturnValue({ session: ref({ isAdmin }) });
  return mount(MaintenanceSettingsPage, {
    global: { stubs: { RouterLink: RouterLinkStub, SubPageHeader: true } }
  });
}

describe("maintenance navigation permissions", () => {
  it("keeps member tools accessible without exposing administrator operations", () => {
    const wrapper = render(false);
    expect(wrapper.findAllComponents(RouterLinkStub).map(link => link.props("to")))
      .toEqual(["/me/duplicates"]);
    expect(wrapper.findAll("button")).toHaveLength(0);
    expect(wrapper.text()).not.toContain("日志与诊断");
    expect(wrapper.text()).not.toContain("检查与修复");
  });

  it("provides all three groups and existing tools to administrators", () => {
    const wrapper = render(true);
    expect(wrapper.findAllComponents(RouterLinkStub).map(link => link.props("to")))
      .toEqual(["/me/data", "/me/maintenance/member-merges", "/me/duplicates", "/me/maintenance/indicators", "/me/system-logs", "/me/audit", "/me/ai-audit"]);
    expect(wrapper.text()).toContain("检查与修复");
    expect(wrapper.findAll("button").map(button => button.text())).toEqual(["重新关联", "重新生成"]);
  });
});

 describe("personal menu", () => {
  for (const isAdmin of [false, true]) {
    it(`shows the appropriate entry for ${isAdmin ? "administrators" : "members"}`, () => {
      useAppContext.mockReturnValue({ session: ref({ isAdmin }), selectedMember: ref(null), pendingReminderCount: ref(0) });
      const wrapper = mount(SettingsPage, { global: { stubs: { RouterLink: RouterLinkStub, FormSelect: true, MemberSwitcher: true } } });
      const paths = wrapper.findAllComponents(RouterLinkStub).map(link => link.props("to"));
      expect(paths.includes("/me/maintenance")).toBe(isAdmin);
      expect(paths.includes("/me/duplicates")).toBe(!isAdmin);
      expect(paths).not.toContain("/me/data");
      expect(paths).toContain("/me/trash");
    });
  }
});
