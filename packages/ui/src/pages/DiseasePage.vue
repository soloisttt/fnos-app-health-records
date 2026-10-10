<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ArrowLeft, Search } from "@lucide/vue";
import EmptyState from "../components/EmptyState.vue";
import { request } from "../utils/api";
import type { DiseaseCatalogEntry, DiseaseVisit } from "../types/api";
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

const filtered = computed(() => {
  const needle = keyword.value.trim().toLowerCase();
  const list = entries.value;
  if (!needle) return list;
  return list.filter((entry) => entry.name.toLowerCase().includes(needle));
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
      <div v-else class="data-list">
        <article v-for="visit in records" :key="visit.reportId">
          <div class="reminder-card-head">
            <div class="reminder-card-main">
              <strong>{{ formatDay(visit.issuedAt) }} · {{ visit.hospitalName || "医院未记录" }}</strong>
              <span>{{ [visit.departmentName, visit.title].filter(Boolean).join(" · ") }}</span>
              <small v-if="visit.diagnoses.length">诊断：{{ visit.diagnoses.join("、") }}</small>
              <small v-for="(med, index) in visit.medications" :key="index">
                用药：{{ medicationText(med) }}
              </small>
            </div>
          </div>
        </article>
      </div>
    </template>

    <template v-else>
      <label class="search-field">
        <Search :size="16" />
        <input v-model="keyword" type="search" placeholder="搜索症状或疾病，例如 咳嗽" />
      </label>
      <p v-if="error" class="inline-panel-error">{{ error }}</p>
      <div v-if="loading" class="loading-list"><span v-for="index in 4" :key="index"></span></div>
      <EmptyState
        v-else-if="!filtered.length && !keyword.trim()"
        title="还没有疾病记录"
        description="导入报告后，报告里的诊断会自动汇总到这里；在病程里录入的症状也会一并列出。"
      />
      <div v-else-if="filtered.length" class="data-list">
        <article v-for="entry in filtered" :key="`${entry.kind}:${entry.name}`">
          <button class="disease-row" type="button" @click="openEntry(entry)">
            <span class="reminder-card-main">
              <strong>{{ entry.name }}</strong>
              <span>{{ entry.count }} 次 · 最近 {{ formatDay(entry.lastAt) }}</span>
            </span>
            <span class="chip status-label" :class="kindChip(entry)">{{ kindLabel(entry) }}</span>
          </button>
        </article>
      </div>

      <template v-if="keyword.trim()">
        <div class="page-intro">
          <div>
            <h3>相关就诊记录</h3>
            <p>同时匹配症状、病因、诊断与用药</p>
          </div>
        </div>
        <div v-if="searching" class="loading-list"><span v-for="index in 2" :key="index"></span></div>
        <EmptyState
          v-else-if="!searchResults.length"
          title="没有匹配的就诊记录"
          description="换个关键词试试，比如咳嗽、受凉，或者某个药名。"
        />
        <div v-else class="data-list">
          <article v-for="visit in searchResults" :key="visit.reportId">
            <div class="reminder-card-head">
              <div class="reminder-card-main">
                <strong>{{ formatDay(visit.issuedAt) }} · {{ visit.hospitalName || "医院未记录" }}</strong>
                <span>{{ [visit.departmentName, visit.title].filter(Boolean).join(" · ") }}</span>
                <small v-if="visit.diagnoses.length">诊断：{{ visit.diagnoses.join("、") }}</small>
                <small v-for="(med, index) in visit.medications" :key="index">
                  用药：{{ medicationText(med) }}
                </small>
              </div>
            </div>
          </article>
        </div>
      </template>
    </template>
  </section>
</template>
