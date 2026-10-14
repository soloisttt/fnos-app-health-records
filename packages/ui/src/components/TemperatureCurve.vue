<script setup lang="ts">
import { computed } from "vue";
import type { TemperatureLevel } from "../utils/temperature";

/**
 * 这次生病的体温曲线 —— 纯 SVG，不引图表库。
 *
 * 横向按时间排（有缺失或全部同一时刻时退化成等距），纵向按读数自动定范围；
 * 37.5 / 38.5 两条参考线就是「低热」和「该考虑退烧药」的常见门槛，
 * 点按 正常 / 低热 / 发热 三档上色，最高点单独标注。
 */
export type TemperaturePoint = { at: string | null; reading: string; level: TemperatureLevel };

const props = defineProps<{ points: TemperaturePoint[] }>();

/* viewBox 按手机宽度定（≈340），这样图上的字和线差不多是 1:1，不会被缩得看不清；
   宽屏下用 CSS 的 max-width 兜住，最多放大约一倍。 */
const WIDTH = 340;
const HEIGHT = 190;
const PAD = { top: 24, right: 10, bottom: 26, left: 34 };
const GUIDES = [37.5, 38.5];

const chart = computed(() => {
  const entries = props.points
    .map((point, index) => ({ ...point, index, value: Number(point.reading) }))
    .filter((point) => Number.isFinite(point.value));
  if (!entries.length) {
    return { dots: [], polyline: "", guides: [], top: null, firstLabel: "", lastLabel: "" };
  }

  const values = entries.map((entry) => entry.value);
  const low = Math.min(36.5, Math.floor(Math.min(...values) - 0.5));
  const high = Math.max(40.5, Math.ceil(Math.max(...values) + 0.5));
  const x0 = PAD.left;
  const x1 = WIDTH - PAD.right;
  const yTop = PAD.top;
  const yBottom = HEIGHT - PAD.bottom;

  const times = props.points.map((point) =>
    point.at ? new Date(point.at.replace(" ", "T")).getTime() : Number.NaN,
  );
  const byTime =
    times.length > 1 && times.every((time) => Number.isFinite(time)) && new Set(times).size > 1;
  const start = times[0] ?? 0;
  const span = (times.at(-1) ?? 0) - start;
  const step = props.points.length > 1 ? (x1 - x0) / (props.points.length - 1) : 0;

  const xOf = (index: number) => {
    if (!byTime || span <= 0) return props.points.length > 1 ? x0 + index * step : (x0 + x1) / 2;
    return x0 + (((times[index] ?? start) - start) / span) * (x1 - x0);
  };
  const yOf = (value: number) => yBottom - ((value - low) / (high - low)) * (yBottom - yTop);

  const dots = entries.map((entry) => ({
    x: xOf(entry.index),
    y: yOf(entry.value),
    level: entry.level,
    reading: entry.reading,
    at: entry.at,
  }));

  let topIndex = 0;
  values.forEach((value, index) => {
    if (value > values[topIndex]!) topIndex = index;
  });

  return {
    dots,
    polyline: dots.map((dot) => `${dot.x.toFixed(1)},${dot.y.toFixed(1)}`).join(" "),
    guides: GUIDES.filter((value) => value > low && value < high).map((value) => ({ value, y: yOf(value) })),
    top: dots[topIndex] ?? null,
    firstLabel: entries[0]?.at?.slice(5, 16) ?? "",
    lastLabel: entries.at(-1)?.at?.slice(5, 16) ?? "",
  };
});

const ariaLabel = computed(() => {
  const top = chart.value.top;
  return `这次生病的体温曲线，共 ${chart.value.dots.length} 次记录${top ? `，最高 ${top.reading}℃` : ""}`;
});
</script>

<template>
  <svg
    class="episode-temp-curve"
    :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
    role="img"
    :aria-label="ariaLabel"
  >
    <title>这次生病的体温曲线</title>
    <desc>{{ ariaLabel }}</desc>

    <template v-for="guide in chart.guides" :key="`guide-${guide.value}`">
      <line
        class="episode-temp-curve-guide"
        :x1="PAD.left"
        :x2="WIDTH - PAD.right"
        :y1="guide.y"
        :y2="guide.y"
      />
      <text class="episode-temp-curve-axis" :x="PAD.left - 8" :y="guide.y + 4" text-anchor="end">
        {{ guide.value }}
      </text>
    </template>

    <polyline v-if="chart.dots.length > 1" class="episode-temp-curve-line" :points="chart.polyline" />
    <circle
      v-for="(dot, index) in chart.dots"
      :key="`dot-${index}`"
      class="episode-temp-curve-dot"
      :class="`is-${dot.level}`"
      :cx="dot.x"
      :cy="dot.y"
      r="4.5"
    />

    <template v-if="chart.top">
      <circle
        class="episode-temp-curve-dot is-top"
        :class="`is-${chart.top.level}`"
        :cx="chart.top.x"
        :cy="chart.top.y"
        r="7"
      />
      <text
        class="episode-temp-curve-top"
        :x="chart.top.x"
        :y="chart.top.y - 15"
        text-anchor="middle"
      >{{ chart.top.reading }}℃</text>
    </template>

    <text v-if="chart.firstLabel" class="episode-temp-curve-axis" :x="PAD.left" :y="HEIGHT - 10">
      {{ chart.firstLabel }}
    </text>
    <text
      v-if="chart.lastLabel"
      class="episode-temp-curve-axis"
      :x="WIDTH - PAD.right"
      :y="HEIGHT - 10"
      text-anchor="end"
    >{{ chart.lastLabel }}</text>
  </svg>
</template>
