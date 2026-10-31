import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc-router';
import { dataService } from './services/dataService';
import { schedulerService } from './services/schedulerService';
import { initMenu } from './menu';
import { initTray, onWindowClose, trayActive } from './tray';
import { getAppInfo } from './appInfo';
import log from 'electron-log';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1050,
    minWidth: 1280,
    minHeight: 800,
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // main.js 位于 dist-electron/：dev=项目根/dist-electron，打包=app.asar/dist-electron
    // ../dist 两种场景都正确指向 renderer 产物目录
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 点叉号默认退回托盘，而不是退出进程；只有托盘菜单「退出」才真退（quitting 标记）
  mainWindow.on('close', (e) => onWindowClose(e));
  mainWindow.on('closed', () => (mainWindow = null));
}

// 单实例锁：杜绝「托盘里一份 + 再点一次 exe 又起一份」导致两组抓取打架
if (!app.requestSingleInstanceLock()) {
  log.warn('[main] 已有实例在运行，本次退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    dataService.init();
    // 首次启动若无数据则拉取（baostock 或 mock 兜底），异步进行不阻塞窗口
    const st = dataService.getStatus();
    if (st.barCount === 0) {
      log.info('[main] 首次启动，开始拉取历史数据...');
      void dataService.pullHistory({ force: false });
    }
    registerIpcHandlers();
    schedulerService.start();
    createWindow();
    // 菜单/托盘都要操作主窗口，必须先建窗再注入
    initMenu(() => mainWindow);
    initTray(() => mainWindow);
    const info = getAppInfo();
    log.info(`[main] 启动完成 · ${info.name} ${info.version} · 版权所有 ${info.copyright}`);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 托盘还在 = 主窗只是被隐藏，进程不能跟着退
    if (process.platform !== 'darwin' && !trayActive()) app.quit();
  });
}
