import { ipcMain, type IpcMainInvokeEvent, BrowserWindow, app, dialog } from 'electron';
import path from 'node:path';
import log from 'electron-log';
import type { IpcRequestMap, IpcResponseMap, IpcChannel } from '@shared/types/ipc';
import { dataService, detectPython } from '../services/dataService';
import { strategyService } from '../services/strategyService';
import { schedulerService } from '../services/schedulerService';
import { sectorService } from '../services/sectorService';
import { getAppInfo } from '../appInfo';
import { fitAboutWindow } from '../about';
import { IPC } from '@shared/constants/channels';

type Handler<C extends IpcChannel> = (
  event: IpcMainInvokeEvent,
  req: IpcRequestMap[C],
) => IpcResponseMap[C] | Promise<IpcResponseMap[C]>;

// 唯一注册入口：所有 handler 集中于此，禁止在别处直接使用 ipcMain.on/handle
const handlers: { [C in IpcChannel]: Handler<C> } = {
  // 拉完数据后选股缓存必须作废：新 K 线进来了，指纹里的 barTo/barCount 变了（双保险：显式失效）
  'data:pullHistory': async (_e, req) => {
    const r = await dataService.pullHistory(req);
    strategyService.invalidateScreenCache('data:pullHistory');
    return r;
  },
  'data:status': () => dataService.getStatus(),
  'data:detectPython': () => detectPython(),
  'data:dataHealth': () => dataService.getHealth(),
  'market:list': () => dataService.getMarketList(),
  'limitup:pool': (_e, req) => strategyService.getLimitUpPool(req),
  'sentiment:get': (_e, req) => strategyService.getSentiment(req),
  'strategy:list': () => strategyService.listStrategies(),
  'strategy:configGet': () => strategyService.getConfig(),
  // 改过策略配置/预设 → 选股输入变了，缓存指纹会变；这里顺手显式失效，双保险（保险项 2 是防「改了参数但指纹没变」）
  'strategy:configSave': (_e, req) => {
    const r = strategyService.saveConfig(req);
    strategyService.invalidateScreenCache('strategy:configSave');
    return r;
  },
  'strategy:applyPreset': (_e, req) => {
    const r = strategyService.applyPreset(req);
    strategyService.invalidateScreenCache('strategy:applyPreset');
    return r;
  },
  'strategy:listPresets': () => strategyService.listPresets(),
  'screener:run': (_e, req) => strategyService.runScreener(req),
  'backtest:run': (_e, req) => strategyService.runBacktest(req),
  // M5：导出最近一次回测为 Excel。主进程弹保存框（路径由用户选），写盘后回路径。
  [IPC.BACKTEST_EXPORT_EXCEL]: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const suggested = `QuantPilot-回测报告-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const res = win
      ? await dialog.showSaveDialog(win, {
          title: '导出回测报告（Excel）',
          defaultPath: path.join(app.getPath('documents'), suggested),
          filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
        })
      : await dialog.showSaveDialog({ title: '导出回测报告（Excel）', defaultPath: suggested });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true, path: null };
    const r = strategyService.exportBacktestXlsx(res.filePath);
    return { ...r, path: r.ok ? res.filePath : null };
  },
  'stock:detail': (_e, req) => strategyService.getStockDetail(req),
  'scheduler:get': () => schedulerService.getConfig(),
  'scheduler:set': (_e, req) => schedulerService.setConfig(req.config),
  'app:info': () => getAppInfo(),
  // 关于窗把「内容实测高度」报上来，主进程据此把窗口调到刚好放下（去滚动条的正解）。
  // 只认关于窗的 sender，主窗口误调一律忽略（内部已校验 webContents.id）。
  [IPC.FIT_WINDOW]: (e, req) => {
    fitAboutWindow(e.sender.id, req.height);
  },
  [IPC.SOURCE_CONFIG]: () => dataService.getSourceConfig(),
  // 换数据源/引擎＝换口径（历史 K 线可能整体改写），旧选股结果一定不可信，直接作废
  [IPC.SET_SOURCE_PREFERENCE]: async (_e, req) => {
    const r = await dataService.setSourcePreference(req.cap, req.provider);
    if (r.ok) strategyService.invalidateScreenCache('setSourcePreference');
    return r;
  },
  [IPC.SET_PULL_ENGINE]: async (_e, req) => {
    const r = await dataService.setEngine(req.engine);
    if (r.ok) strategyService.invalidateScreenCache('setPullEngine');
    return r;
  },
  // ---- 自选股（M4）----
  [IPC.WATCH_LIST]: () => dataService.listWatchlist(),
  // 改自选 = 改「仅扫自选池」的输入（指纹含自选 code 摘要）→ 显式作废，双保险
  [IPC.WATCH_UPSERT]: (_e, req) => {
    const r = dataService.upsertWatch(req);
    if (r.ok) strategyService.invalidateScreenCache('watch:upsert');
    return r;
  },
  [IPC.WATCH_REMOVE]: (_e, req) => {
    const r = dataService.removeWatch(req.code);
    strategyService.invalidateScreenCache('watch:remove');
    return r;
  },
  [IPC.WATCH_HAS]: (_e, req) => ({ has: dataService.hasWatch(req.code) }),
  // ---- 板块/行业（M2）----
  [IPC.SECTOR_REFRESH]: (_e, req) => sectorService.refresh({ withMembers: req.withMembers ?? true }),
  [IPC.SECTOR_LIST]: (_e, req) => sectorService.list(req.sort ?? 'changePct'),
  [IPC.SECTOR_DETAIL]: (_e, req) => sectorService.detail(req.id),
  // M5 多策略横向对比 / 参数敏感度
  [IPC.BACKTEST_COMPARE]: (_e, req) => strategyService.compareStrategies(req),
  [IPC.BACKTEST_SENSITIVITY]: (_e, req) => strategyService.scanSensitivity(req),
};

export function registerIpcHandlers(): void {
  (Object.keys(handlers) as IpcChannel[]).forEach((channel) => {
    ipcMain.handle(channel, async (event, req) => {
      try {
        return await (handlers[channel] as Handler<IpcChannel>)(event, req as never);
      } catch (err) {
        // 统一错误出口：渲染进程拿不到原因时会「点了没反应」，必须先让主进程留下痕迹
        log.error(`[ipc:${channel}] handler 执行失败`, err);
        throw err;
      }
    });
  });
}
