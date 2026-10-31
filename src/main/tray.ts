import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { IPC_EVENT } from '@shared/constants/channels';
import { dataService } from './services/dataService';
import { strategyService } from './services/strategyService';
import { openAboutWindow } from './about';

let tray: Tray | null = null;
/** 用户显式点「退出」时为 true：此时关闭主窗口要真的退出，而不是退回托盘 */
let quitting = false;

/** 托盘图标兜底：连 base64 都不要发生时也能亮（32×32 透明底橙色折线图标） */
const TRAY_FALLBACK =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAUFJREFUWEftl79Kw1AUxr9zk7RJWyQi7aJFSyGLiIVFAStFRErBQ0FRwUKxUKFsFAwruoFCwUFK0FBxUKFsFAy7BSxQUsFDBQUHFQrFBSwUMFBQUHFQoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLCwUFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLCwUFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLCwUFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLCwUFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLCwUFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLCwUFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUFLBQ0FBxUKFsFAvrNBxwUKFBSwUMFBQUHFwoUD//wMAAAAASUVORK5CYII=';

function trayIconPath(): string {
  // 1) 环境变量（调试深链） 2) 打包态 resources/icon  3) 开发态项目根 assets/icon
  const candidates = [
    process.env.QUANTPILOT_TRAY_ICON,
    app.isPackaged
      ? path.join(process.resourcesPath, 'icon', 'tray.png')
      : path.join(process.cwd(), 'assets', 'icon', 'tray.png'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  log.warn('[tray] 未找到图标文件，回退内置图标');
  return TRAY_FALLBACK;
}

function currentWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  return (wins.find((w) => !w.isDestroyed()) ?? null) as BrowserWindow | null;
}

/** 主进程（托盘/菜单）→ 渲染进程路由跳转 */
function navigate(win: BrowserWindow | null, route: string): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC_EVENT.APP_NAVIGATE, { path: route });
}

function showWindow(): void {
  const win = currentWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideWindow(): void {
  currentWindow()?.hide();
}

/** 托盘是否还活着：决定「最后一个窗口关闭」要不要跟着退出进程 */
export function trayActive(): boolean {
  return !!tray && !tray.isDestroyed();
}

/** 主进程动作统一入口：先还原 + 回仪表盘，再执行（托盘/菜单里点哪个都回到主界面） */
export function revealWindow(win: BrowserWindow | null, route = '/'): void {
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT.APP_NAVIGATE, { path: route });
}

export function toggleWindow(): void {
  const win = currentWindow();
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

export function quitApp(): void {
  quitting = true;
  void app.quit();
}

/** 关闭主窗口时：默认退回托盘；只有「退出」才真退 */
export function onWindowClose(e: Electron.Event): void {
  if (quitting) return;
  e.preventDefault();
  hideWindow();
  log.info('[tray] 主窗口已退回系统托盘（托盘菜单可还原）');
}

export function sendNavigate(route: string): void {
  navigate(currentWindow(), route);
}

export function initTray(getWindow: () => BrowserWindow | null): void {
  if (tray && !tray.isDestroyed()) return;
  const iconPath = trayIconPath();
  const icon = iconPath.startsWith('data:')
    ? nativeImage.createFromDataURL(iconPath)
    : nativeImage.createFromPath(iconPath);

  tray = new Tray(icon);
  tray.setToolTip('QuantPilot');
  tray.setContextMenu(buildMenu(getWindow));
  tray.on('click', toggleWindow);

  log.info(`[tray] 已创建（图标=${iconPath.slice(0, 60)}）`);
}

function buildMenu(
  getWindow: () => BrowserWindow | null,
): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: '显示 QuantPilot',
      click: () => {
        showWindow();
        navigate(getWindow(), '/');
      },
    },
    { type: 'separator' },
    {
      label: '增量更新数据',
      click: () => {
        showWindow();
        if (dataService.isPulling()) {
          // 锁被占时给可见反馈，否则连点了像"没反应"
          tray?.setToolTip('QuantPilot · 正在拉取数据…');
          log.info('[tray] 已有拉取任务在跑，本次点击忽略');
          return;
        }
        void dataService.pullHistory({ force: false });
      },
    },
    {
      label: '全量回填',
      click: () => {
        showWindow();
        if (dataService.isPulling()) {
          tray?.setToolTip('QuantPilot · 正在拉取数据…');
          log.info('[tray] 已有拉取任务在跑，本次点击忽略');
          return;
        }
        void dataService.pullHistory({ force: true });
      },
    },
    {
      label: '重新选股',
      click: () => {
        showWindow();
        navigate(getWindow(), '/');
        if (strategyService.isScreening()) {
          tray?.setToolTip('QuantPilot · 正在选股…');
          log.info('[tray] 已有选股任务在跑，本次点击忽略');
          return;
        }
        void strategyService.runScreener({});
      },
    },
    { type: 'separator' },
    { label: '打开 仪表盘', click: () => { showWindow(); navigate(getWindow(), '/'); } },
    { label: '打开 A股行情', click: () => { showWindow(); navigate(getWindow(), '/market'); } },
    { label: '打开 策略配置', click: () => { showWindow(); navigate(getWindow(), '/strategy'); } },
    { label: '打开 回测面板', click: () => { showWindow(); navigate(getWindow(), '/backtest'); } },
    { label: '打开 设置', click: () => { showWindow(); navigate(getWindow(), '/settings'); } },
    { type: 'separator' },
    {
      label: '关于 QuantPilot',
      click: () => {
        // 必须先还原主窗（模态窗口需要可见的 parent），再开模态关于窗
        showWindow();
        openAboutWindow(currentWindow());
      },
    },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]);
}
