/**
 * 桌面外壳桥（Tauri v2）。
 *
 * 网页版与桌面版**共用同一份 UI**：网页版用浏览器能力（下载、iframe 打印），
 * 桌面版换成系统能力（保存对话框、系统打印、在访达里显示）。
 * 差异全部收在 `shell.ts` + `save.ts` 两个文件里 —— 页面只调 `saveBytes` / `printPdf`，
 * 不关心自己跑在哪儿。
 *
 * **为什么不用 `@tauri-apps/api`**：我们只用到 IPC 一个入口
 * （`window.__TAURI_INTERNALS__.invoke`），为它往网页版的依赖树里塞一个 SDK 不划算；
 * 而且版本一升，网页版就多一个永远用不到的包要跟着升。
 * 这条 IPC 契约很短，写在 `docs/桌面端参考.md` 里，并用单测钉住（`shell.test.ts`）。
 *
 * 三条容易踩的约定（都是 Tauri v2 官方的，官方 `tauri-plugin-fs` 也这么做）：
 * 1. **发字节**：`invoke(cmd, uint8Array, { headers })` —— 请求体整块是裸字节，
 *    不能混进 JSON 参数，所以文件名走 header。塞进 JSON 会变成数字数组，膨胀 4~5 倍。
 * 2. **收字节**：Rust 返回 `Response`（content-type `application/octet-stream`）时，
 *    前端拿到的是 `ArrayBuffer`；返回 JSON 的则是普通对象。
 * 3. **header 只收可见 ASCII**：中文文件名必须 `encodeURIComponent`，
 *    Rust 侧对应 `percent_decode`。用 `JSON.stringify` 会直接报错（它不转义非 ASCII）。
 */

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
  /** 应用数据目录（库备份、日志都在里面） */
  dataDir: string;
  debug: boolean;
}

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}

export interface WrittenFile {
  path: string;
  name: string;
  size: number;
}

export interface PrintOutcome {
  ok: boolean;
  message: string;
  /** 临时 PDF 的路径：失败时拿它「用系统程序打开」 */
  path: string;
}

export interface StoreEntry {
  name: string;
  size: number;
  modified: number;
}

interface InvokeOptions {
  headers?: Record<string, string>;
}

type Invoke = (cmd: string, payload?: unknown, options?: InvokeOptions) => Promise<unknown>;

interface TauriInternals {
  invoke?: Invoke;
}

/**
 * 外壳在不在。
 *
 * 读 `__TAURI_INTERNALS__` 而不是 `window.__TAURI__`：后者要开 `withGlobalTauri`
 * 才有（那是给不打包的前端用的），前者是 Tauri 注入 IPC 用的，任何构建都在。
 */
export function isDesktop(): boolean {
  return internals() !== undefined;
}

function internals(): TauriInternals | undefined {
  const candidate = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return candidate && typeof candidate.invoke === 'function' ? candidate : undefined;
}

function requireInvoke(): Invoke {
  const found = internals()?.invoke;
  if (!found) throw new Error('不在桌面外壳里：没有 Tauri IPC');
  return found;
}

/** header 值只收可见 ASCII，中文一律百分比编码（Rust 侧 `percent_decode` 解回来） */
export function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value);
}

/** 外壳把 `application/octet-stream` 的响应交给前端时是 `ArrayBuffer` */
export function asBytes(result: unknown, what: string): Uint8Array {
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (ArrayBuffer.isView(result)) {
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  }
  throw new Error(`外壳没有返回字节（${what}）`);
}

// ------------------------------------------------------------------ 6 个能力模块

/** 应用信息：版本 / 平台 / 数据目录 */
export async function appInfo(): Promise<AppInfo> {
  return (await requireInvoke()('app_info')) as AppInfo;
}

/** 原生「选择发票」对话框；取消返回空数组 */
export async function pickDocuments(): Promise<PickedFile[]> {
  return (await requireInvoke()('pick_documents')) as PickedFile[];
}

/** 按路径读原始字节（不经过 webview 的文件对象，大扫描件也不会被复制两份） */
export async function readDocument(path: string): Promise<Uint8Array> {
  return asBytes(await requireInvoke()('read_document', { path }), path);
}

/** 弹保存对话框并写盘；用户取消返回 `null` */
export async function saveDocument(
  bytes: Uint8Array,
  fileName: string,
  filter?: string,
): Promise<WrittenFile | null> {
  const headers: Record<string, string> = { name: encodeHeaderValue(fileName) };
  if (filter) headers.filter = encodeHeaderValue(filter);
  const result = await requireInvoke()('save_document', bytes, { headers });
  return (result ?? null) as WrittenFile | null;
}

/** 交给系统打印（临时文件在应用缓存目录里） */
export async function printDocument(bytes: Uint8Array, fileName: string): Promise<PrintOutcome> {
  const headers = { name: encodeHeaderValue(fileName) };
  return (await requireInvoke()('print_document', bytes, { headers })) as PrintOutcome;
}

/** 在文件管理器里显示（访达会选中它） */
export async function revealPath(path: string): Promise<void> {
  await requireInvoke()('reveal_path', { path });
}

/** 用系统默认程序打开 */
export async function openPath(path: string): Promise<void> {
  await requireInvoke()('open_path', { path });
}

/** 数据目录里的文件清单（日志、库备份） */
export async function storeList(): Promise<StoreEntry[]> {
  return (await requireInvoke()('store_list')) as StoreEntry[];
}

/** 读数据目录里的文件；还没有返回 `undefined`（空字节与「没有」同义，见 Rust 侧说明） */
export async function storeRead(name: string): Promise<Uint8Array | undefined> {
  const result = await requireInvoke()('store_read', { name });
  if (result === null || result === undefined) return undefined;
  const bytes = asBytes(result, name);
  return bytes.byteLength === 0 ? undefined : bytes;
}

/** 写数据目录里的文件（覆盖） */
export async function storeWrite(name: string, bytes: Uint8Array): Promise<number> {
  return (await requireInvoke()('store_write', bytes, {
    headers: { name: encodeHeaderValue(name) },
  })) as number;
}

/** 追加写（日志用）；Rust 侧超过 2 MB 会轮转成 `.1` */
export async function storeAppend(name: string, text: string): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  return (await requireInvoke()('store_append', bytes, {
    headers: { name: encodeHeaderValue(name) },
  })) as number;
}

/** 删数据目录里的文件 */
export async function storeRemove(name: string): Promise<void> {
  await requireInvoke()('store_remove', { name });
}

// ------------------------------------------------------------------ 日志

/** 本地日志的文件名（在数据目录里） */
export const LOG_NAME = 'logs/app.log';

/** 日志单行上限：一条日志不该比这个更长（异常消息可能带着整段 HTML） */
const MAX_LOG_CHARS = 4000;

/**
 * 控制字符替换成空格。
 *
 * 日志是**行式**的：文件名 / 错误消息里只要有一个 `\n`，就能伪造一条看起来
 * 像应用自己写下的记录（例如把「xxx 失败」改成「backup restored: 99 条」）。
 * 顺便挡掉 `\r`、NUL 与 ESC，免得在终端里看出花来。
 */
function logSafe(text: string): string {
  return text.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_LOG_CHARS);
}

/**
 * 往本地日志里记一行（**只有桌面版会写**，网页版是空操作）。
 *
 * 刻意是「发了就不管」：日志写不进去不该影响用户正在做的事。
 * 出问题时这份文件就是唯一的事后线索 —— 首页「帮助」里有「打开数据目录」。
 */
export function logLine(text: string): void {
  if (!isDesktop()) return;
  const stamp = new Date().toISOString();
  void storeAppend(LOG_NAME, `${stamp} ${logSafe(text)}`).catch(() => undefined);
}
