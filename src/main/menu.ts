import { app, Menu, shell, BrowserWindow } from 'electron';
import log from 'electron-log';
import { dataService } from './services/dataService';
import { strategyService } from './services/strategyService';
import { openAboutWindow } from './about';
import { toggleWindow, revealWindow, quitApp } from './tray';

const isMac = process.platform === 'darwin';

/** 统一口径：主进程触发的业务动作 = 先还原窗口 + 切到对应页，再干活（run 可省略） */
function revealThen(win: BrowserWindow | null, route: string, run?: () => void): void {
  revealWindow(win, route);
  run?.();
}

export function initMenu(getWindow: () => BrowserWindow | null): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '增量更新数据',
          accelerator: 'Ctrl+Shift+U',
          click: () => revealThen(getWindow(), '/', () => void dataService.pullHistory({ force: false })),
        },
        {
          label: '全量回填…（清空重建）',
          click: () => revealThen(getWindow(), '/', () => void dataService.pullHistory({ force: true })),
        },
        { type: 'separator' },
        {
          label: '重新选股',
          accelerator: 'Ctrl+Alt+S',
          click: () => revealThen(getWindow(), '/', () => void strategyService.runScreener({})),
        },
        { type: 'separator' },
        {
          // 不能用 role:'quit'：它绕过了 quitting 标记，会被「关窗退回托盘」拦住退不掉
          label: '退出',
          accelerator: isMac ? 'Command+Q' : 'Ctrl+Q',
          click: quitApp,
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '选股仪表盘', click: () => revealThen(getWindow(), '/') },
        { label: 'A股行情', click: () => revealThen(getWindow(), '/market') },
        { label: '策略配置', click: () => revealThen(getWindow(), '/strategy') },
        { label: '回测面板', click: () => revealThen(getWindow(), '/backtest') },
        { label: '设置', click: () => revealThen(getWindow(), '/settings') },
        { type: 'separator' },
        { label: '显示 / 隐藏主窗口', click: toggleWindow },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 QuantPilot',
          accelerator: 'F1',
          click: () => {
            revealWindow(getWindow(), '/');
            // 传主窗 → 关于窗以模态形式挂在主窗上（父窗关闭前不可交互）
            openAboutWindow(getWindow());
          },
        },
        { type: 'separator' },
        {
          label: '打开本地数据目录',
          click: () => void shell.openPath(app.getPath('userData')),
        },
      ],
    },
  ];

  if (isMac) {
    template.unshift({
      label: app.getName(),
      submenu: [
        { label: '关于 QuantPilot', accelerator: 'Command+Shift+I', click: () => { revealWindow(getWindow(), '/'); openAboutWindow(getWindow()); } },
        { type: 'separator' },
        { label: '服务', role: 'services' },
        { type: 'separator' },
        { label: '隐藏 QuantPilot', role: 'hide' },
        { type: 'separator' },
        { label: '退出 QuantPilot', accelerator: 'Command+Q', click: quitApp },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  log.info('[menu] 应用菜单已注入（文件/视图/帮助·关于）');
}
