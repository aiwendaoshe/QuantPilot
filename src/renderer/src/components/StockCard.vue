<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Signal } from '@shared/types/signal';
import { STRATEGY_LABELS } from '@shared/constants/strategies';
import SignalTag from './SignalTag.vue';
import ScoreRadar from './ScoreRadar.vue';

const props = defineProps<{ signal: Signal; rank: number }>();
const hasBreakdown = computed(() => props.signal.breakdown !== undefined);

/** 同一只票被几个策略命中（aggregateSignals 已合并成一条，这里只做提示） */
const hits = computed(() => {
  const h = props.signal.extra?.hits;
  return typeof h === 'number' && h > 1 ? h : null;
});
</script>

<template>
  <RouterLink :to="`/stock/${props.signal.code}`" class="block">
    <div
      class="bg-panel2 border border-edge rounded-xl p-4 flex flex-col gap-2 hover:border-accent/60 transition cursor-pointer h-full"
    >
      <!-- 身份行：排名 · 代码 · 中文名（代码后紧跟名称，名称只出现一次，避免与标题重复） -->
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-baseline gap-2 min-w-0">
          <span class="text-xs text-gray-600 shrink-0">{{ props.rank }}</span>
          <span class="text-xs text-gray-400 font-mono shrink-0">{{ props.signal.code }}</span>
          <span class="text-base font-bold truncate" :title="props.signal.name">
            {{ props.signal.name || '—' }}
          </span>
        </div>
        <div class="text-right shrink-0">
          <div class="text-2xl font-extrabold text-accent">{{ props.signal.score }}</div>
          <div class="text-[10px] text-gray-500">评分</div>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <SignalTag :type="props.signal.type" />
        <span class="text-sm text-bull">¥{{ props.signal.price.toFixed(2) }}</span>
        <span
          v-if="hits"
          class="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent"
          :title="String(props.signal.extra?.strategyIds ?? '')"
        >
          +{{ hits - 1 }} 策略
        </span>
      </div>

      <p class="text-xs text-gray-400 leading-relaxed line-clamp-2">{{ props.signal.reason }}</p>

      <div v-if="hasBreakdown" class="mt-1">
        <ScoreRadar :breakdown="props.signal.breakdown!" height="148px" />
        <p class="text-[9px] text-gray-500 leading-tight mt-0.5">
          <template v-if="props.signal.sectorReal">
            板块为该股所属板块当日真实涨幅（M2）· 资金仍为价格派生估算值
          </template>
          <template v-else>
            资金·板块为价格派生估算值（板块数据未刷新或该股无板块）
          </template>
        </p>
      </div>
      <div class="text-[10px] text-gray-600 truncate">
        {{ STRATEGY_LABELS[props.signal.strategyId] ?? props.signal.strategyId }} · {{ props.signal.date }}
      </div>
    </div>
  </RouterLink>
</template>
