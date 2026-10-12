import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSymptomName, parseChiefComplaint } from "../utils/symptom-extract.ts";

test("主诉拆分：整体一个症状，末尾带走时长", () => {
  assert.deepEqual(parseChiefComplaint("咳嗽半天"), [{ name: "咳嗽", durationText: "半天" }]);
  assert.deepEqual(parseChiefComplaint("发热3天"), [{ name: "发热", durationText: "3天" }]);
  assert.deepEqual(parseChiefComplaint("腹泻 2 周"), [{ name: "腹泻", durationText: "2 周" }]);
  assert.deepEqual(parseChiefComplaint("咽痛一天"), [{ name: "咽痛", durationText: "一天" }]);
});

test("主诉拆分：顿号、逗号、分号、斜杠都算分隔", () => {
  assert.deepEqual(
    parseChiefComplaint("发热、咳嗽、流涕").map((item) => item.name),
    ["发热", "咳嗽", "流涕"],
  );
  assert.deepEqual(
    parseChiefComplaint("发热3天，咳嗽1天").map((item) => [item.name, item.durationText]),
    [
      ["发热", "3天"],
      ["咳嗽", "1天"],
    ],
  );
  assert.deepEqual(
    parseChiefComplaint("呕吐；腹泻").map((item) => item.name),
    ["呕吐", "腹泻"],
  );
});

test("主诉拆分：「伴」「及」这类连接词也能拆开", () => {
  assert.deepEqual(
    parseChiefComplaint("咳嗽伴喘息").map((item) => item.name),
    ["咳嗽", "喘息"],
  );
  assert.deepEqual(
    parseChiefComplaint("发热伴咳嗽、流涕").map((item) => item.name),
    ["发热", "咳嗽", "流涕"],
  );
  assert.deepEqual(
    parseChiefComplaint("发热及皮疹").map((item) => item.name),
    ["发热", "皮疹"],
  );
});

test("主诉拆分：结尾的标点与空白会被清理，重复项只留一条", () => {
  assert.deepEqual(parseChiefComplaint("咳嗽，").map((item) => item.name), ["咳嗽"]);
  assert.deepEqual(parseChiefComplaint("  咳嗽  ").map((item) => item.name), ["咳嗽"]);
  assert.deepEqual(parseChiefComplaint("咳嗽，咳嗽").map((item) => item.name), ["咳嗽"]);
});

test("主诉拆分：空值与无法拆分的内容不会造出空症状", () => {
  assert.deepEqual(parseChiefComplaint(""), []);
  assert.deepEqual(parseChiefComplaint(null), []);
  assert.deepEqual(parseChiefComplaint("   "), []);
  assert.deepEqual(parseChiefComplaint("，、；"), []);
  /* 整条就是时长时不摘除，仍作为一条症状名保留，宁可多留也不丢 */
  assert.deepEqual(parseChiefComplaint("半天"), [{ name: "半天", durationText: null }]);
});

test("症状名归一：只用于去重比较", () => {
  assert.equal(normalizeSymptomName(" 咳  嗽 "), "咳嗽");
  assert.equal(normalizeSymptomName("Cough"), "cough");
});
