<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from "vue";
import { ArrowLeft, Activity, Search, X } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import { request } from "../utils/api";
import type { CatalogExclusion, DiseaseCatalogEntry, DiseaseVisit } from "../types/api";
import { useAppContext } from "../composables/useAppContext";

const app = useAppContext();

const loading = ref(true);
const error = ref("");
const keyword = ref("");
const entries = ref<DiseaseCatalogEntry[]>([]);
const selected = ref<DiseaseCatalogEntry | null>(null);
const records = ref<DiseaseVisit[]>([]);
const recordsLoading = ref(false);
const searchResults = ref<DiseaseVisit[]>([]);
const searching = ref(false);
const hidden = ref<CatalogExclusion[]>([]);
const hiddenOpen = ref(false);
const hidingKey = ref("");
let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function runSearch(memberId: string, value: string) {
  const needle = value.trim();
  if (!needle || !memberId) {
    searchResults.value = [];
    return;
  }
  searching.value = true;
  try {
    searchResults.value = await request<DiseaseVisit[]>(
      `episode-search?memberId=${encodeURIComponent(memberId)}&q=${encodeURIComponent(needle)}`,
    );
  } catch {
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

watch(keyword, (value) => {
  clearTimeout(searchTimer);
  if (!value.trim()) {
    searchResults.value = [];
    return;
  }
  const memberId = app.selectedMemberId.value;
  searchTimer = setTimeout(() => void runSearch(memberId, value), 300);
});

onBeforeUnmount(() => clearTimeout(searchTimer));

/** 分类页签：诊断 / 症状，默认看诊断 */
type DiseaseKind = DiseaseCatalogEntry["kind"];
const kindTabs: Array<{ key: DiseaseKind; label: string }> = [
  { key: "diagnosis", label: "诊断" },
  { key: "symptom", label: "症状" },
];
const activeKind = ref<DiseaseKind>("diagnosis");

function kindCount(kind: DiseaseKind) {
  return entries.value.filter((entry) => entry.kind === kind).length;
}

const filtered = computed(() => {
  const needle = keyword.value.trim().toLowerCase();
  return entries.value.filter((entry) => {
    if (entry.kind !== activeKind.value) return false;
    return !needle || entry.name.toLowerCase().includes(needle);
  });
});

function kindLabel(entry: DiseaseCatalogEntry) {
  return entry.kind === "diagnosis" ? "诊断" : "症状";
}

function kindChip(entry: DiseaseCatalogEntry) {
  return entry.kind === "diagnosis" ? "chip--green" : "chip--amber";
}

function formatDay(value: string | null) {
  return value ? value.slice(0, 10) : "时间未知";
}

function medicationText(item: DiseaseVisit["medications"][number]) {
  return [item.name, item.dose, item.route, item.frequency].filter(Boolean).join(" ");
}

async function load(memberId: string) {
  selected.value = null;
  records.value = [];
  if (!memberId) {
    entries.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    entries.value = await request<DiseaseCatalogEntry[]>(
      `disease-catalog?memberId=${encodeURIComponent(memberId)}`,
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载疾病目录失败";
  } finally {
    loading.value = false;
  }
  await loadHidden(memberId);
}

async function loadHidden(memberId: string) {
  if (!memberId) {
    hidden.value = [];
    return;
  }
  try {
    hidden.value = await request<CatalogExclusion[]>(
      `disease-catalog-hidden?memberId=${encodeURIComponent(memberId)}`,
    );
  } catch {
    hidden.value = [];
  }
}

/** 隐藏：只从目录里拿掉，报告里的诊断原文与病程里的症状不动，可随时恢复。 */
async function hideEntry(entry: DiseaseCatalogEntry) {
  const memberId = app.selectedMemberId.value;
  if (!memberId || hidingKey.value) return;
  hidingKey.value = `${entry.kind}:${entry.name}`;
  error.value = "";
  try {
    entries.value = await request<DiseaseCatalogEntry[]>("disease-catalog-exclusions", {
      method: "POST",
      body: JSON.stringify({ memberId, kind: entry.kind, name: entry.name }),
    });
    await loadHidden(memberId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "隐藏失败";
  } finally {
    hidingKey.value = "";
  }
}

async function restoreExclusion(item: CatalogExclusion) {
  const memberId = app.selectedMemberId.value;
  if (!memberId || hidingKey.value) return;
  hidingKey.value = `${item.kind}:${item.name}`;
  error.value = "";
  try {
    entries.value = await request<DiseaseCatalogEntry[]>(
      `disease-catalog-exclusions?memberId=${encodeURIComponent(memberId)}` +
        `&kind=${item.kind}&name=${encodeURIComponent(item.name)}`,
      { method: "DELETE" },
    );
    await loadHidden(memberId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "恢复失败";
  } finally {
    hidingKey.value = "";
  }
}

async function openEntry(entry: DiseaseCatalogEntry) {
  const memberId = app.selectedMemberId.value;
  if (!memberId) return;
  selected.value = entry;
  recordsLoading.value = true;
  error.value = "";
  try {
    records.value = await request<DiseaseVisit[]>(
      `disease-records?memberId=${encodeURIComponent(memberId)}&kind=${entry.kind}` +
        `&name=${encodeURIComponent(entry.name)}`,
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载就诊记录失败";
    records.value = [];
  } finally {
    recordsLoading.value = false;
  }
}

function back() {
  selected.value = null;
  records.value = [];
}

watch(
  () => app.selectedMemberId.value,
  (memberId) => void load(memberId),
  { immediate: true },
);

/* 页面被 KeepAlive 缓存：在报告页识别、加病程之后切回来时要重算目录，
   否则列表一直是缓存里的旧快照。 */
let activatedOnce = false;
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true;
    return;
  }
  const memberId = app.selectedMemberId.value;
  if (memberId) void load(memberId);
});
</script>

<template>
  <section class="plain-page">
    <div class="page-intro">
      <div>
        <h2>疾病</h2>
        <p>按病查看这个成员的历次就诊与用药记录</p>
      </div>
    </div>

    <template v-if="selected">
      <div class="page-intro">
        <div>
          <h3>{{ selected.name }}</h3>
          <p>共 {{ selected.count }} 次记录 · {{ kindLabel(selected) }}</p>
        </div>
        <button class="soft-action-button" type="button" @click="back">
          <ArrowLeft :size="16" />返回
        </button>
      </div>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
      <div v-if="recordsLoading" class="loading-list"><span v-for="index in 2" :key="index"></span></div>
      <EmptyState
        v-else-if="!records.length"
        title="还没有关联的就诊记录"
        description="这个条目下的就诊记录来自报告诊断，或病程上挂载的用药与操作。"
      />
      <section v-else class="settings-band entry-list-card">
        <header>
          <div><Activity :size="18" /><h3>就诊记录</h3></div>
          <span class="count-label">共 {{ records.length }} 次</span>
        </header>
        <div class="entry-list-body">
        <article v-for="visit in records" :key="visit.reportId" class="entry-row entry-row--stacked">
          <div class="entry-row-main">
            <strong>{{ formatDay(visit.issuedAt) }} · {{ visit.hospitalName || "医院未记录" }}</strong>
            <span>{{ [visit.departmentName, visit.title].filter(Boolean).join(" · ") }}</span>
            <small v-if="visit.diagnoses.length">诊断：{{ visit.diagnoses.join("、") }}</small>
            <small v-for="(med, index) in visit.medications" :key="index">
              用药：{{ medicationText(med) }}
            </small>
          </div>
        </article>
        </div>
      </section>
    </template>

    <template v-else>
      <label class="search-field entry-search">
        <Search :size="16" />
        <input v-model="keyword" type="search" placeholder="搜索症状或疾病，例如 咳嗽" />
      </label>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
      <div v-if="loading" class="loading-list"><span v-for="index in 4" :key="index"></span></div>
      <EmptyState
        v-else-if="!entries.length"
        title="还没有疾病记录"
        description="导入报告后，报告里的诊断会自动汇总到这里；在病程里录入的症状也会一并列出。"
      />
      <section v-else class="settings-band entry-list-card">
        <header>
          <div><Activity :size="18" /><h3>疾病目录</h3></div>
          <span class="count-label">共 {{ entries.length }} 项</span>
        </header>
        <div class="entry-tabbar">
          <div class="entry-tabs" role="group" aria-label="疾病目录分类">
            <button
              v-for="tab in kindTabs"
              :key="tab.key"
              type="button"
              :aria-pressed="activeKind === tab.key"
              @click="activeKind = tab.key"
            >
              {{ tab.label }}<span class="entry-tab-count">{{ kindCount(tab.key) }}</span>
            </button>
          </div>
        </div>
        <div v-if="filtered.length" class="entry-grid">
          <div v-for="entry in filtered" :key="`${entry.kind}:${entry.name}`" class="entry-tile">
            <button class="entry-tile-main" type="button" @click="openEntry(entry)">
              <span class="entry-tile-head">
                <strong>{{ entry.name }}</strong>
                <span class="chip status-label" :class="kindChip(entry)">{{ kindLabel(entry) }}</span>
              </span>
              <span class="entry-tile-meta">{{ entry.count }} 次 · 最近 {{ formatDay(entry.lastAt) }}</span>
            </button>
            <button
              class="entry-tile-remove"
              type="button"
              :disabled="Boolean(hidingKey)"
              :title="`从目录隐藏「${entry.name}」`"
              :aria-label="`从目录隐藏 ${entry.name}`"
              @click="hideEntry(entry)"
            >
              <X :size="13" />
            </button>
          </div>
        </div>
        <p v-else class="entry-tab-empty">这个分类下暂时没有记录</p>

        <div v-if="hidden.length" class="entry-hidden-bar">
          <span>已隐藏 {{ hidden.length }} 项（报告里的原文未改动）</span>
          <button class="soft-action-button" type="button" @click="hiddenOpen = !hiddenOpen">
            {{ hiddenOpen ? "收起" : "管理" }}
          </button>
        </div>
        <div v-if="hiddenOpen && hidden.length" class="entry-list-body">
          <div v-for="item in hidden" :key="item.id" class="entry-row">
            <span class="entry-row-main">
              <strong>{{ item.name }}</strong>
              <span>{{ item.kind === "diagnosis" ? "诊断" : "症状" }} · 已隐藏</span>
            </span>
            <span class="entry-row-side">
              <button
                class="soft-action-button"
                type="button"
                :disabled="Boolean(hidingKey)"
                @click="restoreExclusion(item)"
              >恢复</button>
            </span>
          </div>
        </div>
      </section>

      <section v-if="keyword.trim()" class="settings-band entry-list-card">
        <header>
          <div><Search :size="18" /><h3>相关就诊记录</h3></div>
          <span class="count-label">同时匹配症状、病因、诊断与用药</span>
        </header>
        <div class="entry-list-body">
          <div v-if="searching" class="loading-list"><span v-for="index in 2" :key="index"></span></div>
          <EmptyState
            v-else-if="!searchResults.length"
            title="没有匹配的就诊记录"
            description="换个关键词试试，比如咳嗽、受凉，或者某个药名。"
          />
          <article v-else v-for="visit in searchResults" :key="visit.reportId" class="entry-row entry-row--stacked">
            <div class="entry-row-main">
              <strong>{{ formatDay(visit.issuedAt) }} · {{ visit.hospitalName || "医院未记录" }}</strong>
              <span>{{ [visit.departmentName, visit.title].filter(Boolean).join(" · ") }}</span>
              <small v-if="visit.diagnoses.length">诊断：{{ visit.diagnoses.join("、") }}</small>
              <small v-for="(med, index) in visit.medications" :key="index">
                用药：{{ medicationText(med) }}
              </small>
            </div>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>
