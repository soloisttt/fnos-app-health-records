import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";

/*
 * 概览页原先只汇总报告；现在要同时能看到「正在生病中」和「常犯什么病」。
 * 病程与疾病目录走既有接口，取不到时（服务端版本较旧）也不能拖垮整个概览。
 */

/* RouterLink 的替身：渲染成 <a>，把目标路径与参数放进 data-*，方便断言"整行可点、点到哪" */
const RouterLinkStub = defineComponent({
  props: { to: { type: [String, Object], default: "" } },
  setup(props, { slots }) {
    const target = typeof props.to === "string" ? { path: props.to, query: {} } : (props.to as Record<string, unknown>);
    return () =>
      h(
        "a",
        {
          class: "router-link-stub",
          "data-path": String(target.path ?? ""),
          "data-query": JSON.stringify(target.query ?? {}),
        },
        slots.default?.(),
      );
  },
});

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

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const episode = (over: Record<string, unknown>) => ({
  id: "ep-x",
  memberId: member.id,
  title: "病程",
  status: "active",
  onsetAt: "2026-10-09",
  resolvedAt: null,
  causeText: null,
  summary: null,
  createdBy: "user-a",
  createdAt: "",
  updatedAt: "",
  symptomCount: 0,
  linkCount: 0,
  ...over,
});

function stubApi(over: { episodes?: unknown[]; catalog?: unknown[]; stats?: Record<string, unknown> } = {}) {
  mocked.request.mockImplementation(async (path: string) => {
    if (path === "session") return account;
    if (path === "members") return [member];
    if (path === "account/preferences") return prefs;
    if (path.startsWith("overview?"))
      return {
        stats: {
          totalReports: 3,
          readyReports: 2,
          needsReviewReports: 1,
          processingReports: 0,
          failedReports: 0,
          totalPages: 8,
          observationCount: 40,
          abnormalObservationCount: 5,
          latestReportIssuedAt: "2026-10-09",
          ...over.stats,
        },
        pendingReminders: [],
        recentReadyReports: [],
        unfiledReports: [],
      };
    if (path.startsWith("episodes?")) return over.episodes ?? [];
    if (path.startsWith("disease-catalog?")) return over.catalog ?? [];
    if (path.startsWith("reminders") || path.startsWith("notifications")) return [];
    return [];
  });
}

async function mountOverview() {
  const { useAppContext } = await import("../src/composables/useAppContext");
  const app = useAppContext();
  await app.load();
  app.selectedMemberId.value = member.id;

  const OverviewPage = (await import("../src/pages/OverviewPage.vue")).default;
  /* EmptyState 不能被 shallowMount 桩掉，否则空状态的文案不参与 text() 断言 */
  const wrapper = shallowMount(OverviewPage, {
    global: { stubs: { RouterLink: RouterLinkStub, EmptyState: false } },
  });
  await settle();
  return wrapper;
}

describe("概览页除了报告也汇总疾病与病程", () => {
  it("列出进行中的病程与常见疾病，已痊愈的病程不进「进行中」", async () => {
    stubApi({
      episodes: [
        episode({ id: "ep-1", title: "10月呼吸道感染", symptomCount: 3, linkCount: 1 }),
        episode({ id: "ep-2", title: "幼儿急疹", status: "resolved", resolvedAt: "2026-09-25" }),
      ],
      catalog: [
        { kind: "diagnosis", name: "呼吸道感染", count: 3, lastAt: "2026-10-09" },
        { kind: "diagnosis", name: "支气管炎", count: 2, lastAt: "2026-09-20" },
        { kind: "symptom", name: "咳嗽", count: 5, lastAt: "2026-10-09" },
      ],
    });
    const wrapper = await mountOverview();
    const text = wrapper.text();

    expect(text).toContain("进行中的病程");
    expect(text).toContain("10月呼吸道感染");
    expect(text).toContain("2026-10-09 起 · 3 个症状 · 1 次就诊");
    /* 已痊愈的不算「进行中」 */
    expect(text).not.toContain("幼儿急疹");

    expect(text).toContain("常见疾病");
    expect(text).toContain("呼吸道感染");
    expect(text).toContain("3 次 · 最近 2026-10-09");
    /* 「常见疾病」只列诊断，症状归疾病目录的症状页签 */
    expect(text).not.toContain("咳嗽");
    wrapper.unmount();
  });

  it("两块都没有内容时给出空提示，而不是整卡消失", async () => {
    stubApi();
    const wrapper = await mountOverview();
    const text = wrapper.text();

    expect(text).toContain("进行中的病程");
    expect(text).toContain("暂无进行中的病程");
    expect(text).toContain("常见疾病");
    expect(text).toContain("暂无诊断记录");
    wrapper.unmount();
  });

  it("病程或疾病目录接口取不到时，概览的其余部分照常显示", async () => {
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?") || path.startsWith("disease-catalog?")) throw new Error("旧版服务端没有这个接口");
      if (path.startsWith("overview?"))
        return {
          stats: {
            totalReports: 3,
            readyReports: 2,
            needsReviewReports: 1,
            processingReports: 0,
            failedReports: 0,
            totalPages: 8,
            observationCount: 40,
            abnormalObservationCount: 5,
            latestReportIssuedAt: "2026-10-09",
          },
          pendingReminders: [],
          recentReadyReports: [],
          unfiledReports: [],
        };
      return [];
    });
    const wrapper = await mountOverview();

    expect(wrapper.find(".overview-stats").exists()).toBe(true);
    expect(wrapper.find(".inline-panel-error").exists()).toBe(false);
    expect(wrapper.text()).toContain("最近报告");
    expect(wrapper.text()).toContain("暂无进行中的病程");
    wrapper.unmount();
  });
});

/*
 * 「还没有健康档案」的空状态原来只看报告数。刚配好、只记了症状还没拍照上传的家庭，
 * 一进概览就看到这句，会以为数据没存进去。
 */
describe("概览的空状态不只看报告", () => {
  const noReports = { totalReports: 0, readyReports: 0, needsReviewReports: 0, latestReportIssuedAt: null };

  it("没有报告、但有进行中的病程时，照常展示病程，不喊「还没有健康档案」", async () => {
    stubApi({
      stats: noReports,
      episodes: [episode({ id: "ep-1", title: "10月呼吸道感染", symptomCount: 2 })],
    });
    const wrapper = await mountOverview();
    const text = wrapper.text();

    expect(text).not.toContain("还没有健康档案");
    expect(text).toContain("10月呼吸道感染");
    expect(wrapper.find(".overview-stats").exists()).toBe(true);
    wrapper.unmount();
  });

  it("没有报告、只有疾病目录记录时同理", async () => {
    stubApi({ stats: noReports, catalog: [{ kind: "diagnosis", name: "支气管炎", count: 1, lastAt: "2026-09-20" }] });
    const wrapper = await mountOverview();

    expect(wrapper.text()).not.toContain("还没有健康档案");
    expect(wrapper.text()).toContain("支气管炎");
    wrapper.unmount();
  });

  it("确实什么都没有（没报告也没病程/疾病）时才显示空状态", async () => {
    stubApi({ stats: noReports });
    const wrapper = await mountOverview();

    expect(wrapper.text()).toContain("还没有健康档案");
    wrapper.unmount();
  });
});

/* 以前只有右边那个小小的「查看」能点，很容易点不中 */
describe("概览里的卡片整行可点", () => {
  it("「进行中的病程」点哪都能进去，并带上 ?episode= 直接展开那一条", async () => {
    stubApi({ episodes: [episode({ id: "ep-7", title: "10月呼吸道感染", symptomCount: 2 })] });
    const wrapper = await mountOverview();

    const row = wrapper.findAll("a.overview-row").find((item) => item.attributes("data-path") === "/episodes");
    expect(row).toBeTruthy();
    expect(row!.text()).toContain("10月呼吸道感染");
    /* 「查看」还在，但只是行内的一句提示，整行都是链接 */
    expect(row!.text()).toContain("查看");
    expect(JSON.parse(row!.attributes("data-query")!)).toEqual({ episode: "ep-7" });
    wrapper.unmount();
  });

  it("「常见疾病」也是整行可点", async () => {
    stubApi({ catalog: [{ kind: "diagnosis", name: "支气管炎", count: 2, lastAt: "2026-09-20" }] });
    const wrapper = await mountOverview();

    const row = wrapper.findAll("a.overview-row").find((item) => item.attributes("data-path") === "/diseases");
    expect(row).toBeTruthy();
    expect(row!.text()).toContain("支气管炎");
    wrapper.unmount();
  });
});
