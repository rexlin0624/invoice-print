/**
 * 渲染 Worker 的收发信封（主线程与 Worker 共用）。
 *
 * 为什么不用 Comlink（参考实现用的是它）：
 * 这里的接口面只有**一个方法**，而 Comlink 会带来一次新依赖安装（这台机器网络不稳）
 * 与一层 Proxy 魔法。四十行显式协议换来的是「能直接读懂的边界」：
 * 请求带 id，响应分成功/失败，失败把错误序列化回来 ——
 * 顺便解决了 `postMessage` 会把 Error 变成 `{}` 的老问题。
 *
 * ⚠️ 大缓冲一律 **transfer**（`postMessage` 第二个参数），不要靠结构化克隆再拷一份：
 * 一页 A4@200dpi 的 RGBA 是 24 MB，克隆一次就是内存峰值翻倍。
 */

import type { RenderRequest, RenderResult } from './types';

export interface RpcRequest {
  id: number;
  args: RenderRequest;
}

export interface SerializedError {
  message: string;
  stack?: string;
}

export type RpcResponse =
  { id: number; ok: true; result: RenderResult } | { id: number; ok: false; error: SerializedError };

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return err.stack ? { message: err.message, stack: err.stack } : { message: err.message };
  }
  return { message: String(err) };
}

export function reviveError(error: SerializedError): Error {
  const revived = new Error(error.message);
  if (error.stack) revived.stack = error.stack;
  return revived;
}

/** 结果里值得 transfer 的缓冲（`bytes` 与 `pixels` 二选一，另一个是 null） */
export function transferablesOf(result: RenderResult): ArrayBuffer[] {
  return [result.bytes, result.pixels].filter((buf): buf is ArrayBuffer => buf !== null);
}
