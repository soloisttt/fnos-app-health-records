<script setup lang="ts">
/**
 * 体检报告「与上次对比」弹层。
 *
 * 为什么体检才做对比：同一套项目反复做（血常规、肝功能…），单看一次没有意义，
 * 价值全在"这次和上次比变了没有"。而且「变好 / 变差」只认参考范围 ——
 * 两边都正常只是数值上下浮动，不算变差，免得把人吓着。
 */
import { computed, ref, watch } from "vue";
import { ArrowDown, ArrowUp, FileText, Minus, X } from "@lucide/vue";
import { request } from "../utils/api";
import { useScrollLock } from "../composables/useScrollLock";
import type { CheckupComparison } from "../types/api";

const props = defineProps<{ open: boolean; reportId: string }>();
const emit = defineEmits<{ close: []; openReport: [id: string] }>();

const data = ref<CheckupComparison | null>(null);
const loading = ref(false);
const error = ref("");

async function load(reportId: string) {
  loading.value = true;
  error.value = "";
  data.value = null;
  try {
    data.value = await request<CheckupComparison>(
      `checkup-comparison?reportId=${encodeURIComponent(reportId)}`,
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载对比失败";
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.reportId] as const,
  ([open, reportId]) => {
    if (open && reportId) void load(reportId);
  },
  { immediate: true },
);

useScrollLock(computed(() => props.open));

/* 变差的排最前面 —— 打开就知道该看哪儿；没变动的排最后，不用一屏屏翻 */
const TREND_ORDER: Record<string, number> = { worse: 0, better: 1, new: 2, flat: 3 };
const sortedItems = computed(() =>
  (data.value?.items ?? []).slice().sort((left, right) => {
    const diff = (TREND_ORDER[left.trend] ?? 9) - (TREND_ORDER[right.trend] ?? 9);
    return diff !== 0 ? diff : left.name.localeCompare(right.name, "zh-Hans-CN");
  }),
);

const day = (value: string | null) => (value ? value.slice(0, 10) : "日期待确认");
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="episode-sheet-layer"
      @click.self="emit('close')"
      @touchstart.self.prevent="emit('close')"
    >
      <div class="episode-sheet checkup-compare-sheet" role="dialog" aria-modal="true" aria-label="与上次体检对比">
        <div class="episode-sheet-head">
          <div>
            <h3>与上次对比</h3>
            <p>{{ data?.report.title || "体检报告" }}</p>
          </div>
          <button type="button" class="episode-sheet-close" aria-label="关闭" @click="emit('close')">
            <X :size="18" />
          </button>
        </div>

        <div class="episode-sheet-body">
          <p v-if="loading" class="checkup-compare-note">正在对比…</p>
          <p v-else-if="error" class="inline-panel-error">{{ error }}</p>
          <template v-else-if="data">
            <p v-if="!data.previous" class="checkup-compare-note">
              这是第一份体检报告，没有可以对比的上一次。下次做完体检，这里会自动列出哪些指标变了。
            </p>
            <template v-else>
              <div class="checkup-compare-summary">
                <span class="checkup-compare-vs">
                  对比 {{ day(data.previous.issuedAt) }} 那份「{{ data.previous.title }}」，共 {{ data.summary.total }} 项
                </span>
                <b v-if="data.summary.worse" class="is-worse">{{ data.summary.worse }} 项变差</b>
                <b v-else class="is-flat">没有变差的项</b>
                <b v-if="data.summary.better" class="is-better">{{ data.summary.better }} 项变好</b>
              </div>

              <div class="checkup-compare-list">
                <div
                  v-for="item in sortedItems"
                  :key="item.name"
                  class="checkup-compare-row"
                  :class="`is-${item.trend}`"
                >
                  <span class="checkup-compare-name">{{ item.name }}</span>
                  <span class="checkup-compare-values">
                    <em class="checkup-compare-prev">{{ item.previous ?? "—" }}{{ item.previous ? item.unit ?? "" : "" }}</em>
                    <span class="checkup-compare-arrow" :class="`dir-${item.direction ?? 'same'}`">
                      <ArrowUp v-if="item.direction === 'up'" :size="13" />
                      <ArrowDown v-else-if="item.direction === 'down'" :size="13" />
                      <Minus v-else :size="13" />
                    </span>
                    <b class="checkup-compare-cur" :class="{ 'is-abnormal': item.abnormal }">
                      {{ item.current }}{{ item.unit ?? "" }}
                    </b>
                  </span>
                </div>
              </div>
              <p class="checkup-compare-note">
                「变差 / 变好」按参考范围判断：这次超出范围、上次正常才算变差；
                两边都正常时的数值上下浮动不算变化。
              </p>
            </template>
          </template>
        </div>

        <div class="episode-sheet-actions">
          <button type="button" class="episode-sheet-cancel" @click="emit('close')">关闭</button>
          <button type="button" class="episode-sheet-save" @click="emit('openReport', reportId)">
            <FileText :size="16" />查看这份报告
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
