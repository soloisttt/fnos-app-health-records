import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  createEpisode,
  excludeCatalogEntry,
  listCatalogHiddenEntries,
  restoreCatalogEntry,
  createMedication,
  createSymptom,
  deleteEpisode,
  deleteMedication,
  deleteSymptom,
  getEpisode,
  linkEpisodeFact,
  listDiseaseCatalog,
  listDiseaseRecords,
  listEpisodes,
  normalizeDiagnosisName,
  searchVisits,
  unlinkEpisodeFact,
  updateEpisode,
  updateSymptom,
} from "../services/episode.service.ts";

function setup(label: string) {
  const storageDir = mkdtempSync(join(tmpdir(), `health-records-${label}-`));
  process.env.STORAGE_DIR = storageDir;
  const owner: RequestUser = {
    id: "owner",
    displayName: "管理员",
    provider: "development",
    authenticated: true,
    isGatewayAdmin: true,
  };
  const viewer: RequestUser = {
    id: "viewer",
    displayName: "只读",
    provider: "development",
    authenticated: true,
    isGatewayAdmin: false,
  };
  const db = getDatabase();
  db.exec(`
    INSERT INTO users (id, display_name) VALUES ('owner', '管理员');
    INSERT INTO users (id, display_name) VALUES ('viewer', '只读');
    INSERT INTO health_members (id, display_name, created_by) VALUES ('member', '宝宝', 'owner');
    INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member', 'owner', 'manager', 'owner');
    INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member', 'viewer', 'viewer', 'owner');
  `);
  return { storageDir, owner, viewer, db };
}

function teardown(storageDir: string) {
  closeDatabaseForTests();
  rmSync(storageDir, { recursive: true, force: true });
}

test("病程可创建、更新状态与病因、软删除", () => {
  const { storageDir, owner } = setup("episode-crud");
  try {
    const created = createEpisode(owner, "member", {
      title: "呼吸道感染",
      onsetAt: "2026-10-09",
      causeText: "受凉",
    });
    assert.equal(created.episode.title, "呼吸道感染");
    assert.equal(created.episode.status, "active");
    assert.equal(created.episode.causeText, "受凉");

    const updated = updateEpisode(owner, created.episode.id, {
      status: "resolved",
      resolvedAt: "2026-10-14",
    });
    assert.equal(updated.episode.status, "resolved");
    assert.equal(updated.episode.resolvedAt, "2026-10-14");
    assert.equal(updated.episode.causeText, "受凉", "未提交的字段不应被清空");

    assert.equal(listEpisodes(owner, "member").length, 1);
    deleteEpisode(owner, created.episode.id);
    assert.equal(listEpisodes(owner, "member").length, 0);
    assert.throws(() => getEpisode(owner, created.episode.id));
  } finally {
    teardown(storageDir);
  }
});

test("症状可增改删，且只读账号不能修改", () => {
  const { storageDir, owner, viewer } = setup("symptom-crud");
  try {
    const episode = createEpisode(owner, "member", { title: "上感" });
    const afterCreate = createSymptom(owner, episode.episode.id, {
      name: "咳嗽",
      durationText: "半天",
      severity: "轻",
      bodyPart: "咽喉",
    });
    assert.equal(afterCreate.symptoms.length, 1);
    const symptomId = afterCreate.symptoms[0]!.id;
    assert.equal(afterCreate.symptoms[0]!.source, "manual");

    const updated = updateSymptom(owner, symptomId, { status: "resolved" });
    assert.equal(updated.symptoms[0]!.status, "resolved");

    assert.throws(
      () => createSymptom(viewer, episode.episode.id, { name: "发热" }),
      /管理权限|仅有管理/,
    );
    assert.throws(() => updateSymptom(viewer, symptomId, { name: "改名" }));

    const afterDelete = deleteSymptom(owner, symptomId);
    assert.equal(afterDelete.symptoms.length, 0);
  } finally {
    teardown(storageDir);
  }
});

test("手动补录的用药可增删，只读账号不能修改", () => {
  const { storageDir, owner, viewer } = setup("medication-crud");
  try {
    const episode = createEpisode(owner, "member", { title: "咳嗽" });
    const afterCreate = createMedication(owner, episode.episode.id, {
      name: "氨溴特罗口服溶液",
      dose: "5ml",
      frequency: "bid",
      route: "口服",
      startAt: "2026-10-09",
    });
    assert.equal(afterCreate.medications.length, 1);
    assert.equal(afterCreate.medications[0]!.name, "氨溴特罗口服溶液");
    assert.equal(afterCreate.medications[0]!.dose, "5ml");
    assert.equal(afterCreate.medications[0]!.startAt, "2026-10-09");
    assert.equal(afterCreate.medications[0]!.source, "manual", "手动补录的用药来源应为 manual");
    assert.equal(afterCreate.medications[0]!.reportId, null, "手动补录不挂在任何报告上");

    assert.throws(
      () => createMedication(viewer, episode.episode.id, { name: "布洛芬" }),
      /管理权限|仅有管理/,
    );
    assert.throws(() => createMedication(owner, episode.episode.id, { name: "   " }), /不能为空/);

    const afterDelete = deleteMedication(owner, afterCreate.medications[0]!.id);
    assert.equal(afterDelete.medications.length, 0);
    assert.throws(() => deleteMedication(owner, afterCreate.medications[0]!.id), /不存在/);
  } finally {
    teardown(storageDir);
  }
});

test("归集关系支持精细挂载、重复挂载幂等、可摘除", () => {
  const { storageDir, owner, db } = setup("episode-links");
  try {
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
        VALUES ('report1', 'member', 'owner', 'outpatient', '门诊病历', 'ready');
      INSERT INTO report_medications (id, report_id, medication_context, medication_name)
        VALUES ('med1', 'report1', 'prescription', '氨溴特罗口服溶液');
    `);
    const episode = createEpisode(owner, "member", { title: "呼吸道感染" });

    const linked = linkEpisodeFact(owner, episode.episode.id, {
      factType: "medication",
      factId: "med1",
    });
    assert.equal(linked.links.length, 1);
    assert.equal(linked.links[0]!.factType, "medication");
    assert.equal(linked.links[0]!.factId, "med1");

    linkEpisodeFact(owner, episode.episode.id, { factType: "medication", factId: "med1" });
    assert.equal(getEpisode(owner, episode.episode.id).links.length, 1, "重复挂载不应产生重复行");

    assert.throws(() =>
      linkEpisodeFact(owner, episode.episode.id, { factType: "bogus", factId: "x" }),
    );

    const unlinked = unlinkEpisodeFact(owner, episode.episode.id, {
      factType: "medication",
      factId: "med1",
    });
    assert.equal(unlinked.links.length, 0);
    assert.throws(() =>
      unlinkEpisodeFact(owner, episode.episode.id, { factType: "medication", factId: "med1" }),
    );
  } finally {
    teardown(storageDir);
  }
});

test("疾病目录按标准病名合并诊断，并并列展示症状", () => {
  const { storageDir, owner, db } = setup("disease-catalog");
  try {
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
        VALUES ('r1', 'member', 'owner', 'outpatient', '门诊1', 'ready', '2026-09-20');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, report_issued_at)
        VALUES ('r2', 'member', 'owner', 'outpatient', '门诊2', 'ready', '2026-10-09');
      INSERT INTO report_diagnoses (id, report_id, diagnosis_type, diagnosis_text)
        VALUES ('d1', 'r1', 'outpatient', '急性上呼吸道感染');
      INSERT INTO report_diagnoses (id, report_id, diagnosis_type, diagnosis_text)
        VALUES ('d2', 'r2', 'outpatient', '上呼吸道感染');
      INSERT INTO diagnosis_catalog (id, canonical_name) VALUES ('c1', '上呼吸道感染');
      INSERT INTO diagnosis_aliases (id, catalog_id, alias_name, normalized_alias, source)
        VALUES ('a1', 'c1', '急性上呼吸道感染', '${normalizeDiagnosisName("急性上呼吸道感染")}', 'manual');
    `);
    const episode = createEpisode(owner, "member", { title: "10月感冒" });
    createSymptom(owner, episode.episode.id, { name: "咳嗽" });

    const catalog = listDiseaseCatalog(owner, "member");
    const diagnoses = catalog.filter((entry) => entry.kind === "diagnosis");
    assert.equal(diagnoses.length, 1, "两个写法应合并为一条标准病名");
    assert.equal(diagnoses[0]!.name, "上呼吸道感染");
    assert.equal(diagnoses[0]!.count, 2);
    assert.equal(diagnoses[0]!.lastAt, "2026-10-09");

    const symptoms = catalog.filter((entry) => entry.kind === "symptom");
    assert.equal(symptoms.length, 1);
    assert.equal(symptoms[0]!.name, "咳嗽");
  } finally {
    teardown(storageDir);
  }
});

test("疾病目录下钻返回历史就诊记录（时间 / 医院 / 诊断 / 用药）", () => {
  const { storageDir, owner, db } = setup("disease-records");
  try {
    db.exec(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at,
        hospital_name_raw, visit_department
      ) VALUES (
        'r1', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '2026-10-09',
        '郑州市中心医院', '急诊儿科'
      );
      INSERT INTO report_diagnoses (id, report_id, diagnosis_type, diagnosis_text)
        VALUES ('d1', 'r1', 'outpatient', '呼吸道感染');
      INSERT INTO report_medications (
        id, report_id, medication_context, medication_name, dose, frequency, route
      ) VALUES ('m1', 'r1', 'prescription', '复方氨酚甲麻口服液', '4.5ml', 'tid', '口服');
    `);

    const byDiagnosis = listDiseaseRecords(owner, "member", "diagnosis", "呼吸道感染");
    assert.equal(byDiagnosis.length, 1);
    assert.equal(byDiagnosis[0]!.hospitalName, "郑州市中心医院");
    assert.equal(byDiagnosis[0]!.departmentName, "急诊儿科");
    assert.equal(byDiagnosis[0]!.issuedAt, "2026-10-09");
    assert.deepEqual(byDiagnosis[0]!.diagnoses, ["呼吸道感染"]);
    assert.equal(byDiagnosis[0]!.medications[0]!.name, "复方氨酚甲麻口服液");
    assert.equal(byDiagnosis[0]!.medications[0]!.frequency, "tid");
    assert.equal(byDiagnosis[0]!.medications[0]!.route, "口服");

    // 症状路径：靠病程的精细归集反查——只挂了药，也应能定位到那次就诊
    const episode = createEpisode(owner, "member", { title: "呼吸道感染" });
    createSymptom(owner, episode.episode.id, { name: "咳嗽" });
    assert.deepEqual(
      listDiseaseRecords(owner, "member", "symptom", "咳嗽"),
      [],
      "未归集任何事实时不应凭空产生就诊记录",
    );

    linkEpisodeFact(owner, episode.episode.id, { factType: "medication", factId: "m1" });
    const bySymptom = listDiseaseRecords(owner, "member", "symptom", "咳嗽");
    assert.equal(bySymptom.length, 1);
    assert.equal(bySymptom[0]!.reportId, "r1");
    assert.equal(bySymptom[0]!.medications[0]!.name, "复方氨酚甲麻口服液");
  } finally {
    teardown(storageDir);
  }
});

test("病程详情返回可展示的已归集内容，事实消失时标记 missing", () => {
  const { storageDir, owner, db } = setup("linked-facts");
  try {
    db.exec(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at, hospital_name_raw
      ) VALUES ('r1', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '2026-10-09', '郑州市中心医院');
      INSERT INTO report_diagnoses (id, report_id, diagnosis_type, diagnosis_text)
        VALUES ('d1', 'r1', 'outpatient', '呼吸道感染');
      INSERT INTO report_medications (
        id, report_id, medication_context, medication_name, dose, dose_unit, route, frequency
      ) VALUES ('m1', 'r1', 'prescription', '复方氨酚甲麻口服液', '4.5', 'ml', '口服', 'tid');
    `);
    const episode = createEpisode(owner, "member", { title: "呼吸道感染" });
    linkEpisodeFact(owner, episode.episode.id, { factType: "report", factId: "r1" });
    linkEpisodeFact(owner, episode.episode.id, { factType: "medication", factId: "m1" });
    linkEpisodeFact(owner, episode.episode.id, { factType: "diagnosis", factId: "d1" });

    const detail = getEpisode(owner, episode.episode.id);
    assert.equal(detail.linkedFacts.length, 3);

    const report = detail.linkedFacts.find((item) => item.factType === "report")!;
    assert.equal(report.label, "门诊病历");
    assert.equal(report.hospitalName, "郑州市中心医院");
    assert.equal(report.missing, false);

    const medication = detail.linkedFacts.find((item) => item.factType === "medication")!;
    assert.equal(medication.label, "复方氨酚甲麻口服液");
    /* 频次保留 tid 原标签，并在后面括号补中文说明 */
    assert.equal(medication.detail, "4.5ml 口服 tid（每日三次）");
    assert.equal(medication.reportTitle, "门诊病历", "用药应带上来源报告，便于回看原件");

    const diagnosis = detail.linkedFacts.find((item) => item.factType === "diagnosis")!;
    assert.equal(diagnosis.label, "呼吸道感染");

    db.prepare("DELETE FROM report_medications WHERE id = 'm1'").run();
    const after = getEpisode(owner, episode.episode.id);
    const gone = after.linkedFacts.find((item) => item.factType === "medication")!;
    assert.equal(gone.missing, true);
    assert.equal(gone.label, "内容已不存在");
  } finally {
    teardown(storageDir);
  }
});

test("挂报告后，报告里的诊断与用药自动展开到时间轴", () => {
  const { storageDir, owner, db } = setup("report-expand");
  try {
    db.exec(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at,
        hospital_name_raw, clinical_diagnosis
      ) VALUES (
        'r1', 'member', 'owner', 'outpatient', '急诊儿科门诊记录', 'ready', '2026-10-09',
        '郑州市中心医院', '急性上呼吸道感染、支气管炎'
      );
      INSERT INTO report_diagnoses (id, report_id, diagnosis_type, diagnosis_text)
        VALUES ('d1', 'r1', 'outpatient', '支气管炎');
      INSERT INTO report_medications (
        id, report_id, medication_context, medication_name, dose, dose_unit, route, frequency
      ) VALUES ('m1', 'r1', 'prescription', '复方氨酚甲麻口服液', '4.5', 'ml', '口服', 'tid');
      INSERT INTO report_medications (
        id, report_id, medication_context, medication_name, dose, dose_unit, route, frequency
      ) VALUES ('m2', 'r1', 'prescription', '氨溴特罗口服溶液', '5', 'ml', '口服', 'bid');
      INSERT INTO report_procedures (id, report_id, procedure_name, performed_at)
        VALUES ('p1', 'r1', '雾化吸入', '2026-10-09');
    `);
    const episode = createEpisode(owner, "member", { title: "10月咳嗽", onsetAt: "2026-10-09" });
    linkEpisodeFact(owner, episode.episode.id, { factType: "report", factId: "r1" });

    const detail = getEpisode(owner, episode.episode.id);
    const medications = detail.linkedFacts.filter((item) => item.factType === "medication");
    assert.deepEqual(
      medications.map((item) => item.label).sort(),
      ["复方氨酚甲麻口服液", "氨溴特罗口服溶液"],
      "报告里的两个药都要出现在病程里",
    );
    assert.ok(medications.every((item) => item.derived), "展开项应标记为来自报告");
    assert.equal(medications[0]!.reportTitle, "急诊儿科门诊记录");
    assert.equal(medications[0]!.occurredAt, "2026-10-09", "展开项沿用这次就诊的时间");
    assert.equal(medications[0]!.detail, "4.5ml 口服 tid（每日三次）");

    /* 诊断有两个来源：诊断表 + 门诊病历的「临床诊断」字段，都要纳入且不重复 */
    assert.deepEqual(
      detail.linkedFacts.filter((item) => item.factType === "diagnosis").map((item) => item.label).sort(),
      ["急性上呼吸道感染", "支气管炎"],
    );
    assert.equal(detail.linkedFacts.filter((item) => item.factType === "procedure").length, 1);

    /* 报告内容变化后时间轴自动跟随，不需要重新归集 */
    db.prepare("DELETE FROM report_medications WHERE id = 'm2'").run();
    assert.equal(
      getEpisode(owner, episode.episode.id).linkedFacts.filter((item) => item.factType === "medication").length,
      1,
    );

    /* 单独归集过的条目保留原有归集关系（可单独移除），不与展开项重复出现 */
    linkEpisodeFact(owner, episode.episode.id, { factType: "medication", factId: "m1" });
    const explicit = getEpisode(owner, episode.episode.id);
    const sameMedication = explicit.linkedFacts.filter((item) => item.label === "复方氨酚甲麻口服液");
    assert.equal(sameMedication.length, 1, "同一事实不应既作为展开项又作为独立归集重复出现");
    assert.equal(sameMedication[0]!.derived, false, "独立归集的条目可以单独移除");
    assert.equal(explicit.links.length, 2, "归集关系表里只应有报告与用药两条");
  } finally {
    teardown(storageDir);
  }
});

test("A6 综合检索可跨诊断、用药、症状、病因与病程标题命中", () => {
  const { storageDir, owner, db } = setup("visit-search");
  try {
    db.exec(`
      INSERT INTO reports (
        id, member_id, created_by, report_type, title, status, report_issued_at, hospital_name_raw
      ) VALUES ('r1', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '2026-10-09', '郑州市中心医院');
      INSERT INTO report_diagnoses (id, report_id, diagnosis_type, diagnosis_text)
        VALUES ('d1', 'r1', 'outpatient', '呼吸道感染');
      INSERT INTO report_medications (id, report_id, medication_context, medication_name)
        VALUES ('m1', 'r1', 'prescription', '氨溴特罗口服溶液');
    `);

    assert.equal(searchVisits(owner, "member", "呼吸道").length, 1, "按诊断应能命中");
    assert.equal(searchVisits(owner, "member", "氨溴特罗").length, 1, "按用药名应能命中");
    assert.equal(searchVisits(owner, "member", "呼吸道")[0]!.hospitalName, "郑州市中心医院");
    assert.deepEqual(searchVisits(owner, "member", "   "), [], "空关键词不返回结果");
    assert.deepEqual(searchVisits(owner, "member", "受凉"), [], "还没有病程时搜不到病因");

    const episode = createEpisode(owner, "member", { title: "10月感冒", causeText: "受凉" });
    linkEpisodeFact(owner, episode.episode.id, { factType: "report", factId: "r1" });
    createSymptom(owner, episode.episode.id, { name: "咳嗽" });

    assert.equal(searchVisits(owner, "member", "咳嗽").length, 1, "按症状应能命中");
    assert.equal(searchVisits(owner, "member", "受凉").length, 1, "按病因应能命中");
    assert.equal(searchVisits(owner, "member", "10月感冒").length, 1, "按病程标题应能命中");
  } finally {
    teardown(storageDir);
  }
});

test("门诊病历的「临床诊断」也进入疾病目录、下钻与检索", () => {
  const { storageDir, owner, db } = setup("episode-clinical-diagnosis");
  try {
    /* 门诊病历的诊断由 AI 写在 reports.clinical_diagnosis，而不是 report_diagnoses 表；
       影像报告才会有 report_diagnoses 行。两种来源都必须被识别。 */
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, clinical_diagnosis, hospital_name_raw, report_issued_at)
      VALUES ('report-outpatient', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '呼吸道感染', '郑州市中心医院', '2026-10-09');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, clinical_diagnosis, hospital_name_raw, report_issued_at)
      VALUES ('report-imaging', 'member', 'owner', 'imaging', '胸部CT', 'ready', '支气管炎', '郑州儿童医院', '2026-09-20');
      INSERT INTO report_diagnoses (id, report_id, diagnosis_type, diagnosis_text)
      VALUES ('dx-imaging', 'report-imaging', 'other', '支气管炎');
      INSERT INTO report_medications (id, report_id, medication_name, dose, frequency, route)
      VALUES ('med-outpatient', 'report-outpatient', '复方氨酚甲麻口服液', '4.5ml', 'tid', '口服');
    `);

    const catalog = listDiseaseCatalog(owner, "member");
    const names = catalog.filter((item) => item.kind === "diagnosis").map((item) => item.name).sort();
    assert.deepEqual(names, ["呼吸道感染", "支气管炎"], "临床诊断字段与诊断表都应进入疾病目录");
    assert.equal(
      catalog.find((item) => item.name === "支气管炎")?.count,
      1,
      "同一份报告里两处出现同一诊断时不应重复计数",
    );

    const visits = listDiseaseRecords(owner, "member", "diagnosis", "呼吸道感染");
    assert.equal(visits.length, 1);
    assert.equal(visits[0].reportId, "report-outpatient");
    assert.equal(visits[0].hospitalName, "郑州市中心医院");
    assert.equal(visits[0].medications[0]?.name, "复方氨酚甲麻口服液");

    const searched = searchVisits(owner, "member", "呼吸道感染");
    assert.equal(searched.length, 1);
    assert.equal(searched[0].reportId, "report-outpatient");
  } finally {
    teardown(storageDir);
  }
});

test("报告进入回收站后，其诊断同时从疾病目录、下钻与检索中消失", () => {
  const { storageDir, owner, db } = setup("episode-disease-trash");
  try {
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, clinical_diagnosis)
      VALUES ('report-a', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '呼吸道感染');
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, clinical_diagnosis)
      VALUES ('report-b', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '支气管炎');
    `);

    const before = listDiseaseCatalog(owner, "member")
      .filter((item) => item.kind === "diagnosis")
      .map((item) => item.name)
      .sort();
    assert.deepEqual(before, ["呼吸道感染", "支气管炎"]);

    db.prepare("UPDATE reports SET status = 'trashed' WHERE id = 'report-b'").run();

    const after = listDiseaseCatalog(owner, "member")
      .filter((item) => item.kind === "diagnosis")
      .map((item) => item.name);
    assert.deepEqual(after, ["呼吸道感染"], "回收站里的报告不应再计入疾病目录");
    assert.equal(listDiseaseRecords(owner, "member", "diagnosis", "支气管炎").length, 0);
    assert.equal(searchVisits(owner, "member", "支气管炎").length, 0);
  } finally {
    teardown(storageDir);
  }
});

test("疾病目录可隐藏与恢复：隐藏不动源数据，源数据消失后自然不再列出", () => {
  const { storageDir, owner, db } = setup("episode-catalog-hide");
  try {
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status, clinical_diagnosis)
      VALUES ('report-a', 'member', 'owner', 'outpatient', '门诊病历', 'ready', '呼吸道感染');
    `);
    assert.equal(listDiseaseCatalog(owner, "member").length, 1);

    excludeCatalogEntry(owner, "member", "diagnosis", "呼吸道感染");
    assert.equal(listDiseaseCatalog(owner, "member").length, 0, "隐藏后不再出现在目录");
    assert.equal(listCatalogHiddenEntries(owner, "member").length, 1);
    /* 隐藏不改动报告原文 */
    const clinical = db.prepare("SELECT clinical_diagnosis AS text FROM reports WHERE id = 'report-a'").get() as {
      text: string;
    };
    assert.equal(clinical.text, "呼吸道感染");

    /* 报告进回收站：本来就不在目录里，已隐藏清单也不再列出 */
    db.prepare("UPDATE reports SET status = 'trashed' WHERE id = 'report-a'").run();
    assert.equal(listCatalogHiddenEntries(owner, "member").length, 0, "源数据消失后不再出现在已隐藏清单");

    /* 报告恢复：隐藏设置仍在 */
    db.prepare("UPDATE reports SET status = 'ready' WHERE id = 'report-a'").run();
    assert.equal(listDiseaseCatalog(owner, "member").length, 0, "源数据恢复后仍保持隐藏");
    assert.equal(listCatalogHiddenEntries(owner, "member").length, 1);

    restoreCatalogEntry(owner, "member", "diagnosis", "呼吸道感染");
    assert.equal(listDiseaseCatalog(owner, "member").length, 1, "恢复后回到目录");
    assert.equal(listCatalogHiddenEntries(owner, "member").length, 0);
  } finally {
    teardown(storageDir);
  }
});

test("删除病程后：不再出现在列表，其症状同时退出疾病目录与检索", () => {
  const { storageDir, owner } = setup("episode-delete-cascade");
  try {
    const episode = createEpisode(owner, "member", {
      title: "10月呼吸道感染",
      onsetAt: "2026-10-09",
    });
    createSymptom(owner, episode.episode.id, { name: "咳嗽", onsetAt: "2026-10-09" });

    assert.equal(
      listDiseaseCatalog(owner, "member").filter((item) => item.kind === "symptom").length,
      1,
      "删除前症状在目录里",
    );

    deleteEpisode(owner, episode.episode.id);

    assert.equal(listEpisodes(owner, "member").length, 0, "删除后不再出现在病程列表");
    assert.equal(
      listDiseaseCatalog(owner, "member").filter((item) => item.kind === "symptom").length,
      0,
      "删除病程后，它下面的症状不应再留在疾病目录",
    );
    assert.deepEqual(searchVisits(owner, "member", "咳嗽"), [], "按症状检索不应再命中");
    assert.throws(() => getEpisode(owner, episode.episode.id), "已删除的病程详情应不可访问");
  } finally {
    teardown(storageDir);
  }
});

test("病程时间轴里的用药频次会补上中文说明", () => {
  const { storageDir, owner, db } = setup("episode-medication-frequency");
  try {
    db.exec(`
      INSERT INTO reports (id, member_id, created_by, report_type, title, status)
      VALUES ('report-med', 'member', 'owner', 'outpatient', '门诊病历', 'ready');
      INSERT INTO report_medications (id, report_id, medication_name, dose, dose_unit, route, frequency)
      VALUES ('med-tid', 'report-med', '复方氨酚甲麻口服液', '4.5', 'ml', '口服', 'tid');
      INSERT INTO report_medications (id, report_id, medication_name, dose, dose_unit, route, frequency)
      VALUES ('med-bid', 'report-med', '氨溴特罗口服溶液', '5', 'ml', '口服', 'bid');
    `);
    const episode = createEpisode(owner, "member", { title: "10月呼吸道感染" });
    linkEpisodeFact(owner, episode.episode.id, { factType: "medication", factId: "med-tid" });
    linkEpisodeFact(owner, episode.episode.id, { factType: "medication", factId: "med-bid" });

    const detail = getEpisode(owner, episode.episode.id);
    const details = detail.linkedFacts.map((fact) => fact.detail ?? "");
    assert.ok(
      details.some((text) => text.includes("tid（每日三次）")),
      `应保留 tid 原标签并补中文，实际：${details.join(" | ")}`,
    );
    assert.ok(
      details.some((text) => text.includes("bid（每日两次）")),
      `应保留 bid 原标签并补中文，实际：${details.join(" | ")}`,
    );
  } finally {
    teardown(storageDir);
  }
});

test("跨成员访问被拒绝", () => {
  const { storageDir, owner, db } = setup("episode-access");
  try {
    db.exec(`
      INSERT INTO users (id, display_name) VALUES ('stranger', '外人');
      INSERT INTO health_members (id, display_name, created_by) VALUES ('other', '别人家', 'owner');
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
        VALUES ('other', 'owner', 'manager', 'owner');
    `);
    const stranger: RequestUser = {
      id: "stranger",
      displayName: "外人",
      provider: "development",
      authenticated: true,
      isGatewayAdmin: false,
    };
    const episode = createEpisode(owner, "other", { title: "别人的病程" });
    assert.throws(() => getEpisode(stranger, episode.episode.id), /无权访问/);
    assert.throws(() => listEpisodes(stranger, "other"), /无权访问/);
    assert.throws(() => listDiseaseCatalog(stranger, "other"), /无权访问/);
  } finally {
    teardown(storageDir);
  }
});
