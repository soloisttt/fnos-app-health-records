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
      /* 由报告展开出的条目跟随报告，不单独移除；要移除就移除整份报告 */
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
          remove: null,
        },
      ],
    });
  }

  return events.sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
});

const episodeForm = ref({ title: "", onsetAt: "", causeText: "" });
const symptomForm = ref({ name: "", onsetAt: "", durationText: "", severity: "", bodyPart: "" });
const medicationForm = ref({ name: "", dose: "", frequency: "", route: "", startAt: "" });

/** 两个补录表单互斥展开，避免同时占满屏幕。 */
function openSymptomForm() {
  medicationFormOpen.value = false;
  symptomFormOpen.value = !symptomFormOpen.value;
}

function openMedicationForm() {
  symptomFormOpen.value = false;
  medicationFormOpen.value = !medicationFormOpen.value;
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

function episodeMeta(item: CaseEpisode) {
  const parts = [episodeStatusOf(item.status).label];
  const onset = formatDay(item.onsetAt);
  if (onset) parts.push(`${onset} 起`);
  if (item.symptomCount) parts.push(`${item.symptomCount} 个症状`);
  return parts.join(" · ");
}

function symptomMeta(item: CaseSymptom) {
  const parts = [symptomStatusOf(item.status)];
  if (item.onsetAt) parts.push(formatDay(item.onsetAt));
  if (item.durationText) parts.push(`持续${item.durationText}`);
  if (item.severity) parts.push(item.severity);
  if (item.bodyPart) parts.push(item.bodyPart);
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

async function addSymptom() {
  const episodeId = detail.value?.episode.id;
  if (!episodeId || saving.value) return;
  if (!symptomForm.value.name.trim()) {
    error.value = "症状名称不能为空";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}/symptoms`, {
      method: "POST",
      body: JSON.stringify({
        name: symptomForm.value.name,
        onsetAt: symptomForm.value.onsetAt || null,
        durationText: symptomForm.value.durationText || null,
        severity: symptomForm.value.severity || null,
        bodyPart: symptomForm.value.bodyPart || null,
      }),
    });
    symptomForm.value = { name: "", onsetAt: "", durationText: "", severity: "", bodyPart: "" };
    symptomFormOpen.value = false;
    toast.show("症状已添加");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "添加症状失败";
  } finally {
    saving.value = false;
  }
}

async function addMedication() {
  const episodeId = detail.value?.episode.id;
  if (!episodeId || saving.value) return;
  if (!medicationForm.value.name.trim()) {
    error.value = "药品名称不能为空";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    detail.value = await request<CaseEpisodeDetail>(`episodes/${episodeId}/medications`, {
      method: "POST",
      body: JSON.stringify({
        name: medicationForm.value.name,
        dose: medicationForm.value.dose || null,
        frequency: medicationForm.value.frequency || null,
        route: medicationForm.value.route || null,
        startAt: medicationForm.value.startAt || null,
      }),
    });
    medicationForm.value = { name: "", dose: "", frequency: "", route: "", startAt: "" };
    medicationFormOpen.value = false;
    toast.show("用药已添加");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "添加用药失败";
  } finally {
    saving.value = false;
  }
}

async function removeMedication(medicationId: string) {
  if (saving.value) return;
  saving.value = true;
  try {
    detail.value = await request<CaseEpisodeDetail>(`medications/${medicationId}`, { method: "DELETE" });
    toast.show("用药已删除");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除用药失败";
  } finally {
    saving.value = false;
  }
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

async function removeSymptom(symptomId: string) {
  if (saving.value) return;
  saving.value = true;
  try {
    detail.value = await request<CaseEpisodeDetail>(`symptoms/${symptomId}`, { method: "DELETE" });
    toast.show("症状已删除");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除症状失败";
  } finally {
    saving.value = false;
  }
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
          <div><Plus :size="18" /><h3>添加症状</h3></div>
        </header>
        <div class="entry-list-body">
        <form class="entry-form" @submit.prevent="addSymptom">
        <div class="form-grid">
          <label><span>症状名称</span><input v-model="symptomForm.name" placeholder="例如 咳嗽" /></label>
          <label><span>出现日期</span><DateTimePicker v-model="symptomForm.onsetAt" aria-label="症状出现日期" /></label>
          <label><span>持续时长</span><input v-model="symptomForm.durationText" placeholder="例如 半天、3天" /></label>
          <label><span>程度</span><input v-model="symptomForm.severity" placeholder="例如 轻、中、重" /></label>
          <label><span>部位</span><input v-model="symptomForm.bodyPart" placeholder="例如 咽喉" /></label>
        </div>
        <div class="form-actions">
          <button type="button" @click="symptomFormOpen = false">取消</button>
          <button class="primary-button" :disabled="saving">保存</button>
        </div>
        </form>
        </div>
      </section>

      <section v-if="medicationFormOpen" class="settings-band entry-list-card">
        <header>
          <div><Plus :size="18" /><h3>添加用药</h3></div>
        </header>
        <div class="entry-list-body">
        <form class="entry-form" @submit.prevent="addMedication">
        <div class="form-grid">
          <label><span>药品名称</span><input v-model="medicationForm.name" placeholder="例如 氨溴特罗口服溶液" /></label>
          <label><span>开始日期</span><DateTimePicker v-model="medicationForm.startAt" aria-label="用药开始日期" /></label>
          <label><span>单次剂量</span><input v-model="medicationForm.dose" placeholder="例如 5ml、半片" /></label>
          <label><span>服药频次</span><input v-model="medicationForm.frequency" placeholder="例如 tid（每日三次）" /></label>
          <label><span>用法</span><input v-model="medicationForm.route" placeholder="例如 口服、外用" /></label>
        </div>
        <div class="form-actions">
          <button type="button" @click="medicationFormOpen = false">取消</button>
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
              <time v-if="event.at">{{ formatDay(event.at) }}</time>
            </div>
            <div class="episode-event-items">
              <div v-for="item in event.items" :key="item.key" class="episode-event-item">
                <strong>{{ item.title }}</strong>
                <small v-if="item.detail">{{ item.detail }}</small>
                <div v-if="item.reportId || item.remove || item.derived" class="row-actions">
                  <button v-if="item.reportId" type="button" @click="previewReportId = item.reportId">查看报告</button>
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
