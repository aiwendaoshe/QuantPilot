<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { BacktestResult } from '@shared/types/backtest';
import { buildEquityOption } from './chartOptions';

const props = defineProps<{
  result: BacktestResult;
  height?: string;
}>();

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function render(): void {
  if (!el.value) return;
  if (!chart) chart = echarts.init(el.value);
  chart.setOption(buildEquityOption(props.result.equityCurve), true);
  chart.resize();
}

onMounted(render);
// 引用变化即可触发，无需深度遍历（deep 会在每次刷新时白烧 CPU）
watch(() => props.result, render);
onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="el" :style="{ width: '100%', height: height ?? '360px' }"></div>
</template>
