import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
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
