import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import log from 'electron-log';

/** 关于窗口单例：重复点击菜单只聚焦，不叠窗 */
let aboutWin: BrowserWindow | null = null;

/**
 * 渲染层上报的内容高度（DIP）。null = 还没量到。
 *
 * ⚠️ 窗口高度**不再硬编码**：字体 / DPI / 系统缩放下内容高度会漂移，
 * 任何写死的值迟早会溢出（→ 冒出滚动条）或留一大片空白。
 * 正解 = 渲染层实测 → 主进程 setContentSize，窗口刚好裹住内容。
 */
let pendingFitHeight: number | null = null;

/** 渲染层是否已 ready-to-show（量到高度但页面没就绪时不能抢 show） */
let readyToShow = false;
/** 首帧上报兜底定时器：渲染层异常时不至于永远不显示窗口 */
let showTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 关于窗宽度（内容区）。
 *
 * 480 → 500（v0.9.9）：加宽是为了让免责声明末行不再被拆字
 * （「风险自 / 担。」那种断行），顺带给右上角的公众号二维码留出位置。
 */
const ABOUT_WIDTH = 500;
/** 兜底高度：只在渲染层迟迟不报高度时用（正常 1~2 帧内必到） */
const ABOUT_FALLBACK_HEIGHT = 340;
/** 等首帧上报的上限；超时就按兜底高度先显示，不让用户对着空窗发呆 */
const FIRST_FIT_WAIT_MS = 600;

/** 高度上限：小屏 / 高缩放也不能顶出工作区（宁可让内容区滚动，也不让标题栏飞出屏幕） */
function maxAboutHeight(): number {
  const { height } = screen.getPrimaryDisplay().workAreaSize;
  return Math.max(240, Math.round(height * 0.9));
}

function aboutUrl(): string {
  const dev = process.env.VITE_DEV_SERVER_URL;
  // dev=项目根/dist-electron 时渲染产物在 dist/，hash 路由 #/about 直接指向关于页
  return dev
    ? `${dev}#/about`
    : `file://${path.join(__dirname, '../dist/index.html')}#/about`;
}

/** 释放父窗：模态期间父窗被 setEnabled(false)，关闭时必须还原，否则主界面永久点不动 */
function releaseParent(main: BrowserWindow | null): void {
  if (!main || main.isDestroyed()) return;
  main.setEnabled(true);
  main.focus();
}

/** 高度变化后重新居中（模态挂父窗中心，独立窗口用屏幕工作区中心），并夹回工作区防跑出屏幕 */
function recenter(): void {
  const win = aboutWin;
  if (!win || win.isDestroyed()) return;
  const work = screen.getPrimaryDisplay().workArea;
  const [w, h] = win.getSize();
  const parent = win.getParentWindow();

  let nx: number;
  let ny: number;
  if (parent && !parent.isDestroyed()) {
    const pb = parent.getBounds();
    nx = Math.round(pb.x + (pb.width - w) / 2);
    ny = Math.round(pb.y + (pb.height - h) / 2);
  } else {
    nx = Math.round(work.x + (work.width - w) / 2);
    ny = Math.round(work.y + (work.height - h) / 2);
  }

  // 夹回工作区：内容比屏幕还高时优先保住标题栏（可拖走），而不是让窗口跑到屏幕上方去
  const maxX = work.x + Math.max(0, work.width - w);
  const maxY = work.y + Math.max(0, work.height - h);
  win.setPosition(Math.min(Math.max(nx, work.x), maxX), Math.min(Math.max(ny, work.y), maxY));
}

/** 有高度 + 页面就绪才显示（避免「先弹小窗再跳大」的抽动） */
function tryShow(): void {
  const win = aboutWin;
  if (!win || win.isDestroyed()) return;
  if (!readyToShow || pendingFitHeight === null) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (!win.isVisible()) win.show();
}

/**
 * 打开「关于」窗口。
 * @param parent 主窗口；传入则渲染为**模态对话框**（父窗被禁用直到本窗关闭），
 *               传 null / 已销毁时自动降级为非模态独立窗口，不会崩。
 */
export function openAboutWindow(parent?: BrowserWindow | null): void {
  const main = parent && !parent.isDestroyed() ? parent : null;

  if (aboutWin && !aboutWin.isDestroyed()) {
    if (aboutWin.isMinimized()) aboutWin.restore();
    aboutWin.focus();
    return;
  }

  pendingFitHeight = null;
  readyToShow = false;

  aboutWin = new BrowserWindow({
    width: ABOUT_WIDTH,
    // 先给兜底高度，首帧上报一到就校正成内容实高
    height: ABOUT_FALLBACK_HEIGHT,
    minWidth: 470,
    // 不再用 320 硬撑：内容变短时窗口要能跟着缩回去
    minHeight: 240,
    backgroundColor: '#0b0f17',
    title: '关于 QuantPilot',
    show: false,
    autoHideMenuBar: true,
    // 对话框语义：尺寸由内容驱动，禁掉最大化/最小化/拖拽缩放。
    // （可缩放只会让用户手动制造出滚动条或大片空白，对自适应窗口没有意义）
    maximizable: false,
    minimizable: false,
    resizable: false,
    // 模态：挂在主窗上，父窗在关闭前不可交互
    ...(main ? { parent: main, modal: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  aboutWin.setMenu(null);
  // 关闭瞬间就解锁父窗（focus 放到 closed，避免抢焦点）
  aboutWin.on('close', () => {
    if (main && !main.isDestroyed()) main.setEnabled(true);
  });
  void aboutWin.loadURL(aboutUrl());

  // modal 窗口必须 ready-to-show 再 show，否则父窗会闪一下
  aboutWin.once('ready-to-show', () => {
    readyToShow = true;
    tryShow();
    // 兜底：渲染层要是没能上报高度（脚本异常），也不能让窗口永远不出现
    if (aboutWin && !aboutWin.isVisible() && !showTimer) {
      showTimer = setTimeout(() => {
        if (pendingFitHeight === null) pendingFitHeight = ABOUT_FALLBACK_HEIGHT;
        tryShow();
      }, FIRST_FIT_WAIT_MS);
    }
  });
  aboutWin.on('closed', () => {
    aboutWin = null;
    readyToShow = false;
    pendingFitHeight = null;
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    // 兜底解锁：Electron 原生模态层在关闭时通常会自动恢复父窗，这里再补一刀防异常路径
    releaseParent(main);
  });

  log.info(`[about] 打开关于窗口（${main ? '模态' : '独立'}，高度待内容实测校正）`);
}

/**
 * 渲染层上报内容高度 → 调整窗口尺寸。
 *
 * 由 ipc-router 统一注册的 handler 调用（守住「唯一 ipcMain.handle 注册入口」铁律）。
 *
 * @param senderWebContentsId 发起请求的 webContents.id；**必须**是本关于窗，
 *                            否则主窗口误调也会被当成改窗指令
 * @returns 是否被接受（非关于窗 / 非法高度一律返回 false）
 */
export function fitAboutWindow(senderWebContentsId: number, height: number): boolean {
  const win = aboutWin;
  if (!win || win.isDestroyed()) return false;
  if (win.webContents.id !== senderWebContentsId) return false;
  if (!Number.isFinite(height)) return false;

  const target = Math.min(Math.max(1, Math.round(height)), maxAboutHeight());
  const first = pendingFitHeight === null;
  pendingFitHeight = target;

  const [curW, curH] = win.getContentSize();
  if (target !== curH) {
    // setContentSize 是内容区尺寸（不含标题栏），正好对齐渲染层测到的 body 高度
    win.setContentSize(curW, target);
    recenter();
    log.info(`[about] 高度自适应 ${curH} → ${target}px`);
  }
  if (first) tryShow();
  return true;
}
