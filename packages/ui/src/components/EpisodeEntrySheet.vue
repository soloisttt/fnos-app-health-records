<script setup lang="ts">
/**
 * 病程条目的「小面板」：从下方弹出，用来**记一次**（时间 + 状态 / 用量）或**编辑**一条记录。
 *
 * 为什么不复用上面那张大表单：大表单是"第一次添加"用的，字段全、占满屏幕；
 * 日常最高频的动作是"再记一次"（咳嗽加重了、又喂了一次药），
 * 只要「时间 + 状态」两个格子，弹一下就能存，不跳页、不滚动。
 */
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import DateTimePicker from "./DateTimePicker.vue";
import { useScrollLock } from "../composables/useScrollLock";
import type { CaseSymptomStatus } from "../types/api";

export type EpisodeSheetMode = "symptom" | "medication";
export type EpisodeSheetIntent = "create" | "edit" | "log";

export type EpisodeSheetForm = {
  name: string;
  at: string;
  status: CaseSymptomStatus;
  value: string;
  unit: string;
  severity: string;
  bodyPart: string;
  dose: string;
  frequency: string;
  route: string;
};

const props = defineProps<{
  open: boolean;
  mode: EpisodeSheetMode;
  intent: EpisodeSheetIntent;
  /** 记录对象的名字（log / edit 时作为标题） */
  subject?: string;
  busy?: boolean;
  /** 是否显示「数值 / 单位」（体温、血压这类） */
  showValue?: boolean;
  form: EpisodeSheetForm;
}>();

const emit = defineEmits<{
  close: [];
  save: [values: EpisodeSheetForm, repeat: boolean];
}>();

const draft = ref<EpisodeSheetForm>({ ...props.form });

watch(
  () => props.open,
  (open) => {
    if (open) draft.value = { ...props.form };
  },
);

useScrollLock(computed(() => props.open));

const namePlaceholder = computed(() =>
  props.mode === "medication" ? "例如 氨溴特罗口服溶液" : "例如 咳嗽",
);

const title = computed(() => {
  const subject = props.subject ?? draft.value.name ?? "";
  if (props.mode === "medication") {
    if (props.intent === "log") return subject ? `记一次服药 · ${subject}` : "记一次服药";
    return props.intent === "edit" ? "编辑用药" : "补充用药";
  }
  if (props.intent === "log") return subject ? `记一次 · ${subject}` : "记一次";
  return props.intent === "edit" ? "编辑症状" : "补充症状";
});

/** 日常跟踪最常用的四个状态；旧数据的「不确定」只在编辑时补出来 */
const statusOptions: Array<{ value: CaseSymptomStatus; label: string }> = [
  { value: "present", label: "存在" },
  { value: "worse", label: "加重" },
  { value: "improved", label: "减轻" },
  { value: "resolved", label: "消失" },
];

const showName = computed(() => props.intent !== "log");
const showDetails = computed(() => props.intent !== "log");
const showValueField = computed(() => props.mode === "symptom" && (props.intent !== "log" || props.showValue));
const unitSuggestions = ["℃", "mmHg", "次/分", "kg"];

function submit(repeat: boolean) {
  if (props.busy) return;
  emit("save", { ...draft.value }, repeat);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="episode-sheet-layer"
      @click.self="emit('close')"
      @touchstart.self.prevent="emit('close')"
    >
      <div class="episode-sheet" role="dialog" aria-modal="true" :aria-label="title">
        <div class="episode-sheet-head">
          <div>
            <h3>{{ title }}</h3>
            <p v-if="intent === 'log' && mode === 'symptom'">选一下现在的状态就行</p>
            <p v-else-if="intent === 'log'">填一下这次吃了多少</p>
          </div>
          <button type="button" class="episode-sheet-close" aria-label="关闭" @click="emit('close')">
            <X :size="18" />
          </button>
        </div>

        <div class="episode-sheet-body">
          <label v-if="showName" class="episode-sheet-field">
            <span>{{ mode === "medication" ? "药品名称" : "症状名称" }}</span>
            <input v-model="draft.name" :placeholder="namePlaceholder" />
          </label>

          <label class="episode-sheet-field">
            <span>{{ mode === "medication" ? "服药时间" : "时间" }}</span>
            <DateTimePicker v-model="draft.at" :aria-label="mode === 'medication' ? '服药时间' : '症状时间'" show-time variant="plain" />
          </label>

          <div v-if="mode === 'symptom'" class="episode-sheet-field">
            <span>现在的状态</span>
            <div class="episode-sheet-status">
              <button
                v-for="option in statusOptions"
                :key="option.value"
                type="button"
                :class="['episode-sheet-status-item', `is-${option.value}`, { active: draft.status === option.value }]"
                @click="draft.status = option.value"
              >
                {{ option.label }}
              </button>
              <button
                v-if="draft.status === 'unknown'"
                type="button"
                class="episode-sheet-status-item active"
                @click="draft.status = 'unknown'"
              >
                不确定
              </button>
            </div>
          </div>

          <template v-if="showValueField">
            <div class="episode-sheet-grid">
              <label class="episode-sheet-field">
                <span>数值</span>
                <input v-model="draft.value" inputmode="decimal" placeholder="例如 37.5" />
              </label>
              <label class="episode-sheet-field">
                <span>单位</span>
                <input v-model="draft.unit" placeholder="例如 ℃" />
              </label>
            </div>
            <div class="episode-sheet-chips">
              <button type="button" @click="draft.unit = ''">不填单位</button>
              <button v-for="unit in unitSuggestions" :key="unit" type="button" @click="draft.unit = unit">
                {{ unit }}
              </button>
            </div>
          </template>

          <template v-if="mode === 'medication'">
            <div class="episode-sheet-grid">
              <label class="episode-sheet-field">
                <span>{{ intent === "log" ? "这次吃了多少" : "单次剂量" }}</span>
                <input v-model="draft.dose" placeholder="例如 5ml、半片" />
              </label>
              <label class="episode-sheet-field">
                <span>用法</span>
                <input v-model="draft.route" placeholder="例如 口服、外用" />
              </label>
            </div>
            <label v-if="intent !== 'log'" class="episode-sheet-field">
              <span>服药频次</span>
              <input v-model="draft.frequency" placeholder="例如 tid（每日三次）" />
            </label>
            <div class="episode-sheet-chips">
              <button v-for="item in ['qd', 'bid', 'tid', 'qid', 'prn']" :key="item" type="button" @click="draft.frequency = item">
                {{ item }}
              </button>
            </div>
          </template>

          <template v-if="showDetails && mode === 'symptom'">
            <div class="episode-sheet-grid">
              <label class="episode-sheet-field">
                <span>程度</span>
                <input v-model="draft.severity" placeholder="例如 轻、中、重" />
              </label>
              <label class="episode-sheet-field">
                <span>部位</span>
                <input v-model="draft.bodyPart" placeholder="例如 咽喉" />
              </label>
            </div>
          </template>
        </div>

        <div class="episode-sheet-actions">
          <button type="button" class="episode-sheet-cancel" @click="emit('close')">取消</button>
          <button v-if="intent === 'log'" type="button" class="episode-sheet-secondary" :disabled="busy" @click="submit(true)">
            保存并再记一条
          </button>
          <button type="button" class="episode-sheet-save" :disabled="busy" @click="submit(false)">保存</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
