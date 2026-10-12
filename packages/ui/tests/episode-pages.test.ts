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

  it("「创建并加入」必须同时完成新建与挂载（不能被自身的防重复锁挡住）", async () => {
    const calls: string[] = [];
    mocked.request.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.startsWith("episodes?memberId")) return [];
      if (path === "episodes") {
        return { episode: { id: "ep-new", memberId: member.id, title: "10月呼吸道感染", status: "active", onsetAt: "2026-10-09" }, symptoms: [], links: [], linkedFacts: [] };
      }
      if (path.startsWith("episodes/") && path.endsWith("/links")) {
        return { episode: { id: "ep-new", memberId: member.id, title: "10月呼吸道感染", status: "active", onsetAt: "2026-10-09" }, symptoms: [], links: [], linkedFacts: [] };
      }
      return [];
    });

    const Linker = (await import("../src/components/ReportEpisodeLinker.vue")).default;
    const wrapper = mount(Linker, {
      props: { open: false, reportId: "report-1", memberId: member.id },
      attachTo: document.body,
    });
    await wrapper.setProps({ open: true });
    await settle();

    const footerButton = (text: string) =>
      [...document.querySelectorAll(".episode-linker-footer button")].find((el) =>
        el.textContent?.includes(text),
      ) as HTMLButtonElement | undefined;

    footerButton("新建病程")!.click();
    await settle();

    const input = document.querySelector(".episode-linker-body input") as HTMLInputElement;
    input.value = "10月呼吸道感染";
    input.dispatchEvent(new Event("input"));
    await settle();

    footerButton("创建并加入")!.click();
    await settle();

    expect(calls).toContain("POST episodes");
    expect(
      calls.some((call) => call.startsWith("POST episodes/") && call.endsWith("/links")),
      "新建之后必须继续把报告挂上去",
    ).toBe(true);
    wrapper.unmount();
  });

  it("同名同起病日期的病程已存在时，创建并加入改为复用而不是再建一条", async () => {
    const calls: string[] = [];
    mocked.request.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.startsWith("episodes?memberId")) {
        return [
          {
            id: "ep-1",
            memberId: member.id,
            title: "10月呼吸道感染",
            status: "active",
            onsetAt: "2026-10-09",
            resolvedAt: null,
            causeText: null,
            summary: null,
            createdBy: "user-a",
            createdAt: "2026-10-09T00:00:00.000Z",
            updatedAt: "2026-10-09T00:00:00.000Z",
            symptomCount: 0,
            linkCount: 0,
          },
        ];
      }
      return { episode: { id: "ep-1", title: "10月呼吸道感染" }, symptoms: [], links: [], linkedFacts: [] };
    });

    /* 真实路径：弹窗会用报告的诊断与日期预填标题与起病日期 */
    const Linker = (await import("../src/components/ReportEpisodeLinker.vue")).default;
    const wrapper = mount(Linker, {
      props: {
        open: false,
        reportId: "report-1",
        memberId: member.id,
        suggestTitle: "10月呼吸道感染",
        suggestOnsetAt: "2026-10-09",
      },
      attachTo: document.body,
    });
    await wrapper.setProps({ open: true });
    await settle();

    const footerButton = (text: string) =>
      [...document.querySelectorAll(".episode-linker-footer button")].find((el) =>
        el.textContent?.includes(text),
      ) as HTMLButtonElement | undefined;

    footerButton("新建病程")!.click();
    await settle();
    footerButton("创建并加入")!.click();
    await settle();

    expect(calls, "已有同名同起病日期的病程，不应再建一条").not.toContain("POST episodes");
    expect(
      calls.some((call) => call.includes("episodes/ep-1/links")),
      "应直接挂到已有病程上",
    ).toBe(true);
    wrapper.unmount();
  });

  it("切回病程页会重新拉取列表（KeepAlive 缓存下不会一直显示旧数据）", async () => {
    const wrapper = await mountUnderShell("episodes");
    const countList = () =>
      mocked.request.mock.calls.filter(([path]) => String(path).startsWith("episodes?")).length;
    const before = countList();
    await switchTo("diseases");
    await switchTo("episodes");
    expect(countList()).toBeGreaterThan(before);
  });

  it("疾病下钻的头部带移动端保留标记，返回按钮不会被隐藏", async () => {
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("disease-catalog"))
        return [{ kind: "diagnosis", name: "呼吸道感染", count: 1, lastAt: "2026-10-09" }];
      if (path.startsWith("disease-records")) return [];
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const DiseasePage = (await import("../src/pages/DiseasePage.vue")).default;
    const wrapper = mount(DiseasePage);
    await settle();
    await wrapper.find(".entry-tile-main").trigger("click");
    await settle();

    /* 移动端 CSS 会隐藏 .page-intro，下钻头部必须带 --keep 才不会被一起藏掉 */
    const header = wrapper.find(".page-intro--keep");
    expect(header.exists(), "疾病下钻头部应带 page-intro--keep").toBe(true);
    expect(header.text()).toContain("返回");
  });

  it("病程列表与详情的头部都带移动端保留标记", async () => {
    const episodeRow = {
      id: "ep-1",
      memberId: member.id,
      title: "10月呼吸道感染",
      status: "active",
      onsetAt: "2026-10-09",
      resolvedAt: null,
      causeText: null,
      summary: null,
      createdBy: "user-a",
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
      symptomCount: 0,
      linkCount: 0,
    };
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?memberId")) return [episodeRow];
      if (path.startsWith("episodes/"))
        return { episode: episodeRow, symptoms: [], links: [], linkedFacts: [] };
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();

    /* 列表视图：标题与顶栏重复，移动端只保留「新建病程」按钮 */
    const listHeader = wrapper.find(".page-intro--keep");
    expect(listHeader.exists(), "病程列表头部应带 page-intro--keep").toBe(true);
    expect(listHeader.classes()).toContain("page-intro--actions-only");
    expect(listHeader.text()).toContain("新建病程");

    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    /* 详情视图：标题与返回入口都要保留 */
    const detailHeader = wrapper.find(".page-intro--keep");
    expect(detailHeader.exists(), "病程详情头部应带 page-intro--keep").toBe(true);
    expect(detailHeader.text()).toContain("返回");
    expect(detailHeader.text()).toContain("10月呼吸道感染");
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
