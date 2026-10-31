/**
 * 板块/行业服务（M2）。
 *
 * 数据源：新浪行业板块（`money.finance.sina.com.cn/q/view/newSinaHy.php` + 板块成分节点）。
 * 已在实现前实测（2026-10-06）：49 个行业板块，每行含涨跌幅/成交额/领涨股；
 * 成分股接口 `Market_Center.getHQNodeData?node=<板块id>` 与现有 universe 同结构。
 *
 * 设计取舍：
 *  - 板块列表**落库**（sectors 表），成分股**单独落库**（sector_members），
 *    这样板块页离线可看、且能给评分 sector 因子提供「个股所属行业当日涨幅」的真值。
 *  - 拉取是**全量的低频操作**（板块列表一次 + 逐板块成分），故刷新走显式按钮，
 *    不塞进启动流程；成分拉取默认只拉「库内已有的票」会漏掉库外票，故 withMembers=true 全拉。
 */
import log from 'electron-log';
import { dataService } from './dataService';
import { getProvider } from './providers/registry';
import type { SectorDetail, SectorMemberRow, SectorRow } from '@shared/types/ipc';

let refreshing: Promise<{ ok: boolean; sectors: number; members: number; error?: string | null }> | null =
  null;

export const sectorService = {
  /**
   * 拉取板块列表（+可选成分）并落库。
   * withMembers 默认 true：板块详情要展示成分股，且能给 sector 因子提供映射。
   * 并发锁：避免连点「刷新」重复打新浪。
   */
  async refresh(opts: { withMembers?: boolean } = {}): Promise<{
    ok: boolean; sectors: number; members: number; error?: string | null;
  }> {
    if (refreshing) {
      log.warn('[sectorService] 已有板块刷新在进行中，本次点击复用它');
      return refreshing;
    }
    const withMembers = opts.withMembers ?? true;
    refreshing = (async () => {
      const sina = getProvider('sina');
      if (!sina) return { ok: false, sectors: 0, members: 0, error: '新浪源未注册' };
      const res = await sina.getSectors();
      if (!res.ok) {
        log.warn('[sectorService] 板块列表拉取失败:', res.failure.message);
        return { ok: false, sectors: 0, members: 0, error: res.failure.message };
      }
      const sectors = res.value;
      dataService.replaceSectors(sectors);
      log.info(`[sectorService] 板块列表已落库 ${sectors.length} 个`);

      let memberTotal = 0;
      if (withMembers) {
        // 逐板块拉成分（串行，49 个板块，别把新浪打爆）
        for (const s of sectors) {
          const m = await sina.getSectorMembers(s.id).catch(() => null);
          if (m && m.ok) memberTotal += dataService.replaceSectorMembers(s.id, m.value);
        }
        log.info(`[sectorService] 板块成分已落库 ${memberTotal} 条`);
      }
      return { ok: true, sectors: sectors.length, members: memberTotal };
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  },

  /** 板块列表（按涨幅/成交额降序）；库内为空时返回空数组（UI 提示先刷新） */
  list(sort: 'changePct' | 'amount' = 'changePct'): SectorRow[] {
    return dataService.listSectors(sort);
  },

  /** 板块详情：板块行 + 成分股（叠加库内最新行情） */
  detail(id: string): SectorDetail | null {
    const row = dataService.listSectors('changePct').find((s) => s.id === id);
    if (!row) return null;
    const members = dataService.listSectorMembers(id).map((m) => ({
      ...m,
      hit: null, // 信号命中断言由渲染层用当前选股结果联查
    })) as SectorMemberRow[];
    return { ...row, members };
  },
};

/** 供 sentiment/评分未来取「个股所属行业当日涨幅」用（当前 UI 未直接暴露，保留给 M1 sector 因子） */
export function sectorOfStock(code: string): string | null {
  return dataService.sectorIdOfStock(code);
}
