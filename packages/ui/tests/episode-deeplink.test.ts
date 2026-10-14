import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

/*
 * 概览页点「进行中的病程」会带 `?episode=<id>` 过来，病程页要**直接展开那一条**，
 * 而不是让用户进了列表再自己找。
 */

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/utils/api", () => ({
  request: mocked.request,
  ApiRequestError: class extends Error { status = 0; },
}));
/* 只替掉 useRoute，其余（RouterLink 等）保持原样 */
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return { ...actual, useRoute: () => ({ query: { episode: "ep-2" } }) };
});

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

const row = (id: string, title: string) => ({
  id,
  memberId: member.id,
  title,
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
});

describe("带 ?episode= 进病程页", () => {
  it("直接展开链接指定的那一条，而不是停在列表", async () => {
    const list = [row("ep-1", "第一条病程"), row("ep-2", "第二条病程")];
    const detailCalls: string[] = [];
    mocked.request.mockImplementation(async (path: string) => {
      if (path === "session") return account;
      if (path === "members") return [member];
      if (path === "account/preferences") return prefs;
      if (path.startsWith("episodes?")) return list;
      if (path.startsWith("episodes/")) {
        detailCalls.push(path);
        return { episode: list[1], symptoms: [], medications: [], intakes: [], links: [], linkedFacts: [] };
      }
      return [];
    });

    const { useAppContext } = await import("../src/composables/useAppContext");
    const app = useAppContext();
    await app.load();
    app.selectedMemberId.value = member.id;

    const EpisodePage = (await import("../src/pages/EpisodePage.vue")).default;
    const wrapper = mount(EpisodePage);
    await settle();

    expect(detailCalls).toContain("episodes/ep-2");
    expect(wrapper.find(".episode-title-text").text()).toBe("第二条病程");
    wrapper.unmount();
  });
});
