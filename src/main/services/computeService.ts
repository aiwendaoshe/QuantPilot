// 计算调度服务：把重计算（选股/回测）放进 Worker 线程，避免阻塞主进程与渲染进程。
// 设计原则：Worker 不可用/超时/出错时一律回退主进程同步计算（返回 null，由调用方兜底），
// 保证任何环境下功能不因 Worker 失联而不可用。
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import type { WorkerPayload, WorkerRequest, WorkerResponse } from '../workers/protocol';

// main.js 位于 dist-electron/，worker 由 tsc(rootDir=.) 产出在同级的 src/main/workers/ 下
const WORKER_PATH = path.join(__dirname, 'src', 'main', 'workers', 'strategyWorker.js');
// 选股池放开到全市场（约 5400 只 × 320 根 ≈ 173 万根）后，
// 一次全市场选股常态就是分钟级，120s 会把正常计算误杀成「回退主进程」（反而更慢）。
const TIMEOUT_MS = Number(process.env.QUANTPILOT_WORKER_TIMEOUT_MS ?? 600_000);

let seq = 0;

function resolveWorkerPath(): string | null {
  if (process.env.QUANTPILOT_NO_WORKER === '1') return null;
  try {
    return existsSync(WORKER_PATH) ? WORKER_PATH : null;
  } catch {
    return null;
  }
}

function call(req: WorkerPayload): Promise<WorkerResponse | null> {
  const wp = resolveWorkerPath();
  if (!wp) return Promise.resolve(null);

  const id = ++seq;
  return new Promise<WorkerResponse | null>((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(wp);
    } catch (e) {
      log.warn('[compute] Worker 创建失败，回退主进程:', e);
      resolve(null);
      return;
    }

    const finish = (v: WorkerResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(v);
    };

    const timer = setTimeout(() => {
      log.warn(`[compute] Worker 超时(${Math.round(TIMEOUT_MS / 1000)}s)，终止并回退主进程`);
      finish(null);
    }, TIMEOUT_MS);

    worker.on('message', (res: WorkerResponse) => {
      if (res.id !== id) return; // 非本次请求（理论上不会发生）
      if (res.ok) finish(res);
      else {
        log.warn('[compute] Worker 计算失败，回退主进程:', res.error);
        finish(null);
      }
    });
    worker.on('error', (e) => {
      log.warn('[compute] Worker 异常，回退主进程:', e);
      finish(null);
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        log.warn(`[compute] Worker 异常退出(code=${code})，回退主进程`);
        finish(null);
      }
    });

    worker.postMessage({ ...req, id } as WorkerRequest);
  });
}

export const computeService = { call };
