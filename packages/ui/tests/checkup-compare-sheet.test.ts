import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/utils/api", () => ({
  request: mocked.request,
  ApiRequestError: class extends Error { status = 0; },
}));

/*
 * 体检是同一套项目反复做，单看一次没有意义 —— 「与上次对比」才是这份报告的价值所在。
 * 这里盯两件事：逐项显示上次的值 + 箭头；变差的排最前面（打开就知道该看哪儿）。
 */
const comparison = {
  report: { id: "new", title: "年度体检", issuedAt: "2026-09-20" },
  previous: { id: "old", title: "入园体检", issuedAt: "2026-03-08" },
  summary: { total: 2, better: 0, worse: 1, worseNames: ["白细胞"] },
  items: [
    { name: "血红蛋白", unit: "g/L", current: "118", previous: "124", direction: "down", abnormal: false, previousAbnormal: false, trend: "flat" },
    { name: "白细胞", unit: "10^9/L", current: "12.5", previous: "7.2", direction: "up", abnormal: true, previousAbnormal: false, trend: "worse" },
  ],
};

const wrappers: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = "";
  mocked.request.mockReset();
});

async function open(payload: unknown) {
  mocked.request.mockResolvedValue(payload);
  const Sheet = (await import("../src/components/CheckupCompareSheet.vue")).default;
  const wrapper = mount(Sheet, { attachTo: document.body, props: { open: true, reportId: "new" } });
  wrappers.push(wrapper);
  await nextTick();
  await nextTick();
  return wrapper;
}

describe("体检「与上次对比」弹层", () => {
  it("逐项给出上次的值和箭头，变差的排最前面", async () => {
    await open(comparison);

    const rows = [...document.body.querySelectorAll(".checkup-compare-row")];
    expect(rows.length).toBe(2);
    /* 变差的那项排第一，一眼就看到 */
    expect(rows[0]!.textContent).toContain("白细胞");
    expect(rows[0]!.classList.contains("is-worse")).toBe(true);
    expect(rows[0]!.textContent).toContain("7.2");
    expect(rows[0]!.textContent).toContain("12.5");
    expect(rows[0]!.querySelector(".checkup-compare-arrow.dir-up")).toBeTruthy();
    /* 两边都正常、数值浮动的那项算「没变」，不会跟变差的混在一起 */
    expect(rows[1]!.textContent).toContain("血红蛋白");
    expect(rows[1]!.classList.contains("is-worse")).toBe(false);
    expect(document.body.textContent).toContain("1 项变差");
  });

  it("第一份体检没有可对比对象：给出说明，不显示空列表", async () => {
    await open({ ...comparison, previous: null, summary: { total: 2, better: 0, worse: 0, worseNames: [] } });

    expect(document.body.textContent).toContain("第一份体检报告");
    expect(document.body.querySelectorAll(".checkup-compare-row").length).toBe(0);
  });

  it("点「查看这份报告」把报告 id 抛出去（接着看原件）", async () => {
    const wrapper = await open(comparison);

    const openButton = [...document.body.querySelectorAll<HTMLButtonElement>(".episode-sheet-actions button")]
      .find((button) => button.textContent?.includes("查看这份报告"))!;
    openButton.click();
    await nextTick();

    expect(wrapper.emitted("openReport")?.[0]).toEqual(["new"]);
  });
});
