<script setup lang="ts">
import { computed, onActivated, ref, watch } from "vue";
import { ArrowLeft, CheckCircle2, ClipboardList, Plus, Trash2 } from "@lucide/vue";
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
import { parseQuickSymptomInput } from "../utils/quick-symptom";
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
  /** 可编辑时给出入口（手动录入的症状与用药）；随报告记入的条目不可改。 */
  edit: (() => void) | null;
  remove: (() => void) | null;
};

type TimelineEvent = {
  key: string;
  at: string | null;
  kind: string;
  badge: string;
  items: TimelineItem[];
};

/** A5 病程时间轴：把起病、症状、已归集的事实、转归按时间排成一条线。 */
const timeline = computed<TimelineEvent[]>(() => {
  const current = detail.value;
  if (!current) return [];
  const events: TimelineEvent[] = [
    {
      key: "onset",
      at: current.episode.onsetAt,
      kind: "onset",
      badge: "病程",
      items: [
        {
          key: "onset:main",
          title: current.episode.causeText ? `起病 · 病因：${current.episode.causeText}` : "起病",
          detail: current.episode.summary,
          reportId: null,
          derived: false,
          edit: null,
          remove: null,
        },
      ],
    },
  ];

  for (const item of current.symptoms) {
    events.push({
      key: `symptom:${item.id}`,
      at: item.onsetAt,
      kind: "symptom",
      badge: "症状",
      items: [
        {
          key: `symptom:${item.id}:main`,
          title: item.name,
          detail: symptomMeta(item),
          reportId: null,
          derived: false,
          edit: () => openSymptomForm(item),
          remove: () => void removeSymptom(item.id),
        },
      ],
    });
  }

  /* 同一次就诊、同一类内容合并成一个节点：一次开了两盒药只占一个「用药」节点，
     不必每盒药都重复一遍类型标签、日期和来源报告。 */
  const factGroups = new Map<string, TimelineEvent>();
  for (const fact of current.linkedFacts) {
    const groupKey = `${fact.factType}|${fact.reportId ?? ""}|${fact.occurredAt ?? ""}`;
    const entry: TimelineItem = {
      key: `fact:${fact.linkId}`,
      title: fact.label,
      detail: factDetail(fact),
      reportId: fact.reportId,
      derived: fact.derived,
      /* 由报告展开出的条目跟随报告，不单独编辑或移除；要改就改报告本身 */
      edit: null,
      remove: fact.derived ? null : () => void unlinkFact(fact.factType, fact.factId),
    };
    const group = factGroups.get(groupKey);
    if (group) {
      group.items.push(entry);
      continue;
    }
    factGroups.set(groupKey, {
      key: `facts:${groupKey}`,
      at: fact.occurredAt,
      kind: fact.factType,
      badge: factTypeLabels[fact.factType],
      items: [entry],
    });
  }
  /* 手动补录的用药与报告展开的用药同属「用药」，但没有来源报告，因此单独成组 */
  for (const medication of current.medications) {
    const groupKey = `medication||${medication.startAt ?? ""}`;
    const entry: TimelineItem = {
      key: `medication:${medication.id}`,
      title: medication.name,
      detail: manualMedicationDetail(medication),
      reportId: null,
      derived: false,
      edit: () => openMedicationForm(medication),
      remove: () => void removeMedication(medication.id),
    };
    const group = factGroups.get(groupKey);
    if (group) {
      group.items.push(entry);
      continue;
    }
    factGroups.set(groupKey, {
      key: `facts:${groupKey}`,
      at: medication.startAt,
      kind: "medication",
      badge: factTypeLabels.medication,
      items: [entry],
    });
  }
  events.push(...factGroups.values());

  if (current.episode.status === "resolved" || current.episode.resolvedAt) {
    events.push({
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
          edit: null,
          remove: null,
        },
      ],
    });
  }

  return events.sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
});

const episodeForm = ref({ title: "", onsetAt: "", causeText: "" });
const symptomForm = ref(emptySymptomForm());
const medicationForm = ref({ name: "", dose: "", frequency: "", route: "", startAt: "" });
const editingSymptomId = ref<string | null>(null);
const editingMedicationId = ref<string | null>(null);
const quickInput = ref("");

/** 当前本地时间 `YYYY-MM-DD HH:mm`；补录症状默认填"现在"，对应"刚量了体温"这种场景。 */
function nowLocal() {
  const current = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())} ${pad(current.getHours())}:${pad(current.getMinutes())}`;
}

function emptySymptomForm() {
  return {
    name: "",
    onsetAt: "",
    durationText: "",
    severity: "",
    bodyPart: "",
    measuredValue: "",
    measuredUnit: "",
    status: "present" as CaseSymptom["status"],
  };
}

/** 两个补录表单互斥展开，避免同时占满屏幕；传 target 表示进入编辑。 */
function openSymptomForm(target?: CaseSymptom) {
  medicationFormOpen.value = false;
  quickInput.value = "";
  if (target) {
    editingSymptomId.value = target.id;
    symptomForm.value = {
      name: target.name,
      onsetAt: target.onsetAt ?? "",
      durationText: target.durationText ?? "",
      severity: target.severity ?? "",
      bodyPart: target.bodyPart ?? "",
      measuredValue: target.measuredValue ?? "",
      measuredUnit: target.measuredUnit ?? "",
      status: target.status,
    };
    symptomFormOpen.value = true;
    return;
  }
  editingSymptomId.value = null;
  symptomForm.value = { ...emptySymptomForm(), onsetAt: nowLocal() };
  symptomFormOpen.value = !symptomFormOpen.value;
}

function closeSymptomForm() {
  symptomFormOpen.value = false;
  editingSymptomId.value = null;
  quickInput.value = "";
}

function openMedicationForm(target?: CaseMedication) {
  symptomFormOpen.value = false;
  if (target) {
    editingMedicationId.value = target.id;
    medicationForm.value = {
      name: target.name,
      dose: target.dose ?? "",
      frequency: target.frequency ?? "",
      route: target.route ?? "",
      startAt: target.startAt ?? "",
    };
    medicationFormOpen.value = true;
    return;
  }
  editingMedicationId.value = null;
  medicationForm.value = { name: "", dose: "", frequency: "", route: "", startAt: "" };
  medicationFormOpen.value = !medicationFormOpen.value;
}

function closeMedicationForm() {
  medicationFormOpen.value = false;
  editingMedicationId.value = null;
}

/* 「快速输入」：把「5点半 37.5」这类口语拆成时间与测量值，供用户确认后填入表单。 */
const quickDraft = computed(() => {
  const text = quickInput.value.trim();
  if (!text) return null;
  const parsed = parseQuickSymptomInput(text);
  if (!parsed.matched && !parsed.name) return null;
  return parsed;
});

function applyQuickDraft() {
  const parsed = quickDraft.value;
  if (!parsed) return;
  if (parsed.onsetAt) symptomForm.value.onsetAt = parsed.onsetAt;
  if (parsed.name) symptomForm.value.name = parsed.name;
  if (parsed.measuredValue) symptomForm.value.measuredValue = parsed.measuredValue;
  if (parsed.measuredUnit) symptomForm.value.measuredUnit = parsed.measuredUnit;
  quickInput.value = "";
}

const episodeStatusMeta: Record<CaseEpisode["status"], { label: string; chip: string }> = {
  active: { label: "进行中", chip: "chip--amber" },
  resolved: { label: "已痊愈", chip: "chip--green" },
  chronic: { label: "慢性", chip: "" },
  unknown: { label: "未记录", chip: "" },
};

const symptomStatusLabel: Record<CaseSymptom["status"], string> = {
  present: "持续",
  improved: "好转",
  resolved: "已消失",
  unknown: "未记录",
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

function symptomMeta(item: CaseSymptom) {
  const parts = [symptomStatusOf(item.status)];
  if (item.onsetAt) parts.push(formatMoment(item.onsetAt));
  if (item.measuredValue) parts.push(`${item.measuredValue}${item.measuredUnit ?? ""}`);
  if (item.durationText) parts.push(`持续${item.durationText}`);
  if (item.severity) parts.push(item.severity);
  if (item.bodyPart) parts.push(item.bodyPart);
  /* 挂报告时从主诉自动带出来的症状，标明来源，方便用户判断要不要留 */
  if (item.source === "ai") parts.push("来自报告主诉");
  return parts.join(" · ");
}

/** 手动补录用药的展示文案：剂量 · 用法 · 频次（保留 tid/bid 原标签并补中文说明）。 */
function manualMedicationDetail(item: CaseMedication) {
  const dose = [item.dose, item.doseUnit].filter(Boolean).join("");
  return [dose || null, item.route, withFrequencyNote(item.frequency), "手动补录"]
    .filter(Boolean)
    .join(" · ");
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
    detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}`);
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
    closeSymptomForm();
    toast.show(editing ? "症状已更新" : "症状已添加");
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
        <form class="entry-form" @submit.prevent="patchEpisode({ causeText: detail.episode.causeText }, '病因已保存')">
          <label>
            <span>病因（自己填写，系统不做推断）</span>
            <input v-model="detail.episode.causeText" placeholder="例如 受凉、接触感冒的家人" />
          </label>
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
            <button class="primary-button compact-primary" :disabled="saving">保存病因</button>
          </div>
        </form>
        </div>
      </section>

      <div class="page-intro page-intro--keep page-intro--actions-only episode-timeline-intro">
        <div><h3>病程时间轴</h3><p>起病、症状、诊断、用药与转归，按时间排成一条线</p></div>
        <div class="episode-intro-actions">
          <button class="soft-action-button" type="button" :disabled="saving" @click="importSymptomsFromReports()">
            <ClipboardList :size="16" />补录报告症状
          </button>
          <button class="soft-action-button" type="button" @click="openMedicationForm()">
            <Plus :size="16" />添加用药
          </button>
          <button class="soft-action-button" type="button" @click="openSymptomForm()">
            <Plus :size="16" />添加症状
          </button>
        </div>
      </div>

      <section v-if="symptomFormOpen" class="settings-band entry-list-card">
        <header>
          <div><Plus :size="18" /><h3>{{ editingSymptomId ? "编辑症状" : "添加症状" }}</h3></div>
        </header>
        <div class="entry-list-body">
        <div v-if="!editingSymptomId" class="quick-entry">
          <label>
            <span>一句话记（回车填入）</span>
            <input v-model="quickInput" placeholder="例如 5点半 37.5" @keydown.enter.prevent="applyQuickDraft" />
          </label>
          <p v-if="quickDraft" class="quick-entry-preview">
            <span>识别为</span>
            <strong>{{ quickDraft.name || "未提名称" }}</strong>
            <template v-if="quickDraft.onsetAt"> · {{ quickDraft.onsetAt }}</template>
            <template v-if="quickDraft.measuredValue"> · {{ quickDraft.measuredValue }}{{ quickDraft.measuredUnit }}</template>
            <button type="button" @click="applyQuickDraft">填入</button>
          </p>
        </div>
        <form class="entry-form" @submit.prevent="saveSymptom">
        <div class="form-grid">
          <label><span>症状名称</span><input v-model="symptomForm.name" placeholder="例如 咳嗽" /></label>
          <label><span>出现时间</span><DateTimePicker v-model="symptomForm.onsetAt" aria-label="症状出现时间" show-time /></label>
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
          <label><span>开始日期</span><DateTimePicker v-model="medicationForm.startAt" aria-label="用药开始日期" /></label>
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

      <p v-if="!detail.symptoms.length && !detail.medications.length && !detail.linkedFacts.length" class="preview-hint">
        还没有内容。到报告详情页点「加入病程」挂上报告，或用上方按钮补录症状与用药。
      </p>
      <ol v-else class="episode-timeline">
        <li v-for="event in timeline" :key="event.key" :class="`episode-event episode-event--${event.kind}`">
          <span class="episode-dot" aria-hidden="true"></span>
          <div class="episode-event-body">
            <div class="episode-event-head">
              <span class="chip status-label">{{ event.badge }}</span>
              <time v-if="event.at">{{ formatMoment(event.at) }}</time>
            </div>
            <div class="episode-event-items">
              <div v-for="item in event.items" :key="item.key" class="episode-event-item">
                <strong>{{ item.title }}</strong>
                <small v-if="item.detail">{{ item.detail }}</small>
                <div v-if="item.reportId || item.edit || item.remove || item.derived" class="row-actions">
                  <button v-if="item.reportId" type="button" @click="previewReportId = item.reportId">查看报告</button>
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
