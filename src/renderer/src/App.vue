<script setup lang="ts">
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { computed, onMounted, onUnmounted } from 'vue';
import { useStockStore } from './stores/stockStore';

const store = useStockStore();
const router = useRouter();
const route = useRoute();
let offNavigate: (() => void) | null = null;

/** 关于页（模态窗口内）独占整窗：不渲染顶部导航条，只显示内容本身 */
const fullscreen = computed(() => Boolean(route.meta.fullscreen));

onMounted(() => {
  // 读取上次选择的拉取范围，并订阅主进程推送的抓取进度
  store.initUi();
  void store.refreshStatus();
  // 托盘菜单 / 应用菜单的路由跳转（主进程单向事件）
  offNavigate = window.quantApi.onNavigate((p) => void router.push(p.path));
});

onUnmounted(() => offNavigate?.());
</script>

<template>
  <div class="h-full flex flex-col">
    <header
      v-if="!fullscreen"
      class="flex items-center justify-between px-5 h-14 border-b border-edge bg-panel"
    >
      <div class="flex items-center gap-2">
        <span class="text-accent text-lg font-black">QuantPilot</span>
        <span class="text-xs text-gray-500">A股短线选股引擎</span>
      </div>
      <nav class="flex gap-1 text-sm">
        <RouterLink to="/" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">仪表盘</RouterLink>
        <RouterLink to="/market" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">A股行情</RouterLink>
        <RouterLink to="/limitup" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">涨停池</RouterLink>
        <RouterLink to="/sentiment" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">市场情绪</RouterLink>
        <RouterLink to="/sectors" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">板块</RouterLink>
        <RouterLink to="/watchlist" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">我的自选</RouterLink>
        <RouterLink to="/strategy" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">策略配置</RouterLink>
        <RouterLink to="/backtest" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">回测</RouterLink>
        <RouterLink to="/settings" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">设置</RouterLink>
        <RouterLink to="/stock/sh.600000" class="px-3 py-1.5 rounded-lg hover:bg-panel2" active-class="bg-panel2 text-accent">个股</RouterLink>
      </nav>
    </header>
    <main class="flex-1 overflow-auto" :class="fullscreen ? '' : 'p-5'">
      <RouterView />
    </main>
  </div>
</template>
