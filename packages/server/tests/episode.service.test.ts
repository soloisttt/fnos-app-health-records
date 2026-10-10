import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  createEpisode,
  createSymptom,
  deleteEpisode,
  deleteSymptom,
  getEpisode,
  linkEpisodeFact,
  listDiseaseCatalog,
  listDiseaseRecords,
  listEpisodes,
  normalizeDiagnosisName,
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
    assert.equal(medication.detail, "4.5ml 口服 tid");
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
