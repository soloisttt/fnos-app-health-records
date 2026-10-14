import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { readFileSync } from "node:fs";
import EpisodeEntrySheet, { type EpisodeSheetForm } from "../src/components/EpisodeEntrySheet.vue";

const wrapperList: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  for (const wrapper of wrapperList.splice(0)) wrapper.unmount();
  document.body.innerHTML = "";
});

function localMoment(offsetMinutes: number) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function baseForm(over: Partial<EpisodeSheetForm> = {}): EpisodeSheetForm {
  return {
    name: "咳嗽",
    at: localMoment(0),
    status: "present",
    value: "",
    unit: "",
    severity: "",
    bodyPart: "",
    dose: "",
    frequency: "",
    route: "",
    ...over,
  };
}

function open(over: Partial<EpisodeSheetForm> = {}) {
  const wrapper = mount(EpisodeEntrySheet, {
    attachTo: document.body,
    props: { open: true, mode: "symptom", intent: "log", subject: "咳嗽", form: baseForm(over) },
  });
  wrapperList.push(wrapper);
  return wrapper;
}

describe("底部记录面板", () => {
  it("时间晚于现在时不保存，并就地给出提示", async () => {
    open({ at: localMoment(240) });
    const save = [...document.body.querySelectorAll<HTMLButtonElement>(".episode-sheet-actions button")].find(
      (button) => button.textContent?.trim() === "保存",
    )!;
    save.click();
    await Promise.resolve();

    expect(document.body.querySelector(".episode-sheet-error")?.textContent).toContain("时间不能晚于现在");
    expect(wrapperList[0]!.emitted("save")).toBeUndefined();
  });

  it("时间正常时保存并抛出表单内容", async () => {
    open({ at: localMoment(-30) });
    const save = [...document.body.querySelectorAll<HTMLButtonElement>(".episode-sheet-actions button")].find(
      (button) => button.textContent?.trim() === "保存",
    )!;
    save.click();
    await Promise.resolve();

    expect(document.body.querySelector(".episode-sheet-error")).toBeNull();
    const emitted = wrapperList[0]!.emitted("save") as unknown[][] | undefined;
    expect(emitted).toBeTruthy();
    /* 载荷是 [表单内容, 是否「保存并再记一条」] */
    expect(emitted![0]![0]).toMatchObject({ name: "咳嗽", status: "present" });
    expect(emitted![0]![1]).toBe(false);
  });

  it("状态四个选项齐全，消失与其他状态分开", () => {
    open();
    const labels = [...document.body.querySelectorAll(".episode-sheet-status-item")].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual(["存在", "加重", "减轻", "消失"]);
  });
});

describe("小面板里弹出的时间选择器", () => {
  it("点「时间」能展开日期滚轮，且滚轮在小面板之外可交互", async () => {
    open();
    const trigger = document.body.querySelector<HTMLButtonElement>(".episode-sheet .datetime-picker-trigger")!;
    trigger.click();
    await nextTick();

    /* 滚轮 Teleport 到 body：必须挂在文档末尾，不被小面板裁掉 */
    const layer = [...document.body.querySelectorAll(".datetime-picker-layer")].at(-1);
    expect(layer).toBeTruthy();
    expect(layer!.querySelector(".datetime-picker-panel")).toBeTruthy();
    expect(layer!.querySelectorAll(".wheel-scroll").length).toBe(5);
  });

  it("滚轮图层层级高于小面板遮罩，否则弹出的选择器看得见点不着", () => {
    /* 曾经的真实 bug：小面板遮罩 z-index 150 盖住滚轮图层 140，
       在面板里点时间，滚轮显示在下方但被遮罩挡住，点任何地方都直接关掉面板。 */
    const pickerCss = readFileSync("packages/ui/src/components/DateTimePicker.css", "utf8");
    const styles = readFileSync("packages/ui/src/styles.css", "utf8");
    const layerZ = Number(
      pickerCss.match(/\.datetime-picker-layer\s*\{[^}]*z-index:\s*(\d+)/)?.[1],
    );
    const sheetZ = Number(
      styles.match(/\.episode-sheet-layer\s*\{[^}]*z-index:\s*(\d+)/)?.[1],
    );
    expect(layerZ).toBeGreaterThan(sheetZ);
  });
});

/*
 * 体温、血压这类「量出来的数值」：状态（存在 / 加重 / 减轻 / 消失）和程度、部位对它没有意义
 * —— 出现「体温 · 存在」「体温 · 轻 · 咽喉」这种组合只会让人犯迷糊。面板里直接不显示。
 */
function openSheet(props: Record<string, unknown>) {
  const wrapper = mount(EpisodeEntrySheet, {
    attachTo: document.body,
    props: { open: true, mode: "symptom", intent: "edit", ...props },
  });
  wrapperList.push(wrapper);
  return document.body.textContent ?? "";
}

describe("量出来的数值不摆状态与程度、部位", () => {
  it("体温：只填数值 / 单位，不出现状态、程度、部位", () => {
    const text = openSheet({ subject: "体温", form: baseForm({ name: "体温", value: "38.2", unit: "℃" }) });

    expect(text).not.toContain("现在的状态");
    expect(text).not.toContain("程度");
    expect(text).not.toContain("部位");
    expect(text).toContain("数值");
    expect(text).toContain("单位");
  });

  it("普通症状（咳嗽）照旧显示状态与程度、部位", () => {
    const text = openSheet({ subject: "咳嗽", form: baseForm() });

    expect(text).toContain("现在的状态");
    expect(text).toContain("程度");
    expect(text).toContain("部位");
  });

  it("「记一次体温」直接让填数值，不再要求选状态", () => {
    const text = openSheet({ intent: "log", subject: "体温", showValue: true, form: baseForm({ name: "体温", unit: "℃" }) });

    expect(document.body.querySelector(".episode-sheet-status")).toBeNull();
    expect(text).toContain("填一下这次量到的数值");
  });
});

/*
 * 「点时间轴上的条目 → 直接进编辑表单」的最后一环：
 * 删除不再在条目上单独摆一个按钮，而是收进编辑面板里。
 */
describe("编辑面板里的「删除这条」", () => {
  it("编辑一条已有记录时出现在左下角，点了把 remove 抛出去", async () => {
    const wrapper = mount(EpisodeEntrySheet, {
      attachTo: document.body,
      props: {
        open: true,
        mode: "symptom",
        intent: "edit",
        subject: "发热",
        canRemove: true,
        form: baseForm({ name: "发热", value: "38.5", unit: "℃" }),
      },
    });
    wrapperList.push(wrapper);
    await nextTick();

    const remove = document.body.querySelector<HTMLButtonElement>(".episode-sheet-remove");
    expect(remove?.textContent).toContain("删除这条");
    remove!.click();
    await nextTick();
    expect(wrapper.emitted("remove")).toBeTruthy();
  });

  it("新记一条时不给删除按钮（还没有东西可删）", async () => {
    const wrapper = mount(EpisodeEntrySheet, {
      attachTo: document.body,
      props: { open: true, mode: "symptom", intent: "create", subject: "咳嗽", form: baseForm() },
    });
    wrapperList.push(wrapper);
    await nextTick();

    expect(document.body.querySelector(".episode-sheet-remove")).toBeNull();
  });
});
