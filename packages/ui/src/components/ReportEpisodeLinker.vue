<script setup lang="ts">
import { ref, watch } from "vue";
import { FolderPlus, X } from "@lucide/vue";
import DateTimePicker from "./DateTimePicker.vue";
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
  const parts = [statusLabel[item.status] ?? statusLabel.unknown];
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

/** 把当前报告挂到指定病程。加锁与错误处理交给调用方。 */
async function linkReportTo(episodeId: string, episodeTitle: string) {
  await request<CaseEpisodeDetail>(`episodes/${episodeId}/links`, {
    method: "POST",
    body: JSON.stringify({ factType: "report", factId: props.reportId }),
  });
  emit("linked", episodeTitle);
}

/** 从列表里点某条病程直接加入。 */
async function attach(episode: CaseEpisode) {
  if (!props.reportId || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await linkReportTo(episode.id, episode.title);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加入病程失败";
  } finally {
    saving.value = false;
  }
}

async function createAndAttach() {
  if (!props.memberId || saving.value) return;
  const title = newTitle.value.trim();
  if (!title) {
    error.value = "病程标题不能为空";
    return;
  }
  const onset = (newOnsetAt.value || "").slice(0, 10);

  /* 已有同名同起病日期的病程时直接复用，避免反复点「创建并加入」堆出一串一模一样的病程 */
  const existing = episodes.value.find(
    (item) => item.title.trim() === title && (item.onsetAt ?? "").slice(0, 10) === onset,
  );
  if (existing) {
    creating.value = false;
    await attach(existing);
    return;
  }

  saving.value = true;
  error.value = "";
  try {
    const created = await request<CaseEpisodeDetail>("episodes", {
      method: "POST",
      body: JSON.stringify({ memberId: props.memberId, title, onsetAt: onset || null }),
    });
    newTitle.value = "";
    newOnsetAt.value = "";
    creating.value = false;
    /* 这里不能复用 attach()：此时 saving 仍为 true，会被它开头的防重复判断直接挡掉，
       导致「病程建好了但报告没挂上、界面也无反馈」。 */
    await linkReportTo(created.episode.id, created.episode.title);
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

function startCreating() {
  error.value = "";
  applySuggestion();
  creating.value = true;
}

function backToList() {
  error.value = "";
  creating.value = false;
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = "";
    creating.value = false;
    void load();
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop episode-linker-backdrop" @click.self="emit('close')">
      <section class="modal-panel episode-linker" role="dialog" aria-modal="true" aria-label="加入病程">
        <header>
          <div>
            <FolderPlus :size="19" />
            <span>
              <strong>加入病程</strong>
              <small>把这份报告挂到某一次生病上，方便日后回看这次看病的前后经过</small>
            </span>
          </div>
          <button class="plain-icon-button" type="button" title="关闭" @click="emit('close')">
            <X :size="18" />
          </button>
        </header>

        <div class="episode-linker-body">
          <p v-if="error" class="inline-panel-error">{{ error }}</p>

          <template v-if="creating">
            <div class="form-grid">
              <label><span>病程标题</span><input v-model="newTitle" placeholder="例如 10月呼吸道感染" /></label>
              <label><span>起病日期</span><DateTimePicker v-model="newOnsetAt" disable-future aria-label="起病日期" /></label>
            </div>
          </template>

          <template v-else>
            <p class="episode-linker-hint">选择这份报告所属的病程（报告里的诊断、用药、操作会一起记入）：</p>
            <div v-if="loading" class="loading-list"><span v-for="index in 3" :key="index"></span></div>
            <EmptyState
              v-else-if="!episodes.length"
              title="还没有病程"
              description="点下方「新建病程」，这份报告就会挂上去。"
            />
            <div v-else class="entry-list-body entry-list-body--bare">
              <button
                v-for="item in episodes"
                :key="item.id"
                class="entry-row"
                type="button"
                :disabled="saving"
                @click="attach(item)"
              >
                <span class="entry-row-main">
                  <strong>{{ item.title }}</strong>
                  <span>{{ episodeMeta(item) }}</span>
                </span>
                <span class="entry-row-side">
                  <span class="chip status-label">加入</span>
                </span>
              </button>
            </div>
          </template>
        </div>

        <footer class="episode-linker-footer">
          <template v-if="creating">
            <button type="button" @click="backToList">返回列表</button>
            <button class="primary-button" type="button" :disabled="saving" @click="createAndAttach">创建并加入</button>
          </template>
          <template v-else>
            <button type="button" @click="emit('close')">取消</button>
            <button class="primary-button" type="button" :disabled="saving" @click="startCreating">新建病程</button>
          </template>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
