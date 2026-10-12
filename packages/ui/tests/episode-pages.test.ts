import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { KeepAlive, Transition, defineComponent, h, nextTick, ref } from "vue";

/*
 * 回归测试：病程 / 疾病页面必须在 AppShell 的
 * <RouterView> → <Transition mode="out-in"> → <KeepAlive> 结构下正常渲染。
 *
 * 背景：路由页面的模板必须是单一根节点，否则外层过渡无法处理，
 * 切换页面后内容区会整片空白（且后续再点任何入口都一直空白）。
 */

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/utils/api", () => ({
  request: mocked.request,
  ApiRequestError: class extends Error { status = 0; },
}));

const account = { id: "user-a", authMode: "local", authenticated: true, mustChangePassword: false, isAdmin: true };
const member = { id: "member-1", displayName: "张铭浩", hidden: false, permission: "manager" };
const prefs = { selfMemberId: null, selfProfileChoice: "skipped", defaultMemberId: "member-1" };

beforeEach(() => {
  vi.resetModules();
  mocked.request.mockReset();
  localStorage.clear();
});

function stubApi() {
  mocked.request.mockImplementation(async (path: string) => {
    if (path === "session") return account;
    if (path === "members") return [member];
    if (path === "account/preferences") return prefs;
    if (path.startsWith("disease-catalog")) return [];
    if (path.startsWith("disease-records")) return [];
    if (path.startsWith("episode-search")) return [];
    if (path.startsWith("episodes")) return [];
    if (path.startsWith("reminders") || path.startsWith("notifications")) return [];
    return [];
  });
}

/** 复刻 AppShell 里页面挂载的那一层结构 */
function hostFor(pages: Record<string, unknown>, initial: string) {
  return defineComponent({
    setup() {
      const current = ref(pages[initial]);
      (globalThis as Record<string, unknown>).__switchPage = (name: string) => {
        current.value = pages[name];
      };
      return () =>
        h(Transition, { name: "page-fade", mode: "out-in" }, {
          default: () => h(KeepAlive, { key: "cache" }, { default: () => h(current.value as never) }),
        });
    },
  });
}

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountUnderShell(path: "diseases" | "episodes"): Promise<VueWrapper> {
  stubApi();
  const { useAppContext } = await import("../src/composables/useAppContext");
  const app = useAppContext();
  await app.load();
  app.selectedMemberId.value = member.id;

  const DiseasePage = (await import("../src/pages/DiseasePage.vue")).default;
  const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
  const wrapper = mount(hostFor({ diseases: DiseasePage, episodes: EpisodePage }, path));
  await settle();
  return wrapper;
}

async function switchTo(name: string) {
  const fn = (globalThis as Record<string, unknown>).__switchPage as (n: string) => void;
  fn(name);
  await settle();
}

describe("病程与疾病页面在 AppShell 结构下渲染", () => {
  it("疾病目录按分类分页签，默认显示诊断、可切到症状", async () => {
    stubApi();
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("disease-catalog"))
        return [
          { kind: "diagnosis", name: "呼吸道感染", count: 2, lastAt: "2026-10-09" },
          { kind: "symptom", name: "鼻塞流涕", count: 1, lastAt: "2026-10-09" },
        ];
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const DiseasePage = (await import("../src/pages/DiseasePage.vue")).default;
    const wrapper = mount(DiseasePage);
    await settle();

    const tabs = wrapper.findAll(".entry-tabs button");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].attributes("aria-pressed")).toBe("true");
    /* 每个方块都要有独立的「隐藏」按钮，且与主体按钮平级（按钮不能嵌套按钮） */
    expect(wrapper.findAll(".entry-tile")).toHaveLength(1);
    expect(wrapper.findAll(".entry-tile-main")).toHaveLength(1);
    expect(wrapper.findAll(".entry-tile-remove")).toHaveLength(1);
    expect(wrapper.html()).toContain("呼吸道感染");
    expect(wrapper.html()).not.toContain("鼻塞流涕");

    await tabs[1].trigger("click");
    await settle();
    expect(tabs[1].attributes("aria-pressed")).toBe("true");
    expect(wrapper.html()).toContain("鼻塞流涕");
    expect(wrapper.html()).not.toContain("呼吸道感染");
  });

  it("「加入病程」弹窗采用与校对弹窗一致的版式（标题图标+说明、按钮居右）", async () => {
    stubApi();
    const Linker = (await import("../src/components/ReportEpisodeLinker.vue")).default;
    const wrapper = mount(Linker, {
      props: { open: false, reportId: "report-1", memberId: member.id },
      attachTo: document.body,
    });
    await wrapper.setProps({ open: true });
    await settle();

    const panel = document.querySelector(".episode-linker");
    expect(panel, "弹窗应使用统一的 .episode-linker 版式").toBeTruthy();
    expect(document.querySelector(".episode-linker-backdrop")).toBeTruthy();
    expect(document.querySelector(".episode-linker-body")).toBeTruthy();
    const footer = document.querySelector(".episode-linker-footer");
    expect(footer).toBeTruthy();
    expect(footer?.textContent).toContain("新建病程");
    expect(panel?.querySelector("header")?.textContent).toContain("加入病程");
    wrapper.unmount();
  });

  it("病程列表每条都有独立删除按钮，且不与打开条目的按钮嵌套", async () => {
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes"))
        return [
          {
            id: "ep-1",
            memberId: member.id,
            title: "10月呼吸道感染",
            status: "active",
            onsetAt: "2026-10-09",
            resolvedAt: null,
            causeText: "受凉",
            summary: null,
            createdBy: "user-a",
            createdAt: "2026-10-09T00:00:00.000Z",
            updatedAt: "2026-10-09T00:00:00.000Z",
            symptomCount: 0,
            linkCount: 0,
          },
        ];
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();

    expect(wrapper.findAll(".entry-row-open")).toHaveLength(1);
    expect(wrapper.findAll(".entry-row-remove")).toHaveLength(1);
    /* 按钮不能嵌套按钮：删除按钮必须是打开按钮的兄弟节点 */
    expect(wrapper.find(".entry-row-open .entry-row-remove").exists()).toBe(false);
    expect(wrapper.html()).toContain("10月呼吸道感染");
  });

  it("疾病页在过渡层内能渲染出内容", async () => {
    const wrapper = await mountUnderShell("diseases");
    const html = wrapper.html();
    expect(html).toContain("疾病");
    expect(html.length).toBeGreaterThan(50);
  });

  it("病程页在过渡层内能渲染出内容", async () => {
    const wrapper = await mountUnderShell("episodes");
    const html = wrapper.html();
    expect(html).toContain("病程");
    expect(html.length).toBeGreaterThan(50);
  });

  it("从疾病切到病程后内容仍存在（out-in 过渡不会卡空白）", async () => {
    const wrapper = await mountUnderShell("diseases");
    expect(wrapper.html()).toContain("疾病");
    await switchTo("episodes");
    const html = wrapper.html();
    expect(html).toContain("病程");
    expect(html.length).toBeGreaterThan(50);
  });
});
