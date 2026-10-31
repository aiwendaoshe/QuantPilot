<script setup lang="ts">
import type { SignalType } from '@shared/types/signal';

const props = defineProps<{ type: SignalType }>();

const MAP: Record<SignalType, { label: string; cls: string }> = {
  trend: { label: '趋势', cls: 'bg-bull/20 text-bull border-bull/40' },
  reversal: { label: '反包', cls: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  breakout: { label: '突破', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/40' },
  limitdown: { label: '跌停反包', cls: 'bg-bear/20 text-bear border-bear/40' },
};
</script>

<template>
  <span class="px-2 py-0.5 rounded border text-xs font-medium" :class="MAP[props.type].cls">
    {{ MAP[props.type].label }}
  </span>
</template>
