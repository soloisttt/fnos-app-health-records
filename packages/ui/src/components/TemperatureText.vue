<script setup lang="ts">
import { computed } from "vue";
import { temperatureRuns } from "../utils/temperature";

const props = defineProps<{ text: string }>();
const runs = computed(() => temperatureRuns(props.text));
</script>

<template><span class="temperature-text"><template v-for="(run, index) in runs" :key="index"><span v-if="run.level" class="episode-temp" :class="`episode-temp-${run.level}`">{{ run.text }}</span><span v-else>{{ run.text }}</span></template></span></template>
