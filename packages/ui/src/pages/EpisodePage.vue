<script setup lang="ts">
import { ref, watch } from "vue";
import { ArrowLeft, CheckCircle2, Plus, Trash2 } from "@lucide/vue";
import DateTimePicker from "../components/DateTimePicker.vue";
import EmptyState from "../components/EmptyState.vue";
import { request } from "../utils/api";
import type { CaseEpisode, CaseEpisodeDetail, CaseSymptom } from "../types/api";
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

function formatDay(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

function episodeMeta(item: CaseEpisode) {
  const parts = [episodeStatusMeta[item.status].label];
  const onset = formatDay(item.onsetAt);
  if (onset) parts.push(`${onset} 起`);
  if (item.symptomCount) parts.push(`${item.symptomCount} 个症状`);
  return parts.join(" · ");
}

function symptomMeta(item: CaseSymptom) {
  const parts = [symptomStatusLabel[item.status]];
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

      <form class="settings-band" @submit.prevent="patchEpisode({ causeText: detail.episode.causeText }, '病因已保存')">
        <div class="form-grid">
          <label>
            <span>病因（自己填写，系统不做推断）</span>
            <input v-model="detail.episode.causeText" placeholder="例如 受凉、接触感冒的家人" />
          </label>
        </div>
        <div class="form-actions">
          <button class="primary-button" :disabled="saving">保存病因</button>
        </div>
      </form>

      <div class="settings-band">
        <div class="form-actions">
          <button
            v-if="detail.episode.status !== 'resolved'"
            class="primary-button"
            type="button"
            :disabled="saving"
            @click="patchEpisode({ status: 'resolved', resolvedAt: new Date().toISOString().slice(0, 10) }, '已标记为痊愈')"
          >
            <CheckCircle2 :size="16" />标记为已痊愈
          </button>
          <button
            v-else
            type="button"
            :disabled="saving"
            @click="patchEpisode({ status: 'active', resolvedAt: null }, '已恢复为进行中')"
          >
            恢复为进行中
          </button>
        </div>
      </div>

      <div class="page-intro">
        <div><h3>症状</h3><p>系统只能从报告里读到"主诉"一句，其余请在这里补录</p></div>
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

      <EmptyState
        v-if="!detail.symptoms.length"
        title="还没有症状记录"
        description="点上方「添加症状」补录，比如咳嗽、鼻塞、流涕。"
      />
      <div v-else class="data-list">
        <article v-for="item in detail.symptoms" :key="item.id">
          <div class="reminder-card-head">
            <div class="reminder-card-main">
              <strong>{{ item.name }}</strong>
              <span>{{ symptomMeta(item) }}</span>
              <small v-if="item.description">{{ item.description }}</small>
            </div>
          </div>
          <div class="reminder-card-footer">
            <span class="chip status-label">{{ item.source === "manual" ? "手工录入" : "系统识别" }}</span>
            <div class="row-actions">
              <button class="danger-action" type="button" :disabled="saving" @click="removeSymptom(item.id)">
                <Trash2 :size="15" />删除
              </button>
            </div>
          </div>
        </article>
      </div>
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
            <span class="chip status-label" :class="episodeStatusMeta[item.status].chip">
              {{ episodeStatusMeta[item.status].label }}
            </span>
          </button>
        </article>
      </div>
    </template>
  </section>
</template>
