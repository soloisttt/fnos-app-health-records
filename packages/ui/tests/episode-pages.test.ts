import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/* 个别用例会把系统时间钉死；失败时也要还原，免得影响后面的用例 */
afterEach(() => {
  vi.useRealTimers();
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
        return { episode: { id: "ep-new", memberId: member.id, title: "10月呼吸道感染", status: "active", onsetAt: "2026-10-09" }, symptoms: [], medications: [], links: [], linkedFacts: [] };
      }
      if (path.startsWith("episodes/") && path.endsWith("/links")) {
        return { episode: { id: "ep-new", memberId: member.id, title: "10月呼吸道感染", status: "active", onsetAt: "2026-10-09" }, symptoms: [], medications: [], links: [], linkedFacts: [] };
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
      return { episode: { id: "ep-1", title: "10月呼吸道感染" }, symptoms: [], medications: [], links: [], linkedFacts: [] };
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
        return { episode: episodeRow, symptoms: [], medications: [], links: [], linkedFacts: [] };
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

  it("时间轴区分「随报告记入」与可单独移除的条目", async () => {
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
      linkCount: 2,
    };
    const baseFact = {
      reportId: "report-1",
      reportTitle: "急诊儿科门诊记录",
      hospitalName: "郑州市中心医院",
      occurredAt: "2026-10-09",
      missing: false,
    };
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?memberId")) return [episodeRow];
      if (path.startsWith("episodes/"))
        return {
          episode: episodeRow,
          symptoms: [],
          medications: [],
          links: [],
          linkedFacts: [
            {
              ...baseFact,
              linkId: "lnk-report",
              factType: "report",
              factId: "report-1",
              label: "急诊儿科门诊记录",
              detail: "报告",
              derived: false,
            },
            {
              ...baseFact,
              linkId: "derived:medication:m1",
              factType: "medication",
              factId: "m1",
              label: "复方氨酚甲麻口服液",
              detail: "4.5ml 口服 tid（每日三次）",
              derived: true,
            },
            {
              ...baseFact,
              linkId: "lnk-med",
              factType: "medication",
              factId: "m2",
              label: "氨溴特罗口服溶液",
              detail: "5ml 口服 bid（每日两次）",
              derived: false,
            },
          ],
        };
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    const eventOf = (text: string) =>
      wrapper.findAll(".episode-event").find((el) => el.text().includes(text))!;

    /* 同一次就诊合成一张卡片：报告、医院、用药都在里面，
       不再每个类型各占一行、各重复一遍「急诊儿科门诊记录 · 郑州市中心医院 · 日期」 */
    const visit = wrapper.find(".episode-visit");
    expect(visit.exists()).toBe(true);
    expect(visit.text()).toContain("急诊儿科门诊记录");
    expect(visit.text()).toContain("郑州市中心医院");
    /* 诊断与用药不再各自成节点，都收进卡片 */
    expect(wrapper.findAll(".episode-event--medication").length).toBe(0);
    expect(eventOf("急诊儿科门诊记录").text()).toBe(visit.text());

    const lineOf = (text: string) =>
      visit.findAll(".episode-visit-line").find((el) => el.text().includes(text))!;

    /* 由报告展开的用药：跟随报告，不提供单独移除 */
    const derivedLine = lineOf("复方氨酚甲麻口服液");
    expect(derivedLine.text()).toContain("4.5ml");
    expect(derivedLine.findAll("button.danger-action").length).toBe(0);

    /* 单独归集的用药：照旧可以单独移除 */
    const explicitLine = lineOf("氨溴特罗口服溶液");
    expect(explicitLine.findAll("button.danger-action").length).toBe(1);
  });

  it("病程详情可手动补录用药，且用药与症状用不同强调色区分", async () => {
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
      symptomCount: 1,
      linkCount: 0,
    };
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?memberId")) return [episodeRow];
      if (path.startsWith("episodes/"))
        return {
          episode: episodeRow,
          symptoms: [
            {
              id: "sym-1",
              episodeId: "ep-1",
              memberId: member.id,
              name: "咳嗽",
              onsetAt: "2026-10-09",
              durationText: null,
              severity: null,
              bodyPart: null,
              description: null,
              status: "present",
              source: "manual",
              reportId: null,
              evidence: [],
              manualFields: [],
            },
          ],
          medications: [
            {
              id: "med-1",
              episodeId: "ep-1",
              memberId: member.id,
              name: "氨溴特罗口服溶液",
              dose: "5ml",
              doseUnit: null,
              frequency: "bid",
              route: "口服",
              startAt: "2026-10-09",
              endAt: null,
              description: null,
              source: "manual",
              reportId: null,
              evidence: [],
              manualFields: [],
            },
          ],
          links: [],
          linkedFacts: [],
        };
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    /* 快速记录区提供「补充症状 / 补充用药」入口（日常记录不再跳大表单） */
    const quick = wrapper.find(".episode-quick-card");
    expect(quick.text()).toContain("补充症状");
    expect(quick.text()).toContain("补充用药");
    /* 已有的症状直接列出来，点一下就能记一次；时间轴头部只留图标按钮 */
    expect(quick.findAll(".episode-quick-chips button").some((button) => button.text() === "咳嗽")).toBe(true);
    expect(wrapper.find(".episode-timeline-intro").text()).not.toContain("添加用药");

    /* 用药与症状各成一种事件类型，样式里分别用蓝 / 橙强调色 */
    const medicationEvent = wrapper.find(".episode-event--medication");
    const symptomEvent = wrapper.find(".episode-event--symptom");
    expect(medicationEvent.exists()).toBe(true);
    expect(symptomEvent.exists()).toBe(true);
    expect(medicationEvent.classes()).not.toContain("episode-event--symptom");

    /* 手动补录的用药标明来源，并且可以单独删除 */
    expect(medicationEvent.text()).toContain("氨溴特罗口服溶液");
    expect(medicationEvent.text()).toContain("bid（每日两次）");
    expect(medicationEvent.text()).toContain("手动补录");
    expect(medicationEvent.find(".danger-action").exists()).toBe(true);
  });

  it("就诊卡片合并同一次就诊、缺口提示、发热小结与快捷记录", async () => {
    const episodeRow = {
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
      symptomCount: 2,
      linkCount: 2,
    };
    const reportFact = {
      reportId: "report-1",
      reportTitle: "急诊儿科门诊记录",
      hospitalName: "郑州市中心医院",
      departmentName: "急诊儿科",
      occurredAt: "2026-10-09",
      missing: false,
    };
    const symptom = (over: Record<string, unknown>) => ({
      id: "sym-x",
      episodeId: "ep-1",
      memberId: member.id,
      name: "咳嗽",
      onsetAt: "2026-10-09",
      durationText: null,
      severity: null,
      bodyPart: null,
      description: null,
      status: "present",
      source: "manual",
      reportId: null,
      evidence: [],
      manualFields: [],
      ...over,
    });
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?memberId")) return [episodeRow];
      if (path.startsWith("episodes/"))
        return {
          episode: episodeRow,
          symptoms: [
            symptom({
              id: "sym-fever",
              name: "发热",
              onsetAt: "2026-10-13 15:30",
              measuredValue: "38.5",
              measuredUnit: "℃",
            }),
            symptom({ id: "sym-cough", name: "咳嗽", source: "ai", reportId: "report-1" }),
            symptom({ id: "sym-nose", name: "鼻塞", onsetAt: "2026-10-13 16:30", status: "worse" }),
            /* 「消失 + 程度轻」：状态要读成「消失」，不能被程度里的「轻」盖过去 */
            symptom({ id: "sym-rash", name: "皮疹", onsetAt: "2026-10-13 17:00", severity: "轻", status: "resolved" }),
          ],
          medications: [],
          links: [],
          linkedFacts: [
            { ...reportFact, linkId: "lnk-report", factType: "report", factId: "report-1", label: "急诊儿科门诊记录", detail: "报告", derived: false },
            { ...reportFact, linkId: "derived:diagnosis:d1", factType: "diagnosis", factId: "d1", label: "呼吸道感染", detail: "诊断", derived: true },
          ],
        };
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    /* 一次就诊 = 一张卡片：医院 · 科室写进卡片头，诊断与症状列在卡片内 */
    const visit = wrapper.find(".episode-visit");
    expect(visit.exists()).toBe(true);
    expect(visit.text()).toContain("郑州市中心医院 · 急诊儿科");
    expect(visit.text()).toContain("呼吸道感染");
    expect(visit.text()).toContain("咳嗽");
    /* 有诊断却没抽到用药 → 主动提示核对，而不是默默留空 */
    expect(visit.find(".episode-visit-gaps").text()).toContain("有诊断，但没抽到用药");

    /* 发热小结：最高值一眼可见 */
    const fever = wrapper.find(".episode-fever-card");
    expect(fever.exists()).toBe(true);
    expect(fever.text()).toContain("38.5");
    expect(fever.text()).toContain("最高");

    /* 体温在时间轴上单独一套长相：数值大字 + 小单位，按高低上色（38.5 是「要不要吃退烧药」的门槛 → 红） */
    const feverEvent = wrapper.findAll(".episode-event").find((el) => el.text().includes("发热"))!;
    const figure = feverEvent.find(".episode-temp-figure");
    expect(figure.exists()).toBe(true);
    expect(figure.classes()).toContain("is-high");
    expect(figure.find(".episode-temp-figure-value").text()).toBe("38.5℃");
    /* 体温只关心数值与间隔，「存在 / 加重」这类状态对体温没有意义，不挂状态标签 */
    expect(feverEvent.find(".episode-status").exists()).toBe(false);

    /* 体温小结卡里带一条体温曲线；点时间轴上那个数字就滑过去看整条 */
    expect(fever.find(".episode-temp-curve").exists()).toBe(true);
    expect(fever.find(".episode-temp-curve-top").text()).toBe("38.5℃");
    if (typeof Element.prototype.scrollIntoView !== "function") {
      Element.prototype.scrollIntoView = () => {};
    }
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    await figure.trigger("click");
    expect(scrollSpy).toHaveBeenCalled();
    expect(wrapper.find(".episode-fever-card").classes()).toContain("is-focused");
    scrollSpy.mockRestore();
    /* 其他症状：状态单独渲染成加粗药丸，加重=红 */
    const worseEvent = wrapper.findAll(".episode-event").find((el) => el.text().includes("鼻塞"))!;
    expect(worseEvent.find(".episode-status-worse").text()).toBe("加重");
    /* 消失=灰底划线，且不会再和「程度」混成一行灰字 */
    const goneEvent = wrapper.findAll(".episode-event").find((el) => el.text().includes("皮疹"))!;
    expect(goneEvent.find(".episode-status-gone").text()).toBe("消失");
    /* 已经消失的症状不再显示「程度」：否则会出现「消失 · 轻」这种自相矛盾 */
    expect(goneEvent.text()).not.toContain("轻");

    /* 快速记录按钮用底色区分：记过的=绿底，没记过的=灰底 */
    const chipOf = (name: string) =>
      wrapper.findAll(".episode-quick-chips button").find((button) => button.text() === name)!;
    expect(chipOf("发热").classes()).toContain("is-recorded");
    expect(chipOf("流鼻涕").classes()).not.toContain("is-recorded");

    /* 分类筛选：只看「体温」时症状节点与就诊卡片都收起来 */
    const filterOf = (label: string) =>
      wrapper.findAll(".episode-filter button").find((button) => button.text().startsWith(label))!;
    expect(filterOf("全部").text()).toContain("全部");
    await filterOf("体温").trigger("click");
    await settle();
    expect(wrapper.find(".episode-event--symptom").exists()).toBe(false);
    expect(wrapper.find(".episode-visit").exists()).toBe(false);
    expect(wrapper.findAll(".episode-temp-figure").length).toBeGreaterThan(0);
    await filterOf("全部").trigger("click");
    await settle();
    expect(wrapper.find(".episode-visit").exists()).toBe(true);

    /* 点一下症状弹出小面板（时间已填当前时间、状态可点），不再跳大表单 */
    /* 面板 Teleport 到 body，取最后一个（同一测试里会连开两次） */
    const latestSheet = () => [...document.body.querySelectorAll(".episode-sheet")].at(-1)!;
    await chipOf("咳嗽").trigger("click");
    await settle();
    expect(latestSheet()).toBeTruthy();
    expect(latestSheet().textContent).toContain("记一次 · 咳嗽");
    /* 状态四个选项：存在 / 加重 / 减轻 / 消失 */
    const statusLabels = [...latestSheet().querySelectorAll(".episode-sheet-status-item")].map(
      (item) => item.textContent,
    );
    expect(statusLabels).toEqual(["存在", "加重", "减轻", "消失"]);
    /* 体温这类才有数值格 */
    expect(latestSheet().textContent).not.toContain("数值");

    /* 发热这类带数值的症状：面板里多一格「数值」 */
    await chipOf("发热").trigger("click");
    await settle();
    expect(latestSheet().textContent).toContain("记一次 · 发热");
    expect(latestSheet().textContent).toContain("数值");

    /* 给医生看的摘要：一键生成可复制的文字 */
    await wrapper.find('button[aria-label="给医生看的摘要"]').trigger("click");
    await settle();
    const summary = wrapper.find(".episode-summary-text");
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("就诊摘要");
    expect(summary.text()).toContain("张铭浩");
    expect(summary.text()).toContain("呼吸道感染");
    expect(summary.text()).toContain("受凉");

    /* 默认按症状归并：同名症状合成一条变化链，体温单独给出「最高 / 最近」 */
    const modeButtons = wrapper.findAll(".summary-mode button");
    expect(modeButtons.map((button) => button.text())).toEqual(["按症状", "按天"]);
    expect(wrapper.find(".summary-mode button.active").text()).toBe("按症状");
    expect(summary.text()).toContain("症状（4 个）");
    expect(summary.text()).toContain("发热：共 1 次");
    expect(summary.text()).toContain("最高 38.5℃");
    expect(summary.text()).toContain("皮疹：");
    expect(summary.text()).toContain("已消失");
    /* 医院、报告名、诊断分行写，不再挤成一行 */
    expect(summary.text()).toContain("郑州市中心医院 · 急诊儿科 ｜ 急诊儿科门诊记录");
    expect(summary.text()).toContain("诊断：呼吸道感染");

    /* 切成按天归组：天数按起病日推算，同一天的记录收在一天里 */
    await modeButtons[1]!.trigger("click");
    await settle();
    expect(wrapper.find(".summary-mode button.active").text()).toBe("按天");
    const dayText = wrapper.find(".episode-summary-text").text();
    expect(dayText).toContain("10-09（第 1 天）");
    expect(dayText).toMatch(/(今天|10-13)（第 5 天）/);

    /* 摘要面板很占位：点页面别处要自动收起来，但点面板里面不收 */
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();
    expect(wrapper.find(".episode-summary-text").exists()).toBe(false);

    /* 「病程信息」卡已去掉：「编辑」（起病日期 + 病因）、标记痊愈都收到标题区，状态做成标题旁药丸 */
    const intro = wrapper.find(".episode-detail-intro");
    expect(intro.exists()).toBe(true);
    expect(intro.text()).toContain("病因");
    expect(intro.text()).toContain("受凉");
    expect(intro.text()).toContain("编辑");
    expect(intro.text()).toContain("标记痊愈");
    expect(wrapper.find(".episode-title-chip").text()).toBe("进行中");
    expect(wrapper.find(".episode-info-line").exists()).toBe(false);
  });

  it("医生开的药点一下就记服药量，一句话记也直接入库（都不弹表单）", async () => {
    /* 这条用例跟「现在」有关：一句话记里的「三点五十」必须落在过去才允许入库
       （记录时间不能填到未来），而断言里又写死了 2026-10-13。
       把系统时间钉在那天的 15:55，否则每天 15:50 之前跑必红、日期一过更是必红。 */
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T15:55:00"));
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
      linkCount: 1,
    };
    const symptoms: Array<Record<string, unknown>> = [];
    const intakes: Array<Record<string, unknown>> = [];
    let seq = 0;
    const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
    const reportFact = {
      reportId: "report-1",
      reportTitle: "急诊儿科门诊记录",
      hospitalName: "郑州市中心医院",
      departmentName: "急诊儿科",
      occurredAt: "2026-10-09",
      missing: false,
    };
    const payload = () => ({
      episode: episodeRow,
      symptoms,
      medications: [],
      intakes,
      links: [],
      linkedFacts: [
        { ...reportFact, linkId: "lnk-report", factType: "report", factId: "report-1", label: "急诊儿科门诊记录", detail: "报告", derived: false },
        {
          ...reportFact,
          linkId: "derived:medication:m1",
          factType: "medication",
          factId: "m1",
          label: "氨溴特罗口服溶液",
          detail: "5ml 口服 bid（每日两次）",
          derived: true,
        },
      ],
    });
    mocked.request.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?memberId")) return [episodeRow];
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        posted.push({ path, body });
        seq += 1;
        if (path.endsWith("/intakes")) {
          intakes.push({
            id: `intake-${seq}`,
            episodeId: "ep-1",
            memberId: member.id,
            medicationName: body.medicationName,
            dose: body.dose ?? null,
            doseUnit: null,
            route: null,
            takenAt: body.takenAt ?? null,
            note: null,
            sourceReportId: body.sourceReportId ?? null,
            source: "manual",
            createdAt: "2026-10-13T00:00:00.000Z",
          });
        }
        return payload();
      }
      if (path.startsWith("episodes/")) return payload();
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    /* 医生开的药：蓝底；卡片里的用药只显示剂量用法，不再重复报告名与医院（卡片头已经有了） */
    const chipOf = (name: string) =>
      wrapper.findAll(".episode-quick-chips button").find((button) => button.text().includes(name))!;
    expect(chipOf("氨溴特罗口服溶液").classes()).toContain("is-medication");
    const visitText = wrapper.find(".episode-visit").text();
    expect(visitText).toContain("5ml 口服 bid（每日两次）");
    expect(visitText.split("急诊儿科门诊记录").length - 1).toBe(1);

    /* 医生开的药出现在快速记录里，点开是「记一次服药」，只要填个用量 */
    expect(chipOf("氨溴特罗口服溶液").exists()).toBe(true);
    await chipOf("氨溴特罗口服溶液").trigger("click");
    await settle();
    const latestSheet = () => [...document.body.querySelectorAll(".episode-sheet")].at(-1)!;
    expect(latestSheet().textContent).toContain("记一次服药 · 氨溴特罗口服溶液");

    /* 按类名取用量输入框：日期选择器改成输入框之后，"第一个 input" 不再是它 */
    const doseInput = latestSheet().querySelector<HTMLInputElement>(".episode-sheet-dose")!;
    doseInput.value = "4ml";
    doseInput.dispatchEvent(new Event("input"));
    await settle();
    latestSheet().querySelector<HTMLButtonElement>(".episode-sheet-save")!.click();
    await settle();

    expect(posted.at(-1)!.path).toContain("/intakes");
    expect(posted.at(-1)!.body.medicationName).toBe("氨溴特罗口服溶液");
    expect(posted.at(-1)!.body.dose).toBe("4ml");
    /* 时间轴出现「服药」节点，并留一条可点的提示 */
    const intakeEvent = wrapper.find(".episode-event--intake");
    expect(intakeEvent.exists()).toBe(true);
    expect(intakeEvent.text()).toContain("氨溴特罗口服溶液");
    expect(intakeEvent.text()).toContain("4ml");
    expect(wrapper.find(".episode-last-hint").text()).toContain("已记入服药");

    /* 一句话记：回车直接入库，不弹表单 */
    const sheetsBefore = document.body.querySelectorAll(".episode-sheet").length;
    await wrapper.find(".episode-quick-input input").setValue("三点五十吃氨溴特罗口服溶液5ml");
    await wrapper.find(".episode-quick-input input").trigger("keydown.enter");
    await settle();
    const last = posted.at(-1)!;
    expect(last.path).toContain("/intakes");
    expect(last.body.medicationName).toBe("氨溴特罗口服溶液");
    expect(last.body.dose).toBe("5ml");
    expect(last.body.takenAt).toBe("2026-10-13 15:50");
    expect(document.body.querySelectorAll(".episode-sheet").length).toBe(sheetsBefore);
    expect(wrapper.find(".episode-quick-input input").element.value).toBe("");
  });

  it("一句话记填了还没到的时间：提示就贴在输入框下面，也不入库", async () => {
    /* 以前这条提示抛到页面顶部，用户在下面根本看不见，只会以为「点了没反应」 */
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T15:55:00"));
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
    const posted: string[] = [];
    const payload = () => ({ episode: episodeRow, symptoms: [], medications: [], intakes: [], links: [], linkedFacts: [] });
    mocked.request.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (init?.method === "POST") {
        posted.push(path);
        return payload();
      }
      if (path.startsWith("episodes?")) return [episodeRow];
      if (path.startsWith("episodes/")) return payload();
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    /* 「晚上十点」= 今天 22:00，比现在的 15:55 晚 → 应该拦下来 */
    const input = wrapper.find(".episode-quick-input input");
    expect(wrapper.find(".quick-entry-error").exists()).toBe(false);
    await input.setValue("晚上十点体温37.5度");
    await input.trigger("keydown.enter");
    await settle();

    const hint = wrapper.find(".quick-entry-error");
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain("时间不能晚于现在");
    expect(posted).toEqual([]);
    /* 输的内容留着，用户只要把时间改一下，不用重打 */
    expect((input.element as HTMLInputElement).value).toBe("晚上十点体温37.5度");
    wrapper.unmount();
  });

  it("就医摘要两种排法：按症状归并 / 按天归组，同种药不重复出现", async () => {
    const episodeRow = {
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
      symptomCount: 4,
      linkCount: 2,
    };
    const symptom = (over: Record<string, unknown>) => ({
      id: "sym-x",
      episodeId: "ep-1",
      memberId: member.id,
      name: "咳嗽",
      onsetAt: "2026-10-09",
      durationText: null,
      severity: null,
      bodyPart: null,
      description: null,
      status: "present",
      source: "manual",
      reportId: null,
      evidence: [],
      manualFields: [],
      ...over,
    });
    const reportFact = {
      reportId: "report-1",
      reportTitle: "急诊儿科门诊记录",
      hospitalName: "郑州市中心医院",
      departmentName: "急诊儿科",
      occurredAt: "2026-10-09",
      missing: false,
    };
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?memberId")) return [episodeRow];
      if (path.startsWith("episodes/"))
        return {
          episode: episodeRow,
          symptoms: [
            symptom({ id: "s1", name: "咳嗽", onsetAt: "2026-10-09 08:00" }),
            symptom({ id: "s2", name: "体温", onsetAt: "2026-10-12 12:00", measuredValue: "37", measuredUnit: "℃" }),
            symptom({ id: "s3", name: "体温", onsetAt: "2026-10-13 15:50", measuredValue: "38.2", measuredUnit: "℃" }),
            symptom({ id: "s4", name: "咳嗽", onsetAt: "2026-10-13 19:32", status: "resolved" }),
          ],
          medications: [
            { id: "m1", episodeId: "ep-1", memberId: member.id, name: "氨溴特罗口服溶液", dose: "5", doseUnit: "ml", frequency: "bid", route: "口服", startAt: "2026-10-13", note: null, source: "manual", reportId: null, evidence: [], manualFields: [], createdAt: "", updatedAt: "" },
            { id: "m2", episodeId: "ep-1", memberId: member.id, name: "布洛芬混悬液", dose: "4", doseUnit: "ml", frequency: null, route: null, startAt: "2026-10-13", note: null, source: "manual", reportId: null, evidence: [], manualFields: [], createdAt: "", updatedAt: "" },
          ],
          intakes: [
            { id: "i1", episodeId: "ep-1", memberId: member.id, medicationName: "氨溴特罗口服溶液", dose: "5", doseUnit: "ml", route: null, takenAt: "2026-10-13 15:50", note: null, sourceReportId: null, source: "manual", createdAt: "", updatedAt: "" },
            { id: "i2", episodeId: "ep-1", memberId: member.id, medicationName: "氨溴特罗口服溶液", dose: "5", doseUnit: "ml", route: null, takenAt: "2026-10-13 17:27", note: null, sourceReportId: null, source: "manual", createdAt: "", updatedAt: "" },
          ],
          links: [],
          linkedFacts: [
            { ...reportFact, linkId: "lnk-report", factType: "report", factId: "report-1", label: "急诊儿科门诊记录", detail: "报告", derived: false },
            { ...reportFact, linkId: "derived:diagnosis:d1", factType: "diagnosis", factId: "d1", label: "呼吸道感染", detail: "诊断", derived: true },
            { ...reportFact, linkId: "derived:medication:rm1", factType: "medication", factId: "rm1", label: "氨溴特罗口服溶液", detail: "5ml 口服 bid（每日两次）", derived: true },
          ],
        };
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();
    await wrapper.find('button[aria-label="给医生看的摘要"]').trigger("click");
    await settle();

    const textOf = () => wrapper.find(".episode-summary-text").text();

    /* 按症状：咳嗽两次记录合成一条变化链，体温单独给出「最高 / 最近」 */
    const bySymptom = textOf();
    expect(bySymptom).toContain("症状（2 个）");
    expect(bySymptom).toContain("体温：共 2 次 ｜ 最高 38.2℃");
    expect(bySymptom).toContain("最近 38.2℃");
    /* 体温变化链里时间加括号（原来「37℃ 2026-10-12 12:00」挤在一起看不清） */
    expect(bySymptom).toMatch(/37℃（[^）]*12:00）/);
    expect(bySymptom).toMatch(/38\.2℃（[^）]*15:50）/);
    expect(bySymptom).not.toContain("37℃ 2026-10-12");
    /* 摘要里的体温数值要按高低上色 */
    expect(wrapper.findAll(".temperature-text .episode-temp").length).toBeGreaterThanOrEqual(2);
    expect(bySymptom).toContain("咳嗽：");
    expect(bySymptom).toContain("出现");
    expect(bySymptom).toContain("已消失");
    expect(bySymptom).toContain("→");
    /* 体温排在最前（儿科最关心） */
    expect(bySymptom.indexOf("体温：共")).toBeLessThan(bySymptom.indexOf("咳嗽："));
    /* 就诊拆两行：医院与报告名一行、诊断一行、开药一行 */
    expect(bySymptom).toContain("郑州市中心医院 · 急诊儿科 ｜ 急诊儿科门诊记录");
    expect(bySymptom).toContain("诊断：呼吸道感染");
    expect(bySymptom).toContain("开药：氨溴特罗口服溶液 5ml 口服 bid（每日两次）");
    /* 服药按药名归并成一行，共几次写在括号里 */
    expect(bySymptom).toContain("氨溴特罗口服溶液 5ml：");
    expect(bySymptom).toContain("（共 2 次）");
    /* 处方里的药 + 服药记录各出现一次；已经有服药记录的同名药不再重复列进「自行用药」 */
    expect(bySymptom.split("氨溴特罗口服溶液").length - 1).toBe(2);
    expect(bySymptom).toContain("自行用药：布洛芬混悬液 4ml");

    /* 按天：天数按起病日推算，同一天的记录收在一天里 */
    await wrapper.findAll(".summary-mode button")[1]!.trigger("click");
    await settle();
    const byDay = textOf();
    expect(byDay).toContain("10-09（第 1 天）");
    expect(byDay).toMatch(/(今天|10-13)（第 5 天）/);
    expect(byDay).toContain("服药 氨溴特罗口服溶液 5ml");
    expect(byDay).toContain("38.2℃");
    /* 时间轴与摘要都是「同一天里按时间」排，不会把昨天的记录混进今天 */
    expect(byDay.indexOf("10-09（第 1 天）")).toBeLessThan(byDay.indexOf("（第 5 天）"));
  });

  it("标题区按钮在状态药丸左边；痊愈后出现「痊愈总结」（吃药次数 / 症状变化 / 体温变化）", async () => {
    const row = {
      id: "ep-1",
      memberId: member.id,
      title: "10月呼吸道感染",
      status: "resolved",
      onsetAt: "2026-10-09",
      resolvedAt: "2026-10-13",
      causeText: "受凉",
      summary: null,
      createdBy: "user-a",
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
      symptomCount: 3,
      linkCount: 0,
    };
    const symptom = (over: Record<string, unknown>) => ({
      id: "sym-x",
      episodeId: "ep-1",
      memberId: member.id,
      name: "咳嗽",
      onsetAt: "2026-10-09 08:00",
      durationText: null,
      severity: null,
      bodyPart: null,
      description: null,
      status: "present",
      source: "manual",
      reportId: null,
      evidence: [],
      manualFields: [],
      ...over,
    });
    const intake = (id: string, takenAt: string) => ({
      id,
      episodeId: "ep-1",
      memberId: member.id,
      medicationName: "布洛芬混悬液",
      dose: "4",
      doseUnit: "ml",
      route: null,
      takenAt,
      note: null,
      sourceReportId: null,
      source: "manual",
      createdAt: "",
      updatedAt: "",
    });
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?memberId")) return [row];
      if (path.startsWith("episodes/"))
        return {
          episode: row,
          symptoms: [
            symptom({ id: "s1", name: "咳嗽", onsetAt: "2026-10-09 08:00" }),
            symptom({ id: "s2", name: "体温", onsetAt: "2026-10-12 12:00", measuredValue: "37", measuredUnit: "℃" }),
            symptom({ id: "s3", name: "体温", onsetAt: "2026-10-13 15:50", measuredValue: "38.5", measuredUnit: "℃" }),
            symptom({ id: "s4", name: "咳嗽", onsetAt: "2026-10-13 19:32", status: "resolved" }),
          ],
          medications: [],
          intakes: [intake("i1", "2026-10-13 15:50"), intake("i2", "2026-10-13 21:00")],
          links: [],
          linkedFacts: [],
        };
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    /* 「编辑 / 标记痊愈」进了标题行，排在状态药丸前面，不再挂在右上角那组里 */
    const title = wrapper.find(".episode-title");
    expect(title.exists()).toBe(true);
    const titleHtml = title.html();
    expect(titleHtml).toContain("编辑");
    expect(titleHtml).toContain("恢复进行中");
    expect(titleHtml.indexOf("编辑")).toBeLessThan(titleHtml.indexOf("episode-title-chip"));
    expect(titleHtml.indexOf("恢复进行中")).toBeLessThan(titleHtml.indexOf("episode-title-chip"));
    expect(wrapper.find(".episode-detail-actions").html()).not.toContain("编辑");
    expect(wrapper.find(".episode-title-chip").text()).toBe("已痊愈");

    /* 痊愈总结：吃了几次药、症状怎么变、体温怎么变 */
    const recap = wrapper.find(".episode-recap-card");
    expect(recap.exists()).toBe(true);
    expect(recap.text()).toContain("痊愈总结");
    expect(recap.text()).toContain("症状变化");
    expect(recap.text()).toContain("已消失");
    expect(recap.text()).toContain("体温变化");
    expect(recap.text()).toMatch(/38\.5℃（[^）]*15:50）/);
    expect(recap.text()).toContain("吃药");
    expect(recap.text()).toContain("共 2 次");
    expect(recap.text()).toContain("布洛芬混悬液");
    /* 体温数值按高低上色 */
    expect(recap.findAll(".episode-temp-high").length).toBeGreaterThan(0);
  });

  it("标题区的「编辑」能改起病日期（病因照旧能改）", async () => {
    const row = {
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
    };
    const puts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const payload = () => ({ episode: row, symptoms: [], medications: [], intakes: [], links: [], linkedFacts: [] });
    mocked.request.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (init?.method === "PUT") {
        puts.push({ path, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
        return payload();
      }
      if (path.startsWith("episodes?")) return [row];
      if (path.startsWith("episodes/")) return payload();
      return [];
    });
    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();
    await wrapper.find(".entry-row-open").trigger("click");
    await settle();

    /* 表单平时不展开 */
    expect(wrapper.find(".episode-cause-form").exists()).toBe(false);
    const editButton = wrapper.findAll(".episode-title-action").find((button) => button.text() === "编辑")!;
    expect(editButton).toBeTruthy();
    await editButton.trigger("click");
    await settle();

    const form = wrapper.find(".episode-cause-form");
    expect(form.exists()).toBe(true);
    const dateInput = form.find('input[aria-label="起病日期"]');
    expect(dateInput.exists()).toBe(true);
    expect((dateInput.element as HTMLInputElement).value).toBe("2026-10-09");

    await dateInput.setValue("2026-10-05");
    await dateInput.trigger("blur");
    await settle();
    await form.find('input[placeholder^="例如 受凉"]').setValue("着凉");
    await settle();
    await form.trigger("submit");
    await settle();

    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe("episodes/ep-1");
    expect(puts[0]!.body.onsetAt).toBe("2026-10-05");
    expect(puts[0]!.body.causeText).toBe("着凉");
    wrapper.unmount();
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
