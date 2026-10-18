/**
 * 假的外壳（给单测用）。
 *
 * Tauri 在真实运行时把 `window.__TAURI_INTERNALS__.invoke` 注入页面；
 * 单测里拿这个假货顶上，就能验证「我们发出去的 cmd / 请求体 / header 长什么样」——
 * 这正是跨语言契约最容易漂、又最难在浏览器里发现的地方。
 */

export interface ShellCall {
  cmd: string;
  payload: unknown;
  options?: { headers?: Record<string, string> };
}

export interface TauriFake {
  calls: ShellCall[];
}

/** 装上一个假外壳：`handler` 决定每个命令返回什么 */
export function installShell(handler: (call: ShellCall) => unknown): TauriFake {
  const calls: ShellCall[] = [];
  const internals = {
    invoke: (cmd: string, payload?: unknown, options?: { headers?: Record<string, string> }) => {
      const call: ShellCall = options ? { cmd, payload, options } : { cmd, payload };
      calls.push(call);
      return Promise.resolve(handler(call));
    },
  };
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = internals;
  return { calls };
}

export function uninstallShell(): void {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** 取某个命令的最后一次调用的请求体（Uint8Array） */
export function bodyOf(fake: TauriFake, cmd: string): Uint8Array {
  const call = [...fake.calls].reverse().find((item) => item.cmd === cmd);
  if (!call) throw new Error(`没有调用过 ${cmd}`);
  return call.payload as Uint8Array;
}
