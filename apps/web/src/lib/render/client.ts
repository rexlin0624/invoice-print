/**
 * 渲染客户端：应用代码只认这一层，不直接碰 Worker。
 *
 * 对外只有 `renderPage()` 一个入口。它负责三件事：
 * 1. **拷贝字节**：pdfjs 会把 buffer 转移走（见 `pdfjsSafe.ts`），
 *    而调用方手里那份原始字节还要留着（解析、导出、再渲染都要用）。
 *    拷贝统一在这里做，引擎两步都不必再想这件事。
 * 2. **选宿主**：默认 Worker；不支持（老浏览器没有 `OffscreenCanvas`）或
 *   Worker 起不来时退到主线程。两条路是**同一份实现**（`engine.ts`）。
 * 3. **取消/回收**：空闲 60 秒把 Worker 关掉，别让它一直占着几十 MB。
 *
 * 想强制走某条路（调试 / e2e 对比两条路的结果）：
 * `globalThis.__invoiceRenderEngine = 'worker' | 'main'`。
 */

import { safeBytes } from '../pdfjsSafe';
import { render as renderHere } from './engine';
import { reviveError, serializeError, type RpcRequest, type RpcResponse } from './rpc';
import type { RenderRequest, RenderResult } from './types';

export type RenderEngine = 'worker' | 'main';

/** 空闲多久关掉 Worker。对齐 `ocr.ts` 的 60 秒：内存比启动时间贵。 */
const IDLE_TERMINATE_MS = 60_000;

interface Pending {
  resolve: (result: RenderResult) => void;
  reject: (error: Error) => void;
}

let worker: Worker | undefined;
/** Worker 基础设施坏掉了（起不来 / 首次请求就失败）→ 之后一律走主线程 */
let workerBroken = false;
let workerEverAnswered = false;
let announced = false;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, Pending>();

/** 这台机器的浏览器能不能把渲染放进 Worker：`OffscreenCanvas` 是硬门槛（Safari 16.4+） */
function supportsWorkerRender(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  );
}

/** 强制指定宿主（调试 / e2e 用） */
function forced(): RenderEngine | undefined {
  const value = (globalThis as { __invoiceRenderEngine?: string }).__invoiceRenderEngine;
  return value === 'worker' || value === 'main' ? value : undefined;
}

/** 当前实际会用的宿主（不启动 Worker，纯判断） */
export function renderEngineInUse(): RenderEngine {
  const force = forced();
  if (force) return force;
  if (workerBroken || !supportsWorkerRender()) return 'main';
  return 'worker';
}

function announce(engine: RenderEngine, reason?: string): void {
  if (announced) return;
  announced = true;
  console.info(
    reason
      ? `[渲染] 走${engine === 'worker' ? ' Worker' : '主线程'}：${reason}`
      : `[渲染] 走${engine === 'worker' ? ' Worker（标签页不可见也能画完）' : '主线程（老浏览器兜底）'}`,
  );
}

function failAll(reason: string): void {
  const error = new Error(reason);
  for (const [, entry] of pending) entry.reject(error);
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const spawned = new Worker(new URL('../render.worker.ts', import.meta.url), {
    type: 'module',
    name: 'invoice-render',
  });

  spawned.addEventListener('message', (event: MessageEvent<RpcResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(reviveError(response.error));
    touchIdle();
  });

  // Worker 脚本本身出问题（CSP 拦了、加载失败）：整条路作废，退主线程
  spawned.addEventListener('error', () => {
    workerBroken = true;
    worker = undefined;
    failAll('渲染 Worker 启动失败，已退回主线程');
  });

  worker = spawned;
  return spawned;
}

function touchIdle(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (pending.size > 0) return;
    void releaseRenderWorker();
  }, IDLE_TERMINATE_MS);
}

/** 主动关掉渲染 Worker（换页/关闭后台时用，也给空闲计时器用） */
export async function releaseRenderWorker(): Promise<void> {
  const dying = worker;
  worker = undefined;
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (dying) {
    failAll('渲染 Worker 已关闭');
    dying.terminate();
  }
}

function callWorker(request: RenderRequest): Promise<RenderResult> {
  const target = ensureWorker();
  const id = nextId++;
  const promise = new Promise<RenderResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  // 大缓冲 transfer 过去，别让结构化克隆再拷一份
  const message: RpcRequest = { id, args: request };
  target.postMessage(message, [request.bytes]);
  touchIdle();
  return promise;
}

/**
 * 渲染一页。
 *
 * `args.bytes` 不用传（这个函数会拿 `data` 自己拷一份）。
 * 失败一律抛异常：调用方按老规矩 `catch` 成 `undefined`，别让一张坏票毁掉整批。
 */
export async function renderPage(
  data: Uint8Array,
  args: Omit<RenderRequest, 'bytes'>,
): Promise<RenderResult> {
  // 每次尝试都重新拷：万一 Worker 那条路把 buffer 转移走了又失败，重试还要用原件
  const request = (): RenderRequest => ({
    ...args,
    bytes: safeBytes(data).buffer,
  });

  if (renderEngineInUse() === 'main') {
    announce('main', forced() === 'main' ? '被 __invoiceRenderEngine 强制' : undefined);
    return renderHere(request());
  }

  announce('worker');
  try {
    const result = await callWorker(request());
    workerEverAnswered = true;
    return result;
  } catch (err) {
    // 「从没成功过」说明是 Worker 这条路本身坏了，不是这张票坏了 → 退主线程重试
    if (workerBroken || !workerEverAnswered) {
      workerBroken = true;
      worker?.terminate();
      worker = undefined;
      console.warn('[渲染] Worker 这条路不可用，退回主线程：', serializeError(err).message);
      return renderHere(request());
    }
    throw err;
  }
}

/** 结果里的图片字节（`encode` 有值时） */
export function resultBytes(result: RenderResult): Uint8Array<ArrayBuffer> {
  if (!result.bytes) throw new Error('这个渲染结果没有图片字节');
  return new Uint8Array(result.bytes);
}

/** 结果里的 RGBA 像素（`encode` 为空时） */
export function resultPixels(result: RenderResult): ImageData {
  if (!result.pixels) throw new Error('这个渲染结果没有像素');
  return new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height);
}

/**
 * 结果图片 → dataURL。
 *
 * 缩略图沿用 dataURL 契约（`Preview.tsx` 只认 `src` 字符串），
 * 这样调用方不必管 blob URL 的生命周期 —— 少一类内存泄漏。
 * 编码（jpeg）已经在 Worker 里做完，这里只是把字节转成 base64，很轻。
 */
export async function resultDataUrl(result: RenderResult): Promise<string | undefined> {
  if (!result.bytes) return undefined;
  const blob = new Blob([result.bytes], { type: result.mime ?? 'image/jpeg' });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('渲染结果读不出来'));
    reader.readAsDataURL(blob);
  });
}
