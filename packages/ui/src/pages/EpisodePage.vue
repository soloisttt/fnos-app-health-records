<script setup lang="ts">
import { computed, ref, watch, onActivated } from "vue";
import {
  ArrowLeft,
  ArrowUpDown,
  CheckCircle2,
  ClipboardList,
  Copy,
  FileText,
  Package,
  Plus,
  Thermometer,
  Trash2,
} from "@lucide/vue";
import DateTimePicker from "../components/DateTimePicker.vue";
import EmptyState from "../components/EmptyState.vue";
import EpisodeEntrySheet, {
  type EpisodeSheetForm,
  type EpisodeSheetIntent,
  type EpisodeSheetMode,
} from "../components/EpisodeEntrySheet.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { request } from "../utils/api";
import type {
  CaseEpisode,
  CaseEpisodeDetail,
  CaseEpisodeLinkFactType,
  CaseMedication,
  CaseMedicationIntake,
  CaseSymptom,
  CaseSymptomStatus,
  EpisodeLinkedFact,
} from "../types/api";
import { withFrequencyNote } from "../utils/medication-frequency";
import { parseQuickEntry, type QuickEntryDraft } from "../utils/quick-entry";
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
const previewReportId = ref<string | null>(null);
const causeOpen = ref(false);
const causeDraft = ref("");
const summaryOpen = ref(false);
const quickInput = ref("");

/** 常用症状：第一次记录某个症状时不用打字 */
const COMMON_SYMPTOMS = ["发热", "咳嗽", "流鼻涕", "鼻塞", "腹泻", "呕吐", "皮疹"];

/** 刚快速记完的那一条：给一行可点的提示，识别错了也有地方改 */
const lastHint = ref<{ text: string; mode: EpisodeSheetMode; id: string } | null>(null);

const factTypeLabels: Record<CaseEpisodeLinkFactType, string> = {
  report: "报告",
  diagnosis: "诊断",
  medication: "用药",
  procedure: "操作",
  vaccination: "疫苗",
  observation: "指标",
  section: "章节",
};

function nowLocal() {
  const current = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())} ${pad(current.getHours())}:${pad(current.getMinutes())}`;
}

function emptySheetForm(): EpisodeSheetForm {
  return {
    name: "",
    at: nowLocal(),
    status: "present",
    value: "",
    unit: "",
    severity: "",
    bodyPart: "",
    dose: "",
    frequency: "",
    route: "",
  };
}

/* ------------------------------------------------ 小面板（记一次 / 编辑） */

const sheet = ref({
  open: false,
  mode: "symptom" as EpisodeSheetMode,
  intent: "log" as EpisodeSheetIntent,
  subject: "",
  showValue: false,
  id: "" as string,
  reportId: null as string | null,
  form: emptySheetForm(),
});

const sheetForm = computed(() => sheet.value.form);

function openSheet(options: {
  mode: EpisodeSheetMode;
  intent: EpisodeSheetIntent;
  subject?: string;
  showValue?: boolean;
  id?: string;
  reportId?: string | null;
  form: Partial<EpisodeSheetForm>;
}) {
  sheet.value = {
    open: true,
    mode: options.mode,
    intent: options.intent,
    subject: options.subject ?? "",
    showValue: options.showValue ?? false,
    id: options.id ?? "",
    reportId: options.reportId ?? null,
    form: { ...emptySheetForm(), ...options.form },
  };
}

function closeSheet() {
  sheet.value = { ...sheet.value, open: false };
}

/** 症状名值得显示数值的：体温/发热这类，或本来就有单位 */
function nameHasValue(name: string, unit?: string | null) {
  return /发热|体温|温度|发烧|血压/.test(name) || unit === "℃";
}

async function submitSheet(values: EpisodeSheetForm, repeat: boolean) {
  const episodeId = detail.value?.episode.id;
  const entry = sheet.value;
  if (!episodeId || saving.value) return;
  if (!values.name.trim()) {
    error.value = entry.mode === "medication" ? "药品名称不能为空" : "症状名称不能为空";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    if (entry.mode === "symptom") {
      const body = JSON.stringify({
        name: values.name,
        onsetAt: values.at || null,
        status: values.status,
        measuredValue: values.value || null,
        measuredUnit: values.unit || null,
        severity: values.severity || null,
        bodyPart: values.bodyPart || null,
      });
      const before = new Set((detail.value?.symptoms ?? []).map((item) => item.id));
      detail.value =
        entry.intent === "edit" && entry.id
          ? await request<CaseEpisodeDetail>(`symptoms/${entry.id}`, { method: "PUT", body })
          : await request<CaseEpisodeDetail>(`episodes/${episodeId}/symptoms`, { method: "POST", body });
      const created = entry.intent === "edit" ? null : detail.value.symptoms.find((item) => !before.has(item.id));
      const target = created ?? detail.value.symptoms.find((item) => item.id === entry.id);
      lastHint.value = target
        ? {
            text: `${entry.intent === "edit" ? "已更新" : "已记入"}「${target.name}${values.value ? ` ${values.value}${values.unit ?? ""}` : ""}」`,
            mode: "symptom",
            id: target.id,
          }
        : null;
      toast.show(entry.intent === "edit" ? "症状已更新" : "已记入症状");
    } else if (entry.intent === "log") {
      const before = new Set((detail.value?.intakes ?? []).map((item) => item.id));
      detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}/intakes`, {
        method: "POST",
        body: JSON.stringify({
          medicationName: values.name,
          dose: values.dose || null,
          route: values.route || null,
          takenAt: values.at || null,
          sourceReportId: entry.reportId,
        }),
      });
      const created = detail.value.intakes.find((item) => !before.has(item.id));
      lastHint.value = {
        text: `已记入服药「${values.name}${values.dose ? ` ${values.dose}` : ""}」`,
        mode: "medication",
        id: created?.id ?? "",
      };
      toast.show("已记入服药");
    } else {
      const body = JSON.stringify({
        name: values.name,
        dose: values.dose || null,
        frequency: values.frequency || null,
        route: values.route || null,
        startAt: values.at ? values.at.slice(0, 10) : null,
      });
      const before = new Set((detail.value?.medications ?? []).map((item) => item.id));
      detail.value =
        entry.intent === "edit" && entry.id
          ? await request<CaseEpisodeDetail>(`medications/${entry.id}`, { method: "PUT", body })
          : await request<CaseEpisodeDetail>(`episodes/${episodeId}/medications`, { method: "POST", body });
      const created = entry.intent === "edit" ? null : detail.value.medications.find((item) => !before.has(item.id));
      const target = created ?? detail.value.medications.find((item) => item.id === entry.id);
      lastHint.value = target ? { text: `已记入用药「${target.name}」`, mode: "medication", id: target.id } : null;
      toast.show(entry.intent === "edit" ? "用药已更新" : "用药已添加");
    }

    if (repeat) {
      /* 「保存并再记一条」：时间挪到此刻、清掉数值，面板留着继续记 */
      sheet.value = {
        ...sheet.value,
        form: { ...values, at: nowLocal(), value: "", dose: "" },
      };
    } else {
      closeSheet();
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

/** 点提示条 → 打开该条的编辑面板 */
function editHint() {
  const hint = lastHint.value;
  if (!hint) return;
  if (hint.mode === "symptom") {
    const target = detail.value?.symptoms.find((item) => item.id === hint.id);
    if (target) editSymptom(target);
    return;
  }
  const intake = detail.value?.intakes.find((item) => item.id === hint.id);
  if (intake) {
    openSheet({
      mode: "medication",
      intent: "log",
      subject: intake.medicationName,
      reportId: intake.sourceReportId,
      form: {
        name: intake.medicationName,
        at: intake.takenAt ?? nowLocal(),
        dose: intake.dose ?? "",
        route: intake.route ?? "",
      },
    });
    return;
  }
  const medication = detail.value?.medications.find((item) => item.id === hint.id);
  if (medication) editMedication(medication);
}

/* ------------------------------------------------ 快速记录区 */

/** 可点一下就记的症状：本病程已有的症状 + 还没出现过的常用症状 */
const symptomChips = computed(() => {
  const existing = new Map<string, CaseSymptom>();
  for (const item of detail.value?.symptoms ?? []) existing.set(item.name, item);
  const chips: Array<{ name: string; unit: string; showValue: boolean; existing: boolean }> = [];
  for (const [name, item] of existing) {
    chips.push({
      name,
      unit: item.measuredUnit ?? (nameHasValue(name) ? "℃" : ""),
      showValue: nameHasValue(name, item.measuredUnit),
      existing: true,
    });
  }
  for (const name of COMMON_SYMPTOMS) {
    if (existing.has(name)) continue;
    chips.push({ name, unit: nameHasValue(name) ? "℃" : "", showValue: nameHasValue(name), existing: false });
  }
  return chips;
});

/** 可点一下就记的药：医生开的药 + 自己补录的药；用量优先用「上次记的」 */
const medicationChips = computed(() => {
  const chips = new Map<string, { name: string; dose: string; route: string; reportId: string | null }>();
  for (const fact of detail.value?.linkedFacts ?? []) {
    if (fact.factType !== "medication") continue;
    if (chips.has(fact.label)) continue;
    chips.set(fact.label, { name: fact.label, dose: "", route: "", reportId: fact.reportId });
  }
  for (const item of detail.value?.medications ?? []) {
    const existing = chips.get(item.name);
    if (existing) {
      if (!existing.dose && item.dose) existing.dose = [item.dose, item.doseUnit].filter(Boolean).join("");
      if (!existing.route && item.route) existing.route = item.route;
      continue;
    }
    chips.set(item.name, {
      name: item.name,
      dose: [item.dose, item.doseUnit].filter(Boolean).join(""),
      route: item.route ?? "",
      reportId: item.reportId,
    });
  }
  /* 上次喂过的量直接预填，点开就能存 */
  for (const intake of [...(detail.value?.intakes ?? [])].reverse()) {
    const chip = chips.get(intake.medicationName);
    if (chip && !chip.dose && intake.dose) chip.dose = [intake.dose, intake.doseUnit].filter(Boolean).join("");
  }
  return [...chips.values()];
});

function logSymptom(chip: { name: string; unit: string; showValue: boolean; existing: boolean }) {
  const history = (detail.value?.symptoms ?? []).filter((item) => item.name === chip.name);
  const latest = history[history.length - 1];
  openSheet({
    mode: "symptom",
    intent: "log",
    subject: chip.name,
    showValue: chip.showValue,
    form: {
      name: chip.name,
      at: nowLocal(),
      status: latest ? latest.status : "present",
      unit: latest?.measuredUnit ?? chip.unit,
      severity: latest?.severity ?? "",
      bodyPart: latest?.bodyPart ?? "",
    },
  });
}

function logMedication(chip: { name: string; dose: string; route: string; reportId: string | null }) {
  openSheet({
    mode: "medication",
    intent: "log",
    subject: chip.name,
    reportId: chip.reportId,
    form: { name: chip.name, at: nowLocal(), dose: chip.dose, route: chip.route },
  });
}

function supplementSymptom() {
  openSheet({ mode: "symptom", intent: "create", form: { at: nowLocal() } });
}

function supplementMedication() {
  openSheet({ mode: "medication", intent: "create", form: { at: nowLocal() } });
}

/* 「一句话记」：解析出来直接入库，不再弹表单（识别不准时用提示条上的「修改」兜底） */
const quickDraft = computed(() => {
  const text = quickInput.value.trim();
  if (!text) return null;
  const parsed = parseQuickEntry(text);
  if (!parsed.matched && !parsed.name) return null;
  return parsed;
});

function quickDraftText(parsed: QuickEntryDraft) {
  const bits = [parsed.kind === "medication" ? "服药" : "症状", `「${parsed.name || "未提名称"}」`];
  if (parsed.measuredValue) bits.push(`${parsed.measuredValue}${parsed.measuredUnit ?? ""}`);
  if (parsed.dose) bits.push(parsed.dose);
  if (parsed.frequency) bits.push(parsed.frequency);
  if (parsed.onsetAt) bits.push(parsed.onsetAt);
  return bits.join(" · ");
}

async function applyQuickDraft() {
  const parsed = quickDraft.value;
  const episodeId = detail.value?.episode.id;
  if (!parsed || !episodeId || saving.value) return;
  /* 什么都没识别出来（例如只打了时间）→ 交给表单补 */
  if (!parsed.name) {
    if (parsed.kind === "medication") supplementMedication();
    else supplementSymptom();
    return;
  }
  const isMedication = parsed.kind === "medication";
  saving.value = true;
  error.value = "";
  try {
    if (isMedication) {
      const before = new Set((detail.value?.intakes ?? []).map((item) => item.id));
      detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}/intakes`, {
        method: "POST",
        body: JSON.stringify({
          medicationName: parsed.name,
          dose: parsed.dose || null,
          route: parsed.route || null,
          takenAt: parsed.onsetAt || nowLocal(),
        }),
      });
      const created = detail.value.intakes.find((item) => !before.has(item.id));
      lastHint.value = {
        text: `已记入服药「${parsed.name}${parsed.dose ? ` ${parsed.dose}` : ""}」`,
        mode: "medication",
        id: created?.id ?? "",
      };
    } else {
      const before = new Set((detail.value?.symptoms ?? []).map((item) => item.id));
      detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}/symptoms`, {
        method: "POST",
        body: JSON.stringify({
          name: parsed.name,
          onsetAt: parsed.onsetAt || nowLocal(),
          status: "present",
          measuredValue: parsed.measuredValue || null,
          measuredUnit: parsed.measuredUnit || null,
        }),
      });
      const created = detail.value.symptoms.find((item) => !before.has(item.id));
      lastHint.value = created
        ? {
            text: `已记入「${created.name}${parsed.measuredValue ? ` ${parsed.measuredValue}${parsed.measuredUnit ?? ""}` : ""}」`,
            mode: "symptom",
            id: created.id,
          }
        : null;
    }
    toast.show(isMedication ? "已记入服药" : "已记入症状");
    quickInput.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "记录失败";
  } finally {
    saving.value = false;
  }
}

/* ------------------------------------------------ 时间轴 */

type TimelineItem = {
  key: string;
  title: string;
  detail: string | null;
  /** 体温数值（按高低上色），没有则 null */
  value: { text: string; level: "normal" | "mid" | "high" } | null;
  reportId: string | null;
  derived: boolean;
  warn: boolean;
  edit: (() => void) | null;
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

/** 体温分档：38.5 是常见「要不要吃退烧药」的门槛，所以低热单独一档 */
function temperatureLevel(value: string | null, unit: string | null) {
  if (!value) return null;
  const number = Number(value);
  const looksLikeTemperature = unit === "℃" || (number >= 30 && number <= 45);
  if (!looksLikeTemperature || !Number.isFinite(number)) return null;
  const level = number >= 38.5 ? "high" : number >= 37.5 ? "mid" : "normal";
  return { text: `${value}${unit ?? ""}`, level } as const;
}

/** 同一条症状「距上次多久」，用来一眼看出变化节奏 */
function gapText(item: CaseSymptom, all: CaseSymptom[]) {
  if (!item.onsetAt) return "";
  const previous = all
    .filter((other) => other.name === item.name && other.id !== item.id && (other.onsetAt ?? "") < item.onsetAt!)
    .sort((left, right) => (left.onsetAt ?? "").localeCompare(right.onsetAt ?? ""))
    .at(-1);
  if (!previous?.onsetAt) return "";
  const diff = new Date(item.onsetAt.replace(" ", "T")).getTime() - new Date(previous.onsetAt.replace(" ", "T")).getTime();
  if (!Number.isFinite(diff) || diff <= 0) return "";
  const hours = diff / 3_600_000;
  if (hours < 1) return `距上次 ${Math.max(1, Math.round(diff / 60_000))} 分钟`;
  if (hours < 48) return `距上次 ${Math.round(hours)} 小时`;
  return `距上次 ${Math.round(hours / 24)} 天`;
}

function symptomItem(item: CaseSymptom, all: CaseSymptom[]): TimelineItem {
  return {
    key: `symptom:${item.id}`,
    title: item.name,
    detail: symptomMeta(item, all),
    value: temperatureLevel(item.measuredValue, item.measuredUnit),
    reportId: null,
    derived: false,
    warn: false,
    edit: () => editSymptom(item),
    remove: () => void removeSymptom(item.id),
  };
}

function factItem(fact: EpisodeLinkedFact): TimelineItem {
  return {
    key: `fact:${fact.linkId}`,
    title: fact.label,
    detail: factDetail(fact),
    value: null,
    reportId: fact.reportId,
    derived: fact.derived,
    warn: fact.factType === "medication" && (fact.detail ?? "").trim() === "用药",
    /* 由报告展开出的条目跟随报告，不单独编辑或移除；要改就改报告本身 */
    edit: null,
    remove: fact.derived ? null : () => void unlinkFact(fact.factType, fact.factId),
  };
}

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
    /* 报告本身不单独成条：它已经变成下面那张就诊卡片 */
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
    const item = symptomItem(symptom, current.symptoms);
    if (visit) {
      visit.symptoms.push({ ...item, key: `visit-symptom:${symptom.id}` });
      continue;
    }
    pushLoose("symptom", "症状", symptom.onsetAt, item);
  }

  /* 自己补录的药（医生没开、或报告没抽到） */
  for (const medication of current.medications) {
    pushLoose("medication", factTypeLabels.medication, medication.startAt, {
      key: `medication:${medication.id}`,
      title: medication.name,
      detail: manualMedicationDetail(medication),
      value: null,
      reportId: null,
      derived: false,
      warn: false,
      edit: () => editMedication(medication),
      remove: () => void removeMedication(medication.id),
    });
  }

  /* 服药记录：每次实际服用一条 */
  for (const intake of current.intakes ?? []) {
    pushLoose("intake", "服药", intake.takenAt, {
      key: `intake:${intake.id}`,
      title: intake.medicationName,
      detail: intakeDetail(intake),
      value: null,
      reportId: null,
      derived: false,
      warn: false,
      edit: () => editIntake(intake),
      remove: () => void removeIntake(intake.id),
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
          value: null,
          reportId: null,
          derived: false,
          warn: false,
          edit: null,
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
    (item) => item.measuredValue && nameHasValue(item.name, item.measuredUnit),
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

function emptySymptomForm() {
  return {
    name: "",
    onsetAt: nowLocal(),
    durationText: "",
    severity: "",
    bodyPart: "",
    measuredValue: "",
    measuredUnit: "",
    status: "present" as CaseSymptomStatus,
  };
}

const episodeStatusMeta: Record<CaseEpisode["status"], { label: string; chip: string }> = {
  active: { label: "进行中", chip: "chip--amber" },
  resolved: { label: "已痊愈", chip: "chip--green" },
  chronic: { label: "慢性", chip: "" },
  unknown: { label: "未记录", chip: "" },
};

const symptomStatusLabel: Record<CaseSymptomStatus, string> = {
  present: "存在",
  improved: "减轻",
  worse: "加重",
  resolved: "消失",
  unknown: "不确定",
};

function episodeStatusOf(status: CaseEpisode["status"]) {
  return episodeStatusMeta[status] ?? episodeStatusMeta.unknown;
}

function symptomStatusOf(status: CaseSymptomStatus) {
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

function factDetail(fact: EpisodeLinkedFact) {
  if (fact.missing) return "内容已不存在，可移除这条归集";
  const parts = [fact.detail, fact.reportTitle, fact.hospitalName, formatDay(fact.occurredAt)];
  return parts.filter(Boolean).join(" · ");
}

function episodeMeta(item: CaseEpisode) {
  const parts = [episodeStatusOf(item.status).label];
  const onset = formatDay(item.onsetAt);
  if (onset) parts.push(`${onset} 起`);
  if (item.symptomCount) parts.push(`${item.symptomCount} 个症状`);
  return parts.join(" · ");
}

/** 时间轴节点的文案：时间由节点头部统一显示，这里不重复 */
function symptomMeta(item: CaseSymptom, all: CaseSymptom[]) {
  const parts = [symptomStatusOf(item.status)];
  const value = temperatureLevel(item.measuredValue, item.measuredUnit);
  if (item.measuredValue && !value) parts.push(`${item.measuredValue}${item.measuredUnit ?? ""}`);
  if (item.durationText) parts.push(`持续${item.durationText}`);
  if (item.severity) parts.push(item.severity);
  if (item.bodyPart) parts.push(item.bodyPart);
  const gap = gapText(item, all);
  if (gap) parts.push(gap);
  if (item.source === "ai") parts.push("来自报告主诉");
  return parts.join(" · ");
}

function manualMedicationDetail(item: CaseMedication) {
  const dose = [item.dose, item.doseUnit].filter(Boolean).join("");
  return [dose || null, item.route, withFrequencyNote(item.frequency), "手动补录"]
    .filter(Boolean)
    .join(" · ");
}

function intakeDetail(item: CaseMedicationIntake) {
  const dose = [item.dose, item.doseUnit].filter(Boolean).join("");
  return [dose || null, item.route].filter(Boolean).join(" · ") || null;
}

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
  if ((current.intakes ?? []).length) {
    lines.push(
      `服药记录：${(current.intakes ?? [])
        .map((item) => `${item.medicationName}${item.dose ? ` ${item.dose}${item.doseUnit ?? ""}` : ""} ${formatMoment(item.takenAt)}`)
        .join("；")}`,
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
  if ((current.intakes ?? []).length) bits.push(`服药 ${(current.intakes ?? []).length} 次`);
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

function editSymptom(item: CaseSymptom) {
  openSheet({
    mode: "symptom",
    intent: "edit",
    subject: item.name,
    showValue: nameHasValue(item.name, item.measuredUnit),
    id: item.id,
    form: {
      name: item.name,
      at: item.onsetAt ?? nowLocal(),
      status: item.status,
      value: item.measuredValue ?? "",
      unit: item.measuredUnit ?? "",
      severity: item.severity ?? "",
      bodyPart: item.bodyPart ?? "",
    },
  });
}

function editMedication(item: CaseMedication) {
  openSheet({
    mode: "medication",
    intent: "edit",
    subject: item.name,
    id: item.id,
    form: {
      name: item.name,
      at: item.startAt ?? nowLocal(),
      dose: [item.dose, item.doseUnit].filter(Boolean).join(""),
      frequency: item.frequency ?? "",
      route: item.route ?? "",
    },
  });
}

function editIntake(item: CaseMedicationIntake) {
  openSheet({
    mode: "medication",
    intent: "log",
    subject: item.medicationName,
    reportId: item.sourceReportId,
    form: {
      name: item.medicationName,
      at: item.takenAt ?? nowLocal(),
      dose: [item.dose, item.doseUnit].filter(Boolean).join(""),
      route: item.route ?? "",
    },
  });
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

function removeIntake(intakeId: string) {
  if (saving.value) return;
  confirmDialog.ask({
    title: "删除服药记录",
    message: "确定删除这条服药记录？删掉后需要重新记录。",
    confirmText: "删除",
    danger: true,
    run: async () => {
      saving.value = true;
      try {
        detail.value = await request<CaseEpisodeDetail>(`intakes/${intakeId}`, { method: "DELETE" });
        toast.show("服药记录已删除");
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "删除服药记录失败";
      } finally {
        saving.value = false;
      }
    },
  });
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
    lastHint.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载病程详情失败";
  } finally {
    if (!silent) loading.value = false;
  }
}

function back() {
  detail.value = null;
  formOpen.value = false;
  summaryOpen.value = false;
  lastHint.value = null;
  closeSheet();
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
  await patchEpisode({ causeText: causeDraft.value }, "病因已保存");
  if (detail.value) causeDraft.value = detail.value.episode.causeText ?? "";
  causeOpen.value = false;
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

      <!-- 快速记录：点一下弹小面板、填个数就存；这里列出本次的症状与医生开的药 -->
      <section class="settings-band entry-list-card episode-quick-card">
        <header>
          <div><Plus :size="18" /><h3>快速记录</h3></div>
        </header>
        <div class="entry-list-body">
          <p class="episode-quick-title">症状 · 点一下记一次</p>
          <div class="episode-quick-chips">
            <button
              v-for="chip in symptomChips"
              :key="chip.name"
              type="button"
              :class="{ 'is-new': !chip.existing }"
              @click="logSymptom(chip)"
            >
              {{ chip.name }}
            </button>
            <button class="episode-quick-add" type="button" @click="supplementSymptom">
              <Plus :size="13" />补充症状
            </button>
          </div>

          <template v-if="medicationChips.length">
            <p class="episode-quick-title">医生开的药 · 点一下记服药量</p>
            <div class="episode-quick-chips">
              <button
                v-for="chip in medicationChips"
                :key="chip.name"
                type="button"
                @click="logMedication(chip)"
              >
                <Package :size="13" />{{ chip.name }}
              </button>
            </div>
          </template>
          <div class="episode-quick-chips episode-quick-chips--tail">
            <button class="episode-quick-add" type="button" @click="supplementMedication">
              <Plus :size="13" />补充用药
            </button>
          </div>

          <label class="episode-quick-input">
            <span>一句话记（回车直接记入）</span>
            <input
              v-model="quickInput"
              placeholder="例如 5点半 37.5 ／ 三点五十吃氨溴特罗口服溶液5ml"
              @keydown.enter.prevent="applyQuickDraft"
            />
          </label>
          <p v-if="quickDraft" class="quick-entry-preview">
            <span>识别为</span>
            <strong>{{ quickDraftText(quickDraft) }}</strong>
            <button type="button" @click="applyQuickDraft">记入</button>
          </p>

          <p v-if="lastHint" class="episode-last-hint">
            <span>{{ lastHint.text }}</span>
            <button type="button" @click="editHint">修改</button>
            <button type="button" class="episode-last-hint-close" @click="lastHint = null">知道了</button>
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
        </div>
      </div>

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

      <p
        v-if="!detail.symptoms.length && !detail.medications.length && !(detail.intakes ?? []).length && !detail.linkedFacts.length"
        class="preview-hint"
      >
        还没有内容。到报告详情页点「加入病程」挂上报告，或用上方的快捷按钮记录症状与服药。
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
                      {{ item.title }}
                      <template v-if="item.value"> <em :class="`episode-temp-${item.value.level}`" class="episode-temp">{{ item.value.text }}</em></template>
                      <template v-else-if="item.detail"> · {{ item.detail }}</template>
                    </span>
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
                <strong>
                  {{ item.title }}
                  <em
                    v-if="item.value"
                    class="episode-temp"
                    :class="`episode-temp-${item.value.level}`"
                  >{{ item.value.text }}</em>
                </strong>
                <small v-if="item.detail">{{ item.detail }}</small>
                <div v-if="item.edit || item.remove || item.derived" class="row-actions">
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

    <EpisodeEntrySheet
      :open="sheet.open"
      :mode="sheet.mode"
      :intent="sheet.intent"
      :subject="sheet.subject"
      :show-value="sheet.showValue"
      :busy="saving"
      :form="sheetForm"
      @close="closeSheet"
      @save="submitSheet"
    />

    <ReportDetailModal
      :open="Boolean(previewReportId)"
      :report-id="previewReportId"
      @close="previewReportId = null"
    />
  </section>
</template>
