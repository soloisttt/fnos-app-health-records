<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, CheckCircle2, ClipboardList, Plus, Trash2 } from "@lucide/vue";
import DateTimePicker from "../components/DateTimePicker.vue";
import EmptyState from "../components/EmptyState.vue";
import ReportDetailModal from "../components/ReportDetailModal.vue";
import { request } from "../utils/api";
import type { CaseEpisode, CaseEpisodeDetail, CaseEpisodeLinkFactType, CaseSymptom, EpisodeLinkedFact } from "../types/api";
import { useAppContext } from "../composables/useAppContext";
import { useToast } from "../composables/useToast";

const app = useAppContext();
const toast = useToast();

const loading = ref(true);
const saving = ref(false);
const error = ref("");
const episodes = ref<CaseEpisode[]>([]);
const detail = ref<CaseEpisodeDetail | null>(null);
const formOpen = ref(false);
const symptomFormOpen = ref(false);
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

type TimelineEvent = {
  key: string;
  at: string | null;
  kind: string;
  badge: string;
  title: string;
  detail: string | null;
  reportId: string | null;
  remove: (() => void) | null;
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
      title: current.episode.causeText ? `起病 · 病因：${current.episode.causeText}` : "起病",
      detail: current.episode.summary,
      reportId: null,
      remove: null,
    },
  ];

  for (const item of current.symptoms) {
    events.push({
      key: `symptom:${item.id}`,
      at: item.onsetAt,
      kind: "symptom",
      badge: "症状",
      title: item.name,
      detail: symptomMeta(item),
      reportId: null,
      remove: () => void removeSymptom(item.id),
    });
  }

  for (const fact of current.linkedFacts) {
    events.push({
      key: `fact:${fact.linkId}`,
      at: fact.occurredAt,
      kind: fact.factType,
      badge: factTypeLabels[fact.factType],
      title: fact.label,
      detail: factDetail(fact),
      reportId: fact.reportId,
      remove: () => void unlinkFact(fact.factType, fact.factId),
    });
  }

  if (current.episode.status === "resolved" || current.episode.resolvedAt) {
    events.push({
      key: "resolved",
      at: current.episode.resolvedAt,
      kind: "resolved",
      badge: "转归",
      title: "已痊愈",
      detail: null,
      reportId: null,
      remove: null,
    });
  }

  return events.sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
});

const episodeForm = ref({ title: "", onsetAt: "", causeText: "" });
const symptomForm = ref({ name: "", onsetAt: "", durationText: "", severity: "", bodyPart: "" });

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

async function load(memberId: string, keepDetailId?: string) {
  detail.value = null;
  episodes.value = [];
  if (!memberId) {
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    episodes.value = await request<CaseEpisode[]>(`episodes?memberId=${encodeURIComponent(memberId)}`);
    if (keepDetailId) await openEpisode(keepDetailId, true);
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
</script>

<template>
  <section class="plain-page">
    <template v-if="detail">
      <div class="page-intro">
        <div>
          <h2>{{ detail.episode.title }}</h2>
          <p>{{ episodeMeta({ ...detail.episode, symptomCount: detail.symptoms.length }) }}</p>
        </div>
        <button class="soft-action-button" type="button" @click="back">
          <ArrowLeft :size="16" />返回
        </button>
      </div>

      <p v-if="error" class="inline-panel-error">{{ error }}</p>

      <section class="settings-band">
        <header>
          <ClipboardList :size="21" />
          <div>
            <h3>病程信息</h3>
            <p>病因需要你自己填写，系统不做推断</p>
          </div>
          <span class="chip status-label" :class="episodeStatusOf(detail.episode.status).chip">
            {{ episodeStatusOf(detail.episode.status).label }}
          </span>
        </header>
        <form class="settings-form" @submit.prevent="patchEpisode({ causeText: detail.episode.causeText }, '病因已保存')">
          <label>
            <span>病因</span>
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
      </section>

      <div class="page-intro episode-timeline-intro">
        <div><h3>病程时间轴</h3><p>起病、症状、诊断、用药与转归，按时间排成一条线</p></div>
        <button class="soft-action-button" type="button" @click="symptomFormOpen = !symptomFormOpen">
          <Plus :size="16" />添加症状
        </button>
      </div>

      <form v-if="symptomFormOpen" class="settings-band" @submit.prevent="addSymptom">
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

      <p v-if="!detail.symptoms.length && !detail.linkedFacts.length" class="preview-hint">
        还没有内容。到报告详情页点「加入病程」挂上报告，或用上方按钮补录症状。
      </p>
      <ol v-else class="episode-timeline">
        <li v-for="event in timeline" :key="event.key" :class="`episode-event episode-event--${event.kind}`">
          <span class="episode-dot" aria-hidden="true"></span>
          <div class="episode-event-body">
            <div class="episode-event-head">
              <span class="chip status-label">{{ event.badge }}</span>
              <time v-if="event.at">{{ formatDay(event.at) }}</time>
            </div>
            <strong>{{ event.title }}</strong>
            <small v-if="event.detail">{{ event.detail }}</small>
            <div v-if="event.reportId || event.remove" class="row-actions">
              <button v-if="event.reportId" type="button" @click="previewReportId = event.reportId">查看报告</button>
              <button v-if="event.remove" class="danger-action" type="button" :disabled="saving" @click="event.remove()">
                <Trash2 :size="15" />移除
              </button>
            </div>
          </div>
        </li>
      </ol>
    </template>

    <template v-else>
      <div class="page-intro">
        <div><h2>病程</h2><p>把同一次生病的多次就诊串成一条线</p></div>
        <button class="primary-button compact-primary" type="button" @click="formOpen = !formOpen">
          <Plus :size="17" />新建病程
        </button>
      </div>

      <p v-if="error" class="inline-panel-error">{{ error }}</p>

      <form v-if="formOpen" class="settings-band" @submit.prevent="createEpisode">
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

      <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
      <EmptyState
        v-else-if="!episodes.length"
        title="还没有病程"
        description="孩子每生一次病就建一条病程，之后可以把这次相关的报告、用药都挂上去。"
      />
      <div v-else class="data-list">
        <article v-for="item in episodes" :key="item.id">
          <button class="disease-row" type="button" @click="openEpisode(item.id)">
            <span class="reminder-card-main">
              <strong>{{ item.title }}</strong>
              <span>{{ episodeMeta(item) }}</span>
              <small v-if="item.causeText">病因：{{ item.causeText }}</small>
            </span>
            <span class="chip status-label" :class="episodeStatusOf(item.status).chip">
              {{ episodeStatusOf(item.status).label }}
            </span>
          </button>
        </article>
      </div>
    </template>

    <ReportDetailModal
      :open="Boolean(previewReportId)"
      :report-id="previewReportId"
      @close="previewReportId = null"
    />
  </section>
</template>
