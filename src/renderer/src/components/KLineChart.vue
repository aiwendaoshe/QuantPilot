<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { DailyBar, SignalMark } from '@shared/types/stock';
import { buildKLineOption } from './chartOptions';

const props = defineProps<{
  bars: DailyBar[];
  marks?: SignalMark[];
  height?: string;
  /** 传入时启用涨停日三角标注（用代码算板块涨幅上限） */
  limitUp?: { code: string; name?: string };
}>();

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function render(): void {
  if (!el.value) return;
  if (!chart) chart = echarts.init(el.value);
  chart.setOption(buildKLineOption(props.bars, props.marks ?? [], props.limitUp), true);
  chart.resize();
}

onMounted(render);
// 引用变化即可触发：deep 会把 240 根 K 线的整棵对象树遍历一遍，白烧 CPU
watch(() => [props.bars, props.marks, props.limitUp], render);
onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="el" :style="{ width: '100%', height: height ?? '420px' }"></div>
</template>
