<script setup lang="ts">
import { ref, watch } from "vue";
import { Plus, X } from "@lucide/vue";
import EmptyState from "./EmptyState.vue";
import { request } from "../utils/api";
import type { CaseEpisode, CaseEpisodeDetail } from "../types/api";

const props = defineProps<{
  open: boolean;
  reportId: string | null;
  memberId: string;
  /** 按报告内容给出的建议标题，例如「10月呼吸道感染」 */
  suggestTitle?: string;
  /** 建议起病日期，取报告日期 */
  suggestOnsetAt?: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "linked", episodeTitle: string): void;
}>();

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const episodes = ref<CaseEpisode[]>([]);
const creating = ref(false);
const newTitle = ref("");
const newOnsetAt = ref("");

const statusLabel: Record<CaseEpisode["status"], string> = {
  active: "进行中",
  resolved: "已痊愈",
  chronic: "慢性",
  unknown: "未记录",
};

function episodeMeta(item: CaseEpisode) {
  const parts = [statusLabel[item.status]];
  if (item.onsetAt) parts.push(`${item.onsetAt.slice(0, 10)} 起`);
  return parts.join(" · ");
}

async function load() {
  if (!props.memberId) return;
  loading.value = true;
  error.value = "";
  try {
    episodes.value = await request<CaseEpisode[]>(`episodes?memberId=${encodeURIComponent(props.memberId)}`);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载病程失败";
  } finally {
    loading.value = false;
  }
}

async function attach(episode: CaseEpisode) {
  if (!props.reportId || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await request<CaseEpisodeDetail>(`episodes/${episode.id}/links`, {
      method: "POST",
      body: JSON.stringify({ factType: "report", factId: props.reportId }),
    });
    emit("linked", episode.title);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加入病程失败";
  } finally {
    saving.value = false;
  }
}

async function createAndAttach() {
  if (!props.memberId || saving.value) return;
  if (!newTitle.value.trim()) {
    error.value = "病程标题不能为空";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const created = await request<CaseEpisodeDetail>("episodes", {
      method: "POST",
      body: JSON.stringify({
        memberId: props.memberId,
        title: newTitle.value,
        onsetAt: newOnsetAt.value || null,
      }),
    });
    newTitle.value = "";
    newOnsetAt.value = "";
    creating.value = false;
    await attach(created.episode);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "新建病程失败";
  } finally {
    saving.value = false;
  }
}

function applySuggestion() {
  newTitle.value = props.suggestTitle?.trim() || "";
  newOnsetAt.value = props.suggestOnsetAt?.trim() || "";
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = "";
    creating.value = false;
    applySuggestion();
    void load();
  },
);

/* 报告详情可能晚于弹窗准备好，建议值到位后同步填充尚未输入的表单 */
watch(
  () => [props.suggestTitle, props.suggestOnsetAt],
  () => {
    if (!props.open || newTitle.value.trim() || newOnsetAt.value) return;
    applySuggestion();
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
      <section class="modal-panel" role="dialog" aria-modal="true" aria-label="加入病程">
        <header>
          <div>
            <h3>加入病程</h3>
            <span>把这份报告挂到某一次生病上</span>
          </div>
          <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')">
            <X :size="17" />
          </button>
        </header>

        <p v-if="error" class="inline-panel-error">{{ error }}</p>

        <div class="form-actions">
          <button class="soft-action-button" type="button" @click="creating = !creating">
            <Plus :size="16" />新建病程
          </button>
        </div>

        <form v-if="creating" class="settings-band" @submit.prevent="createAndAttach">
          <div class="form-grid">
            <label><span>病程标题</span><input v-model="newTitle" placeholder="例如 10月呼吸道感染" /></label>
            <label><span>起病日期</span><input v-model="newOnsetAt" type="date" /></label>
          </div>
          <div class="form-actions">
            <button type="button" @click="creating = false">取消</button>
            <button class="primary-button" :disabled="saving">创建并加入</button>
          </div>
        </form>

        <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
        <EmptyState
          v-else-if="!episodes.length"
          title="还没有病程"
          description="先用上方「新建病程」建一条，这份报告就会挂上去。"
        />
        <div v-else class="data-list">
          <article v-for="item in episodes" :key="item.id">
            <button class="disease-row" type="button" :disabled="saving" @click="attach(item)">
              <span class="reminder-card-main">
                <strong>{{ item.title }}</strong>
                <span>{{ episodeMeta(item) }}</span>
              </span>
              <span class="chip status-label">加入</span>
            </button>
          </article>
        </div>
      </section>
    </div>
  </Teleport>
</template>
