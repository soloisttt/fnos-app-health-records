<script setup lang="ts">
/**
 * 「按次看 / 按病看」的切换条：**同一个入口的两个视角**。
 *
 * 为什么不做成一个页面里切页签：两块内容本来就各自独立、各有一条深链接
 * （`/episodes` 按次、`/diseases` 按病）。在两边顶部放同一排切换条，
 * 用起来就是一个入口两个视角，而**老链接和收藏都不会失效**。
 *
 * 主视角是「按次」：每次生病都有一条病程，但没看医生、没诊断的那几次
 * （自己在家扛的感冒）根本不会出现在疾病列表里 —— 按次看才是全集。
 */
import { useRoute } from "vue-router";
import { ClipboardList, Stethoscope } from "@lucide/vue";

const route = useRoute();
/** 没有 router 的测试环境里 useRoute() 可能拿不到，按「按次看」兜底 */
const onDiseaseView = () => route?.path === "/diseases";
</script>

<template>
  <nav class="case-view-tabs" aria-label="病程与疾病">
    <RouterLink to="/episodes" class="case-view-tab" :class="{ 'is-active': !onDiseaseView() }">
      <ClipboardList :size="16" />按次看
    </RouterLink>
    <RouterLink to="/diseases" class="case-view-tab" :class="{ 'is-active': onDiseaseView() }">
      <Stethoscope :size="16" />按病看
    </RouterLink>
  </nav>
</template>
