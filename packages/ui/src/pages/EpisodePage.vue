<script setup lang="ts">
import { computed, ref, watch, onActivated } from "vue";
import {
  Activity,
  ArrowLeft,
  ArrowUpDown,
  CheckCircle2,
  ClipboardList,
  Copy,
  FileText,
  Plus,
  Thermometer,
  Trash2,
} from "@lucide/vue";
import DateTimePicker from "../components/DateTimePicker.vue";
import EmptyState from "../components/EmptyState.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { request } from "../utils/api";
import type {
  CaseEpisode,
  CaseEpisodeDetail,
  CaseEpisodeLinkFactType,
  CaseMedication,
  CaseSymptom,
  EpisodeLinkedFact,
} from "../types/api";
import { withFrequencyNote } from "../utils/medication-frequency";
import { parseQuickEntry } from "../utils/quick-entry";
import { useAppContext } from "../composables/useAppContext";
import { useConfirm } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";

const app = useAppContext();
const toast = useToast();
const confirmDialog = useConfirm();

const loading = ref(true);
const saving = ref(false);
const error = ref("");
const episodes = ref<CaseEpisode[]>([]);
const detail = ref<CaseEpisodeDetail | null>(null);
const formOpen = ref(false);
const symptomFormOpen = ref(false);
const medicationFormOpen = ref(false);
const previewReportId = ref<string | null>(null);
/* 病因默认收起：只在点「填病因」时展开，腾出位置给「快速记录」 */
const causeOpen = ref(false);
const causeDraft = ref("");
/* 「给医生看」的摘要面板 */
const summaryOpen = ref(false);
/* 「记一笔」时表单标题写成「记一笔：咳嗽」，与编辑区分 */
const logSourceName = ref<string | null>(null);
/* 快速记录 */
const quickInput = ref("");
const COMMON_SYMPTOMS = ["发热", "咳嗽", "流鼻涕", "鼻塞", "腹泻", "呕吐", "皮疹"];

const factTypeLabels: Record<CaseEpisodeLinkFactType, string> = {
  report: "报告",
  diagnosis: "诊断",
  medication: "用药",
  procedure: "操作",
  vaccination: "疫苗",
  observation: "指标",
  section: "章节",
};

function factDetail(fact: EpisodeLinkedFact) {
  if (fact.missing) return "内容已不存在，可移除这条归集";
  const parts = [fact.detail, fact.reportTitle, fact.hospitalName, formatDay(fact.occurredAt)];
  return parts.filter(Boolean).join(" · ");
}

async function unlinkFact(factType: CaseEpisodeLinkFactType, factId: string) {
  const episodeId = detail.value?.episode.id;
  if (!episodeId || saving.value) return;
  saving.value = true;
  try {
    detail.value = await request<CaseEpisodeDetail>(
      `episodes/${episodeId}/links?factType=${encodeURIComponent(factType)}&factId=${encodeURIComponent(factId)}`,
      { method: "DELETE" },
    );
    toast.show("已从病程移除");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "移除失败";
  } finally {
    saving.value = false;
  }
}

type TimelineItem = {
  key: string;
  title: string;
  detail: string | null;
  reportId: string | null;
  derived: boolean;
  /** 信息不全（例如用药没抽到剂量），卡片上会提示核对原报告 */
  warn: boolean;
  /** 可编辑时给出入口（手动录入的症状与用药）；随报告记入的条目不可改。 */
  edit: (() => void) | null;
  /** 症状专有：点一下记一条同名症状，用来跟踪「好转 / 加重」 */
  logAgain: (() => void) | null;
  remove: (() => void) | null;
};

type EventBlock = {
  type: "event";
  key: string;
  at: string | null;
  kind: string;
  badge: string;
  items: TimelineItem[];
};

/** 一次就诊 = 一份报告，把这次就诊的症状、诊断、用药、操作、疫苗收进一张卡片 */
type VisitBlock = {
  type: "visit";
  key: string;
  at: string | null;
  reportId: string;
  title: string;
  place: string;
  symptoms: TimelineItem[];
  diagnoses: TimelineItem[];
  medications: TimelineItem[];
  procedures: TimelineItem[];
  vaccinations: TimelineItem[];
  others: TimelineItem[];
  gaps: string[];
};

type TimelineBlock = EventBlock | VisitBlock;

function symptomItem(item: CaseSymptom): TimelineItem {
  return {
    key: `symptom:${item.id}`,
    title: item.name,
    detail: symptomMeta(item),
    reportId: null,
    derived: false,
    warn: false,
    edit: () => editSymptom(item),
    logAgain: () => logSymptomAgain(item),
    remove: () => void removeSymptom(item.id),
  };
}

function factItem(fact: EpisodeLinkedFact): TimelineItem {
  return {
    key: `fact:${fact.linkId}`,
    title: fact.label,
    detail: factDetail(fact),
    reportId: fact.reportId,
    derived: fact.derived,
    warn: fact.factType === "medication" && (fact.detail ?? "").trim() === "用药",
    /* 由报告展开出的条目跟随报告，不单独编辑或移除；要改就改报告本身 */
    edit: null,
    logAgain: null,
    remove: fact.derived ? null : () => void unlinkFact(fact.factType, fact.factId),
  };
}

/** A5 病程时间轴：一次就诊合成一张卡片，自行录入的症状与用药按时间排成节点。 */
const timeline = computed<TimelineBlock[]>(() => {
  const current = detail.value;
  if (!current) return [];
  const blocks: TimelineBlock[] = [];

  const visits = new Map<string, VisitBlock>();
  const looseEvents = new Map<string, EventBlock>();

  const pushLoose = (factType: string, badge: string, at: string | null, item: TimelineItem) => {
    const key = `${factType}|${at ?? ""}`;
    const existing = looseEvents.get(key);
    if (existing) {
      existing.items.push(item);
      return;
    }
    looseEvents.set(key, { type: "event", key: `facts:${key}`, at, kind: factType, badge, items: [item] });
  };

  for (const fact of current.linkedFacts) {
    /* 报告本身不单独成条：它已经变成上面那张就诊卡片 */
    if (fact.factType === "report") continue;
    const item = factItem(fact);
    if (!fact.reportId) {
      pushLoose(fact.factType, factTypeLabels[fact.factType], fact.occurredAt, item);
      continue;
    }
    const reportId = fact.reportId;
    let block = visits.get(reportId);
    if (!block) {
      block = {
        type: "visit",
        key: `visit:${reportId}`,
        at: fact.occurredAt,
        reportId,
        title: fact.reportTitle ?? "就诊记录",
        place: [fact.hospitalName, fact.departmentName].filter(Boolean).join(" · "),
        symptoms: [],
        diagnoses: [],
        medications: [],
        procedures: [],
        vaccinations: [],
        others: [],
        gaps: [],
      };
      visits.set(reportId, block);
    }
    if (fact.factType === "diagnosis") block.diagnoses.push(item);
    else if (fact.factType === "medication") block.medications.push(item);
    else if (fact.factType === "procedure") block.procedures.push(item);
    else if (fact.factType === "vaccination") block.vaccinations.push(item);
    else block.others.push(item);
  }

  /* 症状：来自报告主诉的归到那次就诊里，自己录的单独成节点 */
  for (const symptom of current.symptoms) {
    const visit = symptom.reportId ? visits.get(symptom.reportId) : undefined;
    if (visit) {
      visit.symptoms.push({
        key: `visit-symptom:${symptom.id}`,
        title: symptom.name,
        detail: symptomVisitMeta(symptom),
        reportId: null,
        derived: true,
        warn: false,
        edit: () => editSymptom(symptom),
        logAgain: () => logSymptomAgain(symptom),
        remove: () => void removeSymptom(symptom.id),
      });
      continue;
    }
    pushLoose("symptom", "症状", symptom.onsetAt, symptomItem(symptom));
  }

  /* 手动补录的用药：没有来源报告，按开始时间成节点 */
  for (const medication of current.medications) {
    pushLoose("medication", factTypeLabels.medication, medication.startAt, {
      key: `medication:${medication.id}`,
      title: medication.name,
      detail: manualMedicationDetail(medication),
      reportId: null,
      derived: false,
      warn: false,
      edit: () => editMedication(medication),
      logAgain: null,
      remove: () => void removeMedication(medication.id),
    });
  }

  blocks.push(...looseEvents.values());

  for (const block of visits.values()) {
    /* 缺什么主动说出来：AI 抽取本来就不保证全，让界面提醒比自己去比更靠谱 */
    if (!block.diagnoses.length) block.gaps.push("没识别到诊断");
    if (block.diagnoses.length && !block.medications.length) block.gaps.push("有诊断，但没抽到用药");
    if (block.medications.some((item) => item.warn)) block.gaps.push("有条用药缺剂量，建议核对原报告");
    blocks.push(block);
  }

  if (current.episode.status === "resolved" || current.episode.resolvedAt) {
    blocks.push({
      type: "event",
      key: "resolved",
      at: current.episode.resolvedAt,
      kind: "resolved",
      badge: "转归",
      items: [
        {
          key: "resolved:main",
          title: "已痊愈",
          detail: null,
          reportId: null,
          derived: false,
          warn: false,
          edit: null,
          logAgain: null,
          remove: null,
        },
      ],
    });
  }

  return blocks.sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
});

/** 时间轴显示顺序：默认从早到晚；可切成"最近的在最上面"。 */
const timelineDesc = ref(false);
const displayTimeline = computed(() =>
  timelineDesc.value ? [...timeline.value].reverse() : timeline.value,
);

const visitBlocks = computed(() => timeline.value.filter((block): block is VisitBlock => block.type === "visit"));

/** 「这次病了几天」：进行中显示已持续，已痊愈显示共几天。 */
const episodeDurationText = computed(() => {
  const episode = detail.value?.episode;
  if (!episode?.onsetAt) return "";
  const start = new Date(`${episode.onsetAt.slice(0, 10)}T00:00:00`).getTime();
  const end = episode.resolvedAt
    ? new Date(`${episode.resolvedAt.slice(0, 10)}T00:00:00`).getTime()
    : Date.now();
  const days = Math.max(1, Math.round((end - start) / 86_400_000) + 1);
  return episode.resolvedAt ? `共 ${days} 天` : `已持续 ${days} 天`;
});

/** 发热小结：发烧时最常被问的三件事——最高多少、最近多少、烧了几天。 */
const feverSummary = computed(() => {
  const items = (detail.value?.symptoms ?? []).filter(
    (item) =>
      item.measuredValue &&
      (item.measuredUnit === "℃" || /发热|体温|发烧|温度/.test(item.name)),
  );
  const scored = items
    .map((item) => ({ item, value: Number(item.measuredValue) }))
    .filter((entry) => Number.isFinite(entry.value));
  if (!scored.length) return null;
  const highest = scored.reduce((best, entry) => (entry.value > best.value ? entry : best));
  const latest = [...scored].sort((left, right) =>
    (left.item.onsetAt ?? "").localeCompare(right.item.onsetAt ?? ""),
  )[scored.length - 1]!;
  const days = new Set(scored.map((entry) => (entry.item.onsetAt ?? "").slice(0, 10)).filter(Boolean)).size;
  return {
    highest: `${highest.value}`,
    highestAt: highest.item.onsetAt,
    latest: `${latest.value}`,
    latestAt: latest.item.onsetAt,
    count: scored.length,
    days,
  };
});

const episodeForm = ref({ title: "", onsetAt: "", causeText: "" });
const symptomForm = ref(emptySymptomForm());
const medicationForm = ref({ name: "", dose: "", frequency: "", route: "", startAt: "" });
const editingSymptomId = ref<string | null>(null);
const editingMedicationId = ref<string | null>(null);

/** 当前本地时间 `YYYY-MM-DD HH:mm`；补录症状默认填"现在"，对应"刚量了体温"这种场景。 */
function nowLocal() {
  const current = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())} ${pad(current.getHours())}:${pad(current.getMinutes())}`;
}

function emptySymptomForm() {
  return {
    name: "",
    onsetAt: nowLocal(),
    durationText: "",
    severity: "",
    bodyPart: "",
    measuredValue: "",
    measuredUnit: "",
    status: "present" as CaseSymptom["status"],
  };
}

/** 打开空白症状表单（强制展开，供快捷键 / 快速记录调用） */
function openSymptomForm() {
  closeMedicationForm();
  editingSymptomId.value = null;
  logSourceName.value = null;
  symptomForm.value = emptySymptomForm();
  symptomFormOpen.value = true;
}

/** 头部「添加症状」按钮：开着就收起，避免占屏 */
function toggleSymptomForm() {
  if (symptomFormOpen.value) closeSymptomForm();
  else openSymptomForm();
}

/** 编辑已有症状 */
function editSymptom(target: CaseSymptom) {
  closeMedicationForm();
  logSourceName.value = null;
  editingSymptomId.value = target.id;
  symptomForm.value = {
    name: target.name,
    /* 老数据可能没有时间，或时间格式不同，统一按当前时间回退显示 */
    onsetAt: target.onsetAt ?? nowLocal(),
    durationText: target.durationText ?? "",
    severity: target.severity ?? "",
    bodyPart: target.bodyPart ?? "",
    measuredValue: target.measuredValue ?? "",
    measuredUnit: target.measuredUnit ?? "",
    status: target.status,
  };
  symptomFormOpen.value = true;
}

/**
 * 「记一笔」：拿已有症状当模板新记一条。
 * 同一天里「咳嗽 · 存在 → 咳嗽 · 好转」就这样自然排成一条线，不用重打症状名。
 */
function logSymptomAgain(target: CaseSymptom) {
  closeMedicationForm();
  editingSymptomId.value = null;
  logSourceName.value = target.name;
  symptomForm.value = {
    ...emptySymptomForm(),
    name: target.name,
    measuredUnit: target.measuredUnit ?? (target.name === "发热" || target.name === "体温" ? "℃" : ""),
    bodyPart: target.bodyPart ?? "",
  };
  symptomFormOpen.value = true;
}

function closeSymptomForm() {
  symptomFormOpen.value = false;
  editingSymptomId.value = null;
  logSourceName.value = null;
  quickInput.value = "";
}

/** 打开空白用药表单（强制展开） */
function openMedicationForm() {
  closeSymptomForm();
  editingMedicationId.value = null;
  medicationForm.value = { name: "", dose: "", frequency: "", route: "", startAt: nowLocal().slice(0, 10) };
  medicationFormOpen.value = true;
}

function toggleMedicationForm() {
  if (medicationFormOpen.value) closeMedicationForm();
  else openMedicationForm();
}

function editMedication(target: CaseMedication) {
  closeSymptomForm();
  editingMedicationId.value = target.id;
  medicationForm.value = {
    name: target.name,
    dose: target.dose ?? "",
    frequency: target.frequency ?? "",
    route: target.route ?? "",
    startAt: target.startAt ?? nowLocal().slice(0, 10),
  };
  medicationFormOpen.value = true;
}

function closeMedicationForm() {
  medicationFormOpen.value = false;
  editingMedicationId.value = null;
}

/* 「一句话记」：把「5点半 37.5」这类口语拆成症状或用药，回车直接填进表单 */
const quickDraft = computed(() => {
  const text = quickInput.value.trim();
  if (!text) return null;
  const parsed = parseQuickEntry(text);
  if (!parsed.matched && !parsed.name) return null;
  return parsed;
});

function applyQuickDraft() {
  const parsed = quickDraft.value;
  if (!parsed) return;
  if (parsed.kind === "medication") {
    openMedicationForm();
    medicationForm.value = {
      ...medicationForm.value,
      name: parsed.name ?? "",
      dose: parsed.dose ?? "",
      frequency: parsed.frequency ?? "",
      route: parsed.route ?? "",
      startAt: parsed.onsetAt ? parsed.onsetAt.slice(0, 10) : medicationForm.value.startAt,
    };
    toast.show("已按用药填入，确认后保存");
  } else {
    openSymptomForm();
    symptomForm.value = {
      ...symptomForm.value,
      name: parsed.name ?? "",
      onsetAt: parsed.onsetAt ?? nowLocal(),
      measuredValue: parsed.measuredValue ?? "",
      measuredUnit: parsed.measuredUnit ?? "",
      status: "present",
    };
    toast.show(parsed.autoName ? "已按体温填入，确认后保存" : "已填入，确认后保存");
  }
  quickInput.value = "";
}

/** 常用症状快捷键：点一下就用当前时间开一条，最常用的三个字也省了 */
function quickSymptom(name: string) {
  openSymptomForm();
  symptomForm.value = {
    ...symptomForm.value,
    name,
    measuredUnit: name === "发热" || name === "体温" ? "℃" : "",
  };
}

const episodeStatusMeta: Record<CaseEpisode["status"], { label: string; chip: string }> = {
  active: { label: "进行中", chip: "chip--amber" },
  resolved: { label: "已痊愈", chip: "chip--green" },
  chronic: { label: "慢性", chip: "" },
  unknown: { label: "未记录", chip: "" },
};

const symptomStatusLabel: Record<CaseSymptom["status"], string> = {
  present: "存在",
  improved: "好转",
  resolved: "已消失",
  unknown: "不确定",
};

/** 状态取值可能来自旧数据或后续版本，查不到时回退，避免整页渲染失败。 */
function episodeStatusOf(status: CaseEpisode["status"]) {
  return episodeStatusMeta[status] ?? episodeStatusMeta.unknown;
}

function symptomStatusOf(status: CaseSymptom["status"]) {
  return symptomStatusLabel[status] ?? symptomStatusLabel.unknown;
}

function formatDay(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

/**
 * 时间轴上的时间：带具体时刻时一并显示，今天/昨天用相对说法。
 * 症状可以精确到分钟（体温这类），报告类只有日期，显示不变。
 */
function formatMoment(value: string | null) {
  if (!value) return "";
  const datePart = value.slice(0, 10);
  const timePart = value.length > 10 ? value.slice(11, 16) : "";
  const pad = (input: number) => String(input).padStart(2, "0");
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const yesterdayKey = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
  const label = datePart === todayKey ? "今天" : datePart === yesterdayKey ? "昨天" : datePart;
  return timePart ? `${label} ${timePart}` : label;
}

function episodeMeta(item: CaseEpisode) {
  const parts = [episodeStatusOf(item.status).label];
  const onset = formatDay(item.onsetAt);
  if (onset) parts.push(`${onset} 起`);
  if (item.symptomCount) parts.push(`${item.symptomCount} 个症状`);
  return parts.join(" · ");
}

/** 时间轴节点的文案：时间由节点头部统一显示，这里不重复 */
function symptomMeta(item: CaseSymptom) {
  const parts = [symptomStatusOf(item.status)];
  if (item.measuredValue) parts.push(`${item.measuredValue}${item.measuredUnit ?? ""}`);
  if (item.durationText) parts.push(`持续${item.durationText}`);
  if (item.severity) parts.push(item.severity);
  if (item.bodyPart) parts.push(item.bodyPart);
  /* 挂报告时从主诉自动带出来的症状，标明来源，方便用户判断要不要留 */
  if (item.source === "ai") parts.push("来自报告主诉");
  return parts.join(" · ");
}

/** 就诊卡片里的症状文案：日期由卡片头显示，不重复 */
function symptomVisitMeta(item: CaseSymptom) {
  return symptomMeta(item);
}

/** 手动补录用药的展示文案：剂量 · 用法 · 频次（保留 tid/bid 原标签并补中文说明）。 */
function manualMedicationDetail(item: CaseMedication) {
  const dose = [item.dose, item.doseUnit].filter(Boolean).join("");
  return [dose || null, item.route, withFrequencyNote(item.frequency), "手动补录"]
    .filter(Boolean)
    .join(" · ");
}

/** 由出生日期算年龄，写进给医生看的摘要里 */
function ageText(birthDate: string | null) {
  if (!birthDate) return "";
  const birth = new Date(`${birthDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return "";
  const now = new Date();
  let months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (now.getDate() < birth.getDate()) months -= 1;
  if (months < 0) return "";
  if (months < 12) return `${months} 个月`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} 岁 ${rest} 个月` : `${years} 岁`;
}

/** 就医前摘要：去医院时说不清的那几句，让程序先写好 */
const doctorSummary = computed(() => {
  const current = detail.value;
  if (!current) return "";
  const member = app.selectedMember.value;
  const lines: string[] = [];
  const head = [member?.displayName ?? "", ageText(member?.birthDate ?? null)].filter(Boolean).join("，");
  lines.push(`【就诊摘要】${head || "（未选成员）"}`);
  const bits = [`起病 ${formatDay(current.episode.onsetAt) || "未记录"}`];
  if (episodeDurationText.value) bits.push(episodeDurationText.value);
  if (current.episode.causeText) bits.push(`病因 ${current.episode.causeText}`);
  lines.push(bits.join(" ｜ "));
  if (current.symptoms.length) {
    lines.push(
      `症状：${current.symptoms
        .map((item) => {
          const parts = [item.name];
          if (item.measuredValue) parts.push(`${item.measuredValue}${item.measuredUnit ?? ""}`);
          if (item.onsetAt) parts.push(formatMoment(item.onsetAt));
          parts.push(symptomStatusOf(item.status));
          return parts.join(" ");
        })
        .join("；")}`,
    );
  }
  for (const visit of visitBlocks.value) {
    const visitBits = [`${formatDay(visit.at)} ${[visit.place, visit.title].filter(Boolean).join(" ")}`.trim()];
    if (visit.diagnoses.length) visitBits.push(`诊断 ${visit.diagnoses.map((item) => item.title).join("、")}`);
    if (visit.medications.length) {
      visitBits.push(
        `用药 ${visit.medications.map((item) => [item.title, item.detail].filter(Boolean).join(" ")).join("、")}`,
      );
    }
    lines.push(`就诊：${visitBits.join("；")}`);
  }
  if (current.medications.length) {
    lines.push(
      `自行用药：${current.medications
        .map((item) => `${item.name}${item.dose ? ` ${item.dose}${item.doseUnit ?? ""}` : ""}`)
        .join("、")}`,
    );
  }
  return lines.join("\n");
});

/** 痊愈小结：这段病程一句话说完，以后回看不用重新读时间轴 */
const resolvedSummary = computed(() => {
  const current = detail.value;
  const episode = current?.episode;
  if (!current || !episode) return "";
  if (!(episode.status === "resolved" || episode.resolvedAt)) return "";
  const bits: string[] = [`${formatDay(episode.onsetAt) || "未记录"} 起病`];
  if (episode.causeText) bits.push(`病因 ${episode.causeText}`);
  const names = [...new Set(current.symptoms.map((item) => item.name))];
  if (names.length) bits.push(`症状 ${names.join("、")}`);
  if (visitBlocks.value.length) bits.push(`就诊 ${visitBlocks.value.length} 次`);
  const diagnoses = [...new Set(visitBlocks.value.flatMap((visit) => visit.diagnoses.map((item) => item.title)))];
  if (diagnoses.length) bits.push(`诊断 ${diagnoses.join("、")}`);
  const medicationCount = visitBlocks.value.reduce((sum, visit) => sum + visit.medications.length, 0);
  if (medicationCount) bits.push(`用药 ${medicationCount} 种`);
  bits.push(`${formatDay(episode.resolvedAt) || "已痊愈"} 痊愈`);
  return `本次病程${episodeDurationText.value ? `（${episodeDurationText.value}）` : ""}：${bits.join(" → ")}`;
});

async function copyDoctorSummary() {
  const text = doctorSummary.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.show("摘要已复制，可直接发给医生");
  } catch {
    toast.show("复制失败，请长按下面的文字选择复制");
  }
}

async function load(memberId: string, keepDetailId?: string) {
  if (!memberId) {
    detail.value = null;
    episodes.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const list = await request<CaseEpisode[]>(`episodes?memberId=${encodeURIComponent(memberId)}`);
    episodes.value = list;
    /* 详情仍在列表里就顺手刷新它，否则回到列表视图（切换成员、病程被删等） */
    if (keepDetailId && list.some((item) => item.id === keepDetailId)) {
      await openEpisode(keepDetailId, true);
    } else {
      detail.value = null;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载病程失败";
  } finally {
    loading.value = false;
  }
}

async function openEpisode(episodeId: string, silent = false) {
  if (!silent) loading.value = true;
  try {
    const data = await request<CaseEpisodeDetail>(`episodes/${episodeId}`);
    detail.value = data;
    causeDraft.value = data.episode.causeText ?? "";
    causeOpen.value = false;
    summaryOpen.value = false;
    quickInput.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载病程详情失败";
  } finally {
    if (!silent) loading.value = false;
  }
}

function back() {
  detail.value = null;
  formOpen.value = false;
  symptomFormOpen.value = false;
  medicationFormOpen.value = false;
  summaryOpen.value = false;
}

async function createEpisode() {
  const memberId = app.selectedMemberId.value;
  if (!memberId || saving.value) return;
  if (!episodeForm.value.title.trim()) {
    error.value = "病程标题不能为空";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    await request("episodes", {
      method: "POST",
      body: JSON.stringify({
        memberId,
        title: episodeForm.value.title,
        onsetAt: episodeForm.value.onsetAt || null,
        causeText: episodeForm.value.causeText || null,
      }),
    });
    episodeForm.value = { title: "", onsetAt: "", causeText: "" };
    formOpen.value = false;
    toast.show("病程已创建");
    await load(memberId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "创建病程失败";
  } finally {
    saving.value = false;
  }
}

async function patchEpisode(patch: Record<string, unknown>, message: string) {
  const episodeId = detail.value?.episode.id;
  if (!episodeId || saving.value) return;
  const memberId = app.selectedMemberId.value;
  saving.value = true;
  try {
    detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    toast.show(message);
    if (memberId) await load(memberId, episodeId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "更新病程失败";
  } finally {
    saving.value = false;
  }
}

async function saveCause() {
  const current = detail.value;
  if (!current) return;
  await patchEpisode({ causeText: causeDraft.value }, "病因已保存");
  if (detail.value) causeDraft.value = detail.value.episode.causeText ?? "";
  causeOpen.value = false;
}

async function saveSymptom() {
  const episodeId = detail.value?.episode.id;
  if (!episodeId || saving.value) return;
  if (!symptomForm.value.name.trim()) {
    error.value = "症状名称不能为空";
    return;
  }
  const editing = editingSymptomId.value;
  saving.value = true;
  error.value = "";
  try {
    const body = JSON.stringify({
      name: symptomForm.value.name,
      onsetAt: symptomForm.value.onsetAt || null,
      durationText: symptomForm.value.durationText || null,
      severity: symptomForm.value.severity || null,
      bodyPart: symptomForm.value.bodyPart || null,
      measuredValue: symptomForm.value.measuredValue || null,
      measuredUnit: symptomForm.value.measuredUnit || null,
      status: symptomForm.value.status,
    });
    detail.value = editing
      ? await request<CaseEpisodeDetail>(`symptoms/${editing}`, { method: "PUT", body })
      : await request<CaseEpisodeDetail>(`episodes/${episodeId}/symptoms`, { method: "POST", body });
    const logged = logSourceName.value;
    closeSymptomForm();
    toast.show(editing ? "症状已更新" : logged ? `已记一笔「${logged}」` : "症状已添加");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存症状失败";
  } finally {
    saving.value = false;
  }
}

/** 把已挂报告的主诉症状补录进来（给"自动补录功能上线前就挂好的报告"用）。 */
async function importSymptomsFromReports() {
  const episodeId = detail.value?.episode.id;
  if (!episodeId || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const before = detail.value?.symptoms.length ?? 0;
    detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}/symptoms-import`, { method: "POST" });
    const added = (detail.value?.symptoms.length ?? 0) - before;
    toast.show(added > 0 ? `已从报告补录 ${added} 条症状` : "没有可补录的症状（报告无主诉，或已补过）");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "补录症状失败";
  } finally {
    saving.value = false;
  }
}

async function saveMedication() {
  const episodeId = detail.value?.episode.id;
  if (!episodeId || saving.value) return;
  if (!medicationForm.value.name.trim()) {
    error.value = "药品名称不能为空";
    return;
  }
  const editing = editingMedicationId.value;
  saving.value = true;
  error.value = "";
  try {
    const body = JSON.stringify({
      name: medicationForm.value.name,
      dose: medicationForm.value.dose || null,
      frequency: medicationForm.value.frequency || null,
      route: medicationForm.value.route || null,
      startAt: medicationForm.value.startAt || null,
    });
    detail.value = editing
      ? await request<CaseEpisodeDetail>(`medications/${editing}`, { method: "PUT", body })
      : await request<CaseEpisodeDetail>(`episodes/${episodeId}/medications`, { method: "POST", body });
    closeMedicationForm();
    toast.show(editing ? "用药已更新" : "用药已添加");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存用药失败";
  } finally {
    saving.value = false;
  }
}

function removeMedication(medicationId: string) {
  if (saving.value) return;
  confirmDialog.ask({
    title: "删除用药",
    message: "确定删除这条用药记录？删掉后需要重新录入。",
    confirmText: "删除",
    danger: true,
    run: async () => {
      saving.value = true;
      try {
        detail.value = await request<CaseEpisodeDetail>(`medications/${medicationId}`, { method: "DELETE" });
        toast.show("用药已删除");
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "删除用药失败";
      } finally {
        saving.value = false;
      }
    },
  });
}

/** 删除病程（软删除）：报告与用药不动，只是不再归集到这段病程。 */
function removeEpisode(item: CaseEpisode) {
  if (saving.value) return;
  confirmDialog.ask({
    title: "删除病程",
    message: `确定删除「${item.title}」？报告和用药不会被删除，只是不再归集到这段病程。`,
    confirmText: "删除",
    danger: true,
    run: async () => {
      saving.value = true;
      try {
        await request(`episodes/${item.id}`, { method: "DELETE" });
        toast.show("病程已删除");
        if (detail.value?.episode.id === item.id) {
          detail.value = null;
          formOpen.value = false;
          symptomFormOpen.value = false;
        }
        const memberId = app.selectedMemberId.value;
        if (memberId) await load(memberId);
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "删除病程失败";
      } finally {
        saving.value = false;
      }
    },
  });
}

function removeSymptom(symptomId: string) {
  if (saving.value) return;
  confirmDialog.ask({
    title: "删除症状",
    message: "确定删除这条症状记录？删掉后需要重新录入。",
    confirmText: "删除",
    danger: true,
    run: async () => {
      saving.value = true;
      try {
        detail.value = await request<CaseEpisodeDetail>(`symptoms/${symptomId}`, { method: "DELETE" });
        toast.show("症状已删除");
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "删除症状失败";
      } finally {
        saving.value = false;
      }
    },
  });
}

watch(
  () => app.selectedMemberId.value,
  (memberId) => void load(memberId),
  { immediate: true },
);

/* AppShell 用 KeepAlive 缓存路由页面：从报告详情页「加入病程」后切回病程页时，
   组件不会重新创建，必须主动重拉，否则看到的是缓存里的旧列表。 */
let activatedOnce = false;
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true;
    return;
  }
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  void load(memberId, detail.value?.episode.id);
});
</script>

<template>
  <section class="plain-page">
    <template v-if="detail">
      <div class="page-intro page-intro--keep">
        <div>
          <h2>{{ detail.episode.title }}</h2>
          <p>{{ episodeMeta({ ...detail.episode, symptomCount: detail.symptoms.length }) }}</p>
        </div>
        <div class="episode-detail-actions">
          <button class="soft-action-button" type="button" @click="back">
            <ArrowLeft :size="16" />返回
          </button>
          <button
            class="soft-action-button danger-soft"
            type="button"
            :disabled="saving"
            @click="removeEpisode(detail.episode)"
          >
            <Trash2 :size="16" />删除病程
          </button>
        </div>
      </div>

      <p v-if="error" class="inline-panel-error">{{ error }}</p>

      <section class="settings-band entry-list-card">
        <header>
          <div><ClipboardList :size="18" /><h3>病程信息</h3></div>
          <span class="chip status-label" :class="episodeStatusOf(detail.episode.status).chip">
            {{ episodeStatusOf(detail.episode.status).label }}
          </span>
        </header>
        <div class="entry-list-body">
          <p class="episode-meta-line">
            <span>起病 {{ formatDay(detail.episode.onsetAt) || "未记录" }}</span>
            <span v-if="episodeDurationText">{{ episodeDurationText }}</span>
            <span v-if="detail.episode.causeText">病因 {{ detail.episode.causeText }}</span>
          </p>

          <!-- 病因收起：点一下才展开，腾出位置给下面的「快速记录」 -->
          <div v-if="!causeOpen" class="episode-cause-row">
            <button class="soft-action-button" type="button" @click="causeOpen = true">
              {{ detail.episode.causeText ? "改病因" : "填病因" }}
            </button>
            <span class="episode-cause-hint">病因只有你自己知道，系统不做推断</span>
          </div>
          <form v-else class="entry-form" @submit.prevent="saveCause">
            <label>
              <span>病因（自己填写，系统不做推断）</span>
              <input v-model="causeDraft" placeholder="例如 受凉、接触感冒的家人" />
            </label>
            <div class="form-actions">
              <button type="button" @click="causeOpen = false">取消</button>
              <button class="primary-button compact-primary" :disabled="saving">保存病因</button>
            </div>
          </form>

          <div class="episode-actions">
            <button
              v-if="detail.episode.status !== 'resolved'"
              class="soft-action-button"
              type="button"
              :disabled="saving"
              @click="patchEpisode({ status: 'resolved', resolvedAt: new Date().toISOString().slice(0, 10) }, '已标记为痊愈')"
            >
              <CheckCircle2 :size="15" />标记为已痊愈
            </button>
            <button
              v-else
              class="soft-action-button"
              type="button"
              :disabled="saving"
              @click="patchEpisode({ status: 'active', resolvedAt: null }, '已恢复为进行中')"
            >
              恢复为进行中
            </button>
          </div>
        </div>
      </section>

      <!-- 发热小结：发烧时医生一定会问的三件事 -->
      <section v-if="feverSummary" class="settings-band entry-list-card episode-fever-card">
        <header>
          <div><Thermometer :size="18" /><h3>发热小结</h3></div>
          <span class="count-label">共记录 {{ feverSummary.count }} 次</span>
        </header>
        <div class="entry-list-body">
          <div class="episode-fever-grid">
            <div>
              <span>最高</span>
              <strong>{{ feverSummary.highest }}℃</strong>
              <small>{{ formatMoment(feverSummary.highestAt) }}</small>
            </div>
            <div>
              <span>最近</span>
              <strong>{{ feverSummary.latest }}℃</strong>
              <small>{{ formatMoment(feverSummary.latestAt) }}</small>
            </div>
            <div>
              <span>发热天数</span>
              <strong>{{ feverSummary.days }} 天</strong>
              <small>{{ episodeDurationText || "—" }}</small>
            </div>
          </div>
        </div>
      </section>

      <!-- 快速记录：常用症状点一下就用当前时间开一条，「一句话记」回车填进表单 -->
      <section class="settings-band entry-list-card episode-quick-card">
        <header>
          <div><Plus :size="18" /><h3>快速记录</h3></div>
        </header>
        <div class="entry-list-body">
          <div class="episode-quick-chips">
            <button v-for="name in COMMON_SYMPTOMS" :key="name" type="button" @click="quickSymptom(name)">
              {{ name }}
            </button>
          </div>
          <label class="episode-quick-input">
            <span>一句话记（回车填入表单）</span>
            <input
              v-model="quickInput"
              placeholder="例如 5点半 37.5 ／ 下午吃氨溴特罗口服溶液5ml"
              @keydown.enter.prevent="applyQuickDraft"
            />
          </label>
          <p v-if="quickDraft" class="quick-entry-preview">
            <span>识别为</span>
            <strong>
              {{ quickDraft.kind === "medication" ? "用药" : "症状" }}「{{ quickDraft.name || "未提名称" }}」
            </strong>
            <template v-if="quickDraft.onsetAt"> · {{ quickDraft.onsetAt }}</template>
            <template v-if="quickDraft.measuredValue"> · {{ quickDraft.measuredValue }}{{ quickDraft.measuredUnit }}</template>
            <template v-if="quickDraft.dose"> · {{ quickDraft.dose }}</template>
            <template v-if="quickDraft.frequency"> · {{ quickDraft.frequency }}</template>
            <button type="button" @click="applyQuickDraft">填入</button>
          </p>
        </div>
      </section>

      <div class="page-intro page-intro--keep page-intro--actions-only episode-timeline-intro">
        <div>
          <h3>病程时间轴</h3>
          <p>{{ episodeDurationText ? `${episodeDurationText} · 按时间排成一条线` : "按时间排成一条线" }}</p>
        </div>
        <div class="episode-intro-actions">
          <button
            class="icon-action-button"
            type="button"
            :title="timelineDesc ? '改为从头看' : '最近的排前面'"
            :aria-label="timelineDesc ? '改为从头看' : '最近的排前面'"
            @click="timelineDesc = !timelineDesc"
          >
            <ArrowUpDown :size="17" />
          </button>
          <button
            class="icon-action-button"
            type="button"
            title="给医生看的摘要"
            aria-label="给医生看的摘要"
            @click="summaryOpen = !summaryOpen"
          >
            <FileText :size="17" />
          </button>
          <button
            class="icon-action-button"
            type="button"
            title="补录报告症状"
            aria-label="补录报告症状"
            :disabled="saving"
            @click="importSymptomsFromReports()"
          >
            <ClipboardList :size="17" />
          </button>
          <button class="soft-action-button" type="button" @click="toggleMedicationForm">
            <Plus :size="16" />添加用药
          </button>
          <button class="soft-action-button" type="button" @click="toggleSymptomForm">
            <Plus :size="16" />添加症状
          </button>
        </div>
      </div>

      <!-- 给医生看：赶去医院时说不清的那几句 -->
      <section v-if="summaryOpen" class="settings-band entry-list-card">
        <header>
          <div><FileText :size="18" /><h3>给医生看</h3></div>
          <button class="soft-action-button compact-soft" type="button" @click="copyDoctorSummary">
            <Copy :size="15" />复制
          </button>
        </header>
        <div class="entry-list-body">
          <pre class="episode-summary-text">{{ doctorSummary }}</pre>
          <p v-if="resolvedSummary" class="episode-resolved-summary">{{ resolvedSummary }}</p>
        </div>
      </section>

      <section v-if="symptomFormOpen" class="settings-band entry-list-card">
        <header>
          <div>
            <Plus :size="18" />
            <h3 v-if="editingSymptomId">编辑症状</h3>
            <h3 v-else-if="logSourceName">记一笔：{{ logSourceName }}</h3>
            <h3 v-else>添加症状</h3>
          </div>
        </header>
        <div class="entry-list-body">
          <form class="entry-form" @submit.prevent="saveSymptom">
            <div class="form-grid">
              <label><span>症状名称</span><input v-model="symptomForm.name" placeholder="例如 咳嗽" /></label>
              <label>
                <span>出现时间（点一下才改）</span>
                <DateTimePicker v-model="symptomForm.onsetAt" aria-label="症状出现时间" show-time variant="plain" />
              </label>
              <label>
                <span>当前状态</span>
                <select v-model="symptomForm.status">
                  <option value="present">存在</option>
                  <option value="improved">好转</option>
                  <option value="resolved">已消失</option>
                  <option value="unknown">不确定</option>
                </select>
              </label>
              <label><span>数值</span><input v-model="symptomForm.measuredValue" placeholder="例如 37.5" /></label>
              <label><span>单位</span><input v-model="symptomForm.measuredUnit" placeholder="例如 ℃" /></label>
              <label><span>持续时长</span><input v-model="symptomForm.durationText" placeholder="例如 半天、3天" /></label>
              <label><span>程度</span><input v-model="symptomForm.severity" placeholder="例如 轻、中、重" /></label>
              <label><span>部位</span><input v-model="symptomForm.bodyPart" placeholder="例如 咽喉" /></label>
            </div>
            <div class="form-actions">
              <button type="button" @click="closeSymptomForm()">取消</button>
              <button class="primary-button" :disabled="saving">保存</button>
            </div>
          </form>
        </div>
      </section>

      <section v-if="medicationFormOpen" class="settings-band entry-list-card">
        <header>
          <div><Plus :size="18" /><h3>{{ editingMedicationId ? "编辑用药" : "添加用药" }}</h3></div>
        </header>
        <div class="entry-list-body">
          <form class="entry-form" @submit.prevent="saveMedication">
            <div class="form-grid">
              <label><span>药品名称</span><input v-model="medicationForm.name" placeholder="例如 氨溴特罗口服溶液" /></label>
              <label>
                <span>开始日期（点一下才改）</span>
                <DateTimePicker v-model="medicationForm.startAt" aria-label="用药开始日期" variant="plain" />
              </label>
              <label><span>单次剂量</span><input v-model="medicationForm.dose" placeholder="例如 5ml、半片" /></label>
              <label><span>服药频次</span><input v-model="medicationForm.frequency" placeholder="例如 tid（每日三次）" /></label>
              <label><span>用法</span><input v-model="medicationForm.route" placeholder="例如 口服、外用" /></label>
            </div>
            <div class="form-actions">
              <button type="button" @click="closeMedicationForm()">取消</button>
              <button class="primary-button" :disabled="saving">保存</button>
            </div>
          </form>
        </div>
      </section>

      <p
        v-if="!detail.symptoms.length && !detail.medications.length && !detail.linkedFacts.length"
        class="preview-hint"
      >
        还没有内容。到报告详情页点「加入病程」挂上报告，或用上方的快捷按钮补录症状与用药。
      </p>
      <ol v-else class="episode-timeline">
        <li
          v-for="block in displayTimeline"
          :key="block.key"
          :class="
            block.type === 'visit'
              ? 'episode-event episode-event--visit'
              : `episode-event episode-event--${block.kind}`
          "
        >
          <span class="episode-dot" aria-hidden="true"></span>

          <!-- 一次就诊 = 一张卡片：报告、诊断、用药、症状合在一起，不再各占一行各说一遍 -->
          <div v-if="block.type === 'visit'" class="episode-event-body episode-visit">
            <div class="episode-visit-head">
              <time v-if="block.at">{{ formatMoment(block.at) }}</time>
              <strong>{{ block.title }}</strong>
              <small v-if="block.place">{{ block.place }}</small>
            </div>
            <dl class="episode-visit-fields">
              <template v-if="block.symptoms.length">
                <dt>症状</dt>
                <dd>
                  <span v-for="item in block.symptoms" :key="item.key" class="episode-visit-line">
                    <span class="episode-visit-line-text">
                      {{ item.title }}<template v-if="item.detail"> · {{ item.detail }}</template>
                    </span>
                    <button v-if="item.logAgain" type="button" :disabled="saving" @click="item.logAgain()">记一笔</button>
                    <button v-if="item.edit" type="button" :disabled="saving" @click="item.edit()">编辑</button>
                    <button
                      v-if="item.remove"
                      class="danger-action"
                      type="button"
                      :disabled="saving"
                      @click="item.remove()"
                    >
                      移除
                    </button>
                  </span>
                </dd>
              </template>
              <template v-if="block.diagnoses.length">
                <dt>诊断</dt>
                <dd>
                  <span v-for="item in block.diagnoses" :key="item.key" class="episode-visit-line">
                    <span class="episode-visit-line-text">{{ item.title }}</span>
                    <button
                      v-if="item.remove"
                      class="danger-action"
                      type="button"
                      :disabled="saving"
                      @click="item.remove()"
                    >
                      移除
                    </button>
                  </span>
                </dd>
              </template>
              <template v-if="block.medications.length">
                <dt>医生开药</dt>
                <dd>
                  <span v-for="item in block.medications" :key="item.key" class="episode-visit-line">
                    <span class="episode-visit-line-text">
                      {{ item.title }}<template v-if="item.detail && item.detail !== '用药'"> · {{ item.detail }}</template>
                      <em v-if="item.warn">缺剂量</em>
                    </span>
                    <button
                      v-if="item.remove"
                      class="danger-action"
                      type="button"
                      :disabled="saving"
                      @click="item.remove()"
                    >
                      移除
                    </button>
                  </span>
                </dd>
              </template>
              <template v-if="block.procedures.length">
                <dt>操作</dt>
                <dd>
                  <span v-for="item in block.procedures" :key="item.key" class="episode-visit-line">
                    <span class="episode-visit-line-text">{{ item.title }}</span>
                  </span>
                </dd>
              </template>
              <template v-if="block.vaccinations.length">
                <dt>疫苗</dt>
                <dd>
                  <span v-for="item in block.vaccinations" :key="item.key" class="episode-visit-line">
                    <span class="episode-visit-line-text">{{ item.title }}</span>
                  </span>
                </dd>
              </template>
              <template v-if="block.others.length">
                <dt>其他</dt>
                <dd>
                  <span v-for="item in block.others" :key="item.key" class="episode-visit-line">
                    <span class="episode-visit-line-text">{{ item.title }}</span>
                    <button
                      v-if="item.remove"
                      class="danger-action"
                      type="button"
                      :disabled="saving"
                      @click="item.remove()"
                    >
                      移除
                    </button>
                  </span>
                </dd>
              </template>
            </dl>
            <p v-if="block.gaps.length" class="episode-visit-gaps">提示：{{ block.gaps.join("；") }}</p>
            <div class="row-actions">
              <button type="button" @click="previewReportId = block.reportId">查看报告</button>
              <button
                class="danger-action"
                type="button"
                :disabled="saving"
                @click="unlinkFact('report', block.reportId)"
              >
                <Trash2 :size="15" />移除这次就诊
              </button>
            </div>
          </div>

          <div v-else class="episode-event-body">
            <div class="episode-event-head">
              <span class="chip status-label">{{ block.badge }}</span>
              <time v-if="block.at">{{ formatMoment(block.at) }}</time>
            </div>
            <div class="episode-event-items">
              <div v-for="item in block.items" :key="item.key" class="episode-event-item">
                <strong>{{ item.title }}</strong>
                <small v-if="item.detail">{{ item.detail }}</small>
                <div v-if="item.edit || item.logAgain || item.remove || item.derived" class="row-actions">
                  <button v-if="item.logAgain" type="button" :disabled="saving" @click="item.logAgain()">
                    <Activity :size="15" />记一笔
                  </button>
                  <button v-if="item.edit" type="button" :disabled="saving" @click="item.edit()">编辑</button>
                  <button v-if="item.remove" class="danger-action" type="button" :disabled="saving" @click="item.remove()">
                    <Trash2 :size="15" />移除
                  </button>
                  <span v-else-if="item.derived" class="derived-hint">随报告记入</span>
                </div>
              </div>
            </div>
          </div>
        </li>
      </ol>
      <div class="episode-bottom-spacer" aria-hidden="true"></div>
    </template>

    <template v-else>
      <div class="page-intro page-intro--keep page-intro--actions-only">
        <div><h2>病程</h2><p>把同一次生病的多次就诊串成一条线</p></div>
        <button class="primary-button compact-primary" type="button" @click="formOpen = !formOpen">
          <Plus :size="17" />新建病程
        </button>
      </div>

      <p v-if="error" class="inline-panel-error">{{ error }}</p>

      <section v-if="formOpen" class="settings-band entry-list-card">
        <header>
          <div><Plus :size="18" /><h3>新建病程</h3></div>
        </header>
        <div class="entry-list-body">
          <form class="entry-form" @submit.prevent="createEpisode">
            <div class="form-grid">
              <label><span>病程标题</span><input v-model="episodeForm.title" placeholder="例如 10月呼吸道感染" /></label>
              <label><span>起病日期</span><DateTimePicker v-model="episodeForm.onsetAt" aria-label="起病日期" /></label>
              <label><span>病因（可留空）</span><input v-model="episodeForm.causeText" placeholder="例如 受凉" /></label>
            </div>
            <div class="form-actions">
              <button type="button" @click="formOpen = false">取消</button>
              <button class="primary-button" :disabled="saving">保存</button>
            </div>
          </form>
        </div>
      </section>

      <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
      <EmptyState
        v-else-if="!episodes.length"
        title="还没有病程"
        description="孩子每生一次病就建一条病程，之后可以把这次相关的报告、用药都挂上去。"
      />
      <section v-else class="settings-band entry-list-card">
        <header>
          <div><ClipboardList :size="18" /><h3>全部病程</h3></div>
          <span class="count-label">共 {{ episodes.length }} 段</span>
        </header>
        <div class="entry-list-body">
          <div v-for="item in episodes" :key="item.id" class="entry-row">
            <button class="entry-row-main entry-row-open" type="button" @click="openEpisode(item.id)">
              <strong>{{ item.title }}</strong>
              <span>{{ episodeMeta(item) }}</span>
              <small v-if="item.causeText">病因：{{ item.causeText }}</small>
            </button>
            <span class="entry-row-side">
              <span class="chip status-label" :class="episodeStatusOf(item.status).chip">
                {{ episodeStatusOf(item.status).label }}
              </span>
              <button
                class="entry-row-remove"
                type="button"
                :disabled="saving"
                :title="`删除「${item.title}」`"
                :aria-label="`删除病程 ${item.title}`"
                @click="removeEpisode(item)"
              >
                <Trash2 :size="15" />
              </button>
            </span>
          </div>
        </div>
      </section>
    </template>

    <ReportDetailModal
      :open="Boolean(previewReportId)"
      :report-id="previewReportId"
      @close="previewReportId = null"
    />
  </section>
</template>
