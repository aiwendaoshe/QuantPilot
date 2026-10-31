<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, version as vueVersion } from 'vue';
import type { AppInfo } from '@shared/types/ipc';
// 二维码由 Vite 处理成带 hash 的产物 URL（base 是 './'，file:// 下也能正确解析）
import qrUrl from '../assets/aiwendao-qr.jpg';

const info = ref<AppInfo | null>(null);
const err = ref('');
const year = new Date().getFullYear();
/** 根节点 ref：它的 scrollHeight 就是「本页内容真实需要的高度」 */
const rootEl = ref<HTMLElement | null>(null);

/**
 * 版本行：严格对齐参考图的「版本 / Electron / Chrome / Node.js」四行，
 * 外加本项目的 Vue（渲染层框架，主进程 process.versions 里没有，从 vue 包直接读）。
 */
const rows = computed(() => [
  { label: '版本:', value: info.value?.version ?? '…' },
  { label: 'Electron:', value: info.value?.electron ?? '—' },
  { label: 'Chrome:', value: info.value?.chrome ?? '—' },
  { label: 'Node.js:', value: info.value?.node ?? '—' },
  { label: 'Vue:', value: vueVersion },
]);

function close(): void {
  window.close();
}

function onKey(e: KeyboardEvent): void {
  // 模态对话框：Esc / Enter 均可关（本页无输入控件，Enter 不会误触）
  if (e.key === 'Escape' || e.key === 'Enter') close();
}

let ro: ResizeObserver | null = null;
let rafId = 0;

/**
 * 把「内容真实高度」上报给主进程，由它 setContentSize 把窗口调到刚好放下。
 *
 * 为什么不靠 CSS 自适应：窗口尺寸只有主进程能改。硬编码高度在换字体/DPI 时
 * 一定会溢出（→ 滚动条）或留白，所以高度必须**实测回传**。
 * rAF 合并：ResizeObserver 和字体加载可能一帧内触发多次，避免重复 IPC。
 */
function reportHeight(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const el = rootEl.value;
    if (!el) return;
    const h = el.scrollHeight;
    if (h > 0) void window.quantApi.fitWindowHeight(h);
  });
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);

  // ① 先量一次（此刻版本行还是「…」占位，但行数已定，高度基本不差）
  await nextTick();
  reportHeight();

  // ② 内容尺寸任何变化都重报：系统缩放、字体回退、免责声明换行都会改变高度
  if (rootEl.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => reportHeight());
    ro.observe(rootEl.value);
  }

  try {
    info.value = await window.quantApi.getAppInfo();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }

  // ③ 版本号落到真实值、字体加载完成后各补一次，确保窗口不多不少
  await nextTick();
  reportHeight();
  void document.fonts?.ready.then(reportHeight);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  ro?.disconnect();
  ro = null;
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<template>
  <!--
    根节点刻意**不写 h-full**：它必须回到「内容高度」，scrollHeight 才是内容实需。
    max-h-screen + overflow-y-auto 只是极小屏（主进程把高度钳到工作区 90%）时的兜底，
    正常情况窗口高度由主进程按实测值撑开，永不出现滚动条。
  -->
  <div
    ref="rootEl"
    data-about-root
    class="flex max-h-screen flex-col overflow-y-auto bg-panel text-gray-200"
  >
    <!-- 主体：紧凑对话框版式（图标 + 名称 + 版本行 + 免责声明） -->
    <div class="px-5 py-4">
      <div class="flex items-start gap-3">
        <svg width="40" height="40" viewBox="0 0 72 72" class="shrink-0 mt-0.5">
          <rect x="6" y="6" width="60" height="60" rx="16" fill="#11161f" stroke="#f59e0b" stroke-width="2" />
          <polyline
            points="18,50 28,38 38,44 54,20"
            fill="none"
            stroke="#f59e0b"
            stroke-width="3.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="28" cy="38" r="3" fill="#ef4444" />
          <circle cx="38" cy="44" r="3" fill="#ef4444" />
          <circle cx="54" cy="20" r="3.5" fill="#f59e0b" />
        </svg>

        <div class="min-w-0 flex-1">
          <div class="text-lg font-bold leading-tight text-accent">QuantPilot</div>
          <p class="mt-0.5 text-[11px] text-gray-500">A 股短线选股引擎 · 本地离线计算</p>

          <!-- 版本行：label 定宽对齐，值超出不换行截断 -->
          <dl class="mt-2.5 grid grid-cols-[62px_1fr] gap-x-2 gap-y-[3px] text-[11px] leading-snug">
            <template v-for="r in rows" :key="r.label">
              <dt class="text-gray-500">{{ r.label }}</dt>
              <dd class="text-gray-300 truncate">{{ r.value }}</dd>
            </template>
          </dl>
        </div>

        <!--
          右上角：公众号二维码（主子指定）。
          alt/figcaption 统一用「AI问道社」——alt 是给读屏与图片加载失败兜底的文案。
          图片本体是白底黑块（JPG 无透明通道），与深色面板叠加时用圆角 + 细描边收边，
          避免一块纯白方块显得突兀。
        -->
        <figure class="flex shrink-0 flex-col items-center">
          <img
            :src="qrUrl"
            alt="AI问道社 公众号二维码"
            width="84"
            height="84"
            draggable="false"
            class="h-[84px] w-[84px] rounded-md ring-1 ring-white/15"
          />
          <figcaption class="mt-1 text-[10px] leading-none text-gray-500">AI问道社</figcaption>
        </figure>
      </div>

      <!-- 免责声明（主子硬要求：务必保留全文） -->
      <div class="mt-3.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5">
        <div class="text-[11px] font-semibold text-warn">免责声明</div>
        <p class="mt-1 text-[11px] leading-[1.7] text-gray-400">
          本软件为个人技术演示与量化研究工具，所有选股信号、评分与回测结果均由本地算法生成，
          <span class="text-gray-300">不构成任何投资建议或买卖要约</span>。股市有风险，据此操作，风险自担。
        </p>
      </div>

      <p v-if="err" class="mt-2.5 text-[11px] text-bear">读取应用信息失败：{{ err }}</p>
    </div>

    <!-- 底栏：左版权（极简一行，不占额外高度）+ 右「确定」 -->
    <div class="flex shrink-0 items-center justify-between gap-3 border-t border-edge px-5 py-2.5">
      <span class="text-[11px] text-gray-600">© {{ year }} AI问道社</span>
      <button
        type="button"
        class="min-w-[76px] rounded border border-edge bg-panel2 px-4 py-1 text-xs text-gray-200 outline-none transition-colors hover:border-accent/60 hover:text-accent focus:border-accent focus:ring-1 focus:ring-accent/40"
        autofocus
        @click="close"
      >
        确定
      </button>
    </div>
  </div>
</template>
