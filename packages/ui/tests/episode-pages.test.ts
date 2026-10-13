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

    /* 体温在时间轴上直接显示数值并按高低上色：38.5 是「要不要吃退烧药」的门槛 → 红 */
    const feverEvent = wrapper.findAll(".episode-event").find((el) => el.text().includes("发热"))!;
    expect(feverEvent.find(".episode-temp").text()).toBe("38.5℃");
    expect(feverEvent.find(".episode-temp-high").exists()).toBe(true);

    /* 快速记录：点一下症状弹出小面板（时间已填当前时间、状态可点），不再跳大表单 */
    const chipOf = (name: string) =>
      wrapper.findAll(".episode-quick-chips button").find((button) => button.text() === name)!;
    /* 面板 Teleport 到 body，取最后一个（同一测试里会连开两次） */
    const latestSheet = () => [...document.body.querySelectorAll(".episode-sheet")].at(-1)!;
    expect(chipOf("发热").exists()).toBe(true);
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
  });

  it("医生开的药点一下就记服药量，一句话记也直接入库（都不弹表单）", async () => {
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

    /* 医生开的药出现在快速记录里，点开是「记一次服药」，只要填个用量 */
    const chipOf = (name: string) =>
      wrapper.findAll(".episode-quick-chips button").find((button) => button.text().includes(name))!;
    expect(chipOf("氨溴特罗口服溶液").exists()).toBe(true);
    await chipOf("氨溴特罗口服溶液").trigger("click");
    await settle();
    const latestSheet = () => [...document.body.querySelectorAll(".episode-sheet")].at(-1)!;
    expect(latestSheet().textContent).toContain("记一次服药 · 氨溴特罗口服溶液");

    const doseInput = latestSheet().querySelectorAll<HTMLInputElement>("input")[0]!;
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
