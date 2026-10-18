/**
 * 已报销库（IndexedDB 落盘）。
 *
 * 存什么：**票据字段 + 状态 + 原文件字节**。
 * 为什么连字节一起存：库里最有用的两个动作是「这张票我是不是已经报过」和
 * 「上次那张再打一份」—— 前者只要字段，后者必须有原文件。
 * 只存字段的话，第二个动作就得让用户重新找文件，那这个库就白做了。
 *
 * 键用 sha256（内容指纹）而不是文件名：同一个文件改名后换地方放，仍然认得出。
 *
 * ⚠️ 内存纪律：字节以 `Uint8Array` 存进 IDB（结构化克隆，不走 base64）。
 * 列表页只取元数据（`listFields`），**不要**为了渲染列表把所有原文件读进内存 ——
 * 1000 张票就是几百 MB。需要哪个文件再用 `readBytes(sha)` 单独取。
 */

import type { Invoice } from '@invoice-tool/core';

export type LibraryMark = 'printed' | 'reimbursed';

/** 列表用的元数据（不含原文件字节） */
export interface LibraryRecord {
  sha256: string;
  invoice: Invoice;
  mark: LibraryMark;
  /** 最近一次状态变化（ms） */
  at: number;
  /** 首次入库（ms） */
  addedAt: number;
  printedAt?: number;
  reimbursedAt?: number;
  fileName: string;
  fileSize: number;
  visual: 'pdf' | 'image' | 'none';
  /** 有没有存原文件字节（老记录可能没有） */
  hasBytes: boolean;
}

/** 库里真实存储的形状（比元数据多一个 bytes） */
interface StoredRecord extends Omit<LibraryRecord, 'hasBytes'> {
  bytes: Uint8Array;
}

const DB_NAME = 'invoice-tool.library';
const DB_VERSION = 1;
const STORE = 'invoices';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'sha256' });
        store.createIndex('at', 'at');
        store.createIndex('mark', 'mark');
        store.createIndex('invoiceNo', 'invoice.invoiceNo');
        store.createIndex('issueDate', 'invoice.issueDate');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打不开本机数据库'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('数据库操作失败'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

function toMeta(stored: StoredRecord): LibraryRecord {
  const { bytes, ...rest } = stored;
  return { ...rest, hasBytes: (bytes?.byteLength ?? 0) > 0 };
}

/** 元数据 + 字节 → 落盘形状 */
function toStored(meta: Omit<LibraryRecord, 'hasBytes'>, bytes: Uint8Array): StoredRecord {
  return { ...meta, bytes };
}

// ---------------------------------------------------------------- 内存缓存

/**
 * 全量索引（元数据）。库里所有查询都在这一份内存索引上做 ——
 * 否则每次筛选都要把全部记录（含字节）读出来，那正是上面警告的坑。
 */
let index: LibraryRecord[] | undefined;
let loading: Promise<LibraryRecord[]> | undefined;

/** 稳定的空表引用：`useSyncExternalStore` 的 getSnapshot 每次都返回新数组会死循环 */
const EMPTY: LibraryRecord[] = [];

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function libraryVersion(): number {
  return version;
}

/** 加载（或等待正在进行的加载）。失败时返回空表，不抛 —— 隐私模式下 IDB 可能不可用。 */
export async function loadLibrary(): Promise<LibraryRecord[]> {
  if (index) return index;
  loading ??= (async () => {
    try {
      const stored = await tx<StoredRecord[]>('readonly', (store) => {
        const request = store.getAll();
        return request;
      });
      index = stored.map(toMeta).sort((a, b) => b.at - a.at);
    } catch (err) {
      console.warn('[library] 读取本机库失败（可能是隐私模式），按空库处理：', err);
      index = [];
    }
    loading = undefined;
    bump();
    return index;
  })();
  return loading;
}

/** 同步取当前索引（没加载过就先返回空数组；组件应先用 useLibrary 触发加载） */
export function currentLibrary(): LibraryRecord[] {
  return index ?? EMPTY;
}

export function findInLibrary(predicate: (record: LibraryRecord) => boolean): LibraryRecord[] {
  return currentLibrary().filter(predicate);
}

/** 「这张票是不是已经报过」—— 导入时用来提前提醒 */
export function alreadyHandled(invoice: Invoice, sha256: string): LibraryRecord | undefined {
  const list = currentLibrary();
  const bySha = list.find((r) => r.sha256 === sha256);
  if (bySha) return bySha;
  if (invoice.invoiceNo) {
    return list.find((r) => r.invoice.invoiceNo === invoice.invoiceNo);
  }
  return undefined;
}

// ---------------------------------------------------------------- 写入

export interface RememberInput {
  sha256: string;
  invoice: Invoice;
  bytes: Uint8Array;
  fileName: string;
  fileSize: number;
  visual: 'pdf' | 'image' | 'none';
  /**
   * 原始时间戳（可选）。只给「从备份恢复」用：那些记录的时间是**过去**发生的，
   * 用 `now` 会让历史记录看起来都发生在恢复的那一刻。
   */
  addedAt?: number;
  printedAt?: number;
  reimbursedAt?: number;
}

/**
 * 记下（或更新）一批票的状态。
 *
 * 状态**只升不降**（已打印 → 已报销，不回头），与 UI 的 `raise()` 一致。
 */
export async function remember(
  inputs: readonly RememberInput[],
  mark: LibraryMark,
  now = Date.now(),
): Promise<void> {
  if (inputs.length === 0) return;
  const list = await loadLibrary();
  const bySha = new Map(list.map((r) => [r.sha256, r]));

  for (const input of inputs) {
    const existing = bySha.get(input.sha256);
    // 字节只在第一次写；之后再标记不重复占空间
    const bytes = existing ? ((await readBytes(input.sha256)) ?? input.bytes) : input.bytes;

    // 时间戳：库里已有的说了算，其次是调用方给的（从备份恢复时带原始时间），最后才用 now
    const printedAt = existing?.printedAt ?? input.printedAt;
    const reimbursedAt = existing?.reimbursedAt ?? input.reimbursedAt;

    const meta: Omit<LibraryRecord, 'hasBytes'> = {
      sha256: input.sha256,
      invoice: input.invoice,
      // 状态只升不降：已经报销过的不会被「已打印」打回去
      mark: existing?.mark === 'reimbursed' ? 'reimbursed' : mark,
      at: now,
      addedAt: existing?.addedAt ?? input.addedAt ?? now,
      ...(printedAt !== undefined ? { printedAt } : {}),
      ...(reimbursedAt !== undefined ? { reimbursedAt } : {}),
      fileName: input.fileName,
      fileSize: input.fileSize,
      visual: input.visual,
    };
    if (meta.mark === 'reimbursed') meta.reimbursedAt ??= now;
    else meta.printedAt ??= now;

    await tx('readwrite', (store) => store.put(toStored(meta, bytes)));

    const next: LibraryRecord = { ...meta, hasBytes: bytes.byteLength > 0 };
    const at = list.findIndex((r) => r.sha256 === input.sha256);
    if (at >= 0) list[at] = next;
    else list.unshift(next);
    bySha.set(next.sha256, next);
  }

  index = [...list].sort((a, b) => b.at - a.at);
  bump();
}

/** 在库里手动改一张票的状态 */
export async function setMark(shas: readonly string[], mark: LibraryMark, now = Date.now()): Promise<void> {
  const list = await loadLibrary();
  for (const sha of shas) {
    const found = list.find((r) => r.sha256 === sha);
    if (!found) continue;
    const bytes = (await readBytes(sha)) ?? new Uint8Array();
    const meta: Omit<LibraryRecord, 'hasBytes'> = {
      sha256: found.sha256,
      invoice: found.invoice,
      mark,
      at: now,
      addedAt: found.addedAt,
      ...(found.printedAt !== undefined ? { printedAt: found.printedAt } : {}),
      ...(found.reimbursedAt !== undefined ? { reimbursedAt: found.reimbursedAt } : {}),
      fileName: found.fileName,
      fileSize: found.fileSize,
      visual: found.visual,
    };
    if (mark === 'reimbursed') meta.reimbursedAt = now;
    else meta.printedAt = now;

    await tx('readwrite', (store) => store.put(toStored(meta, bytes)));
    const at = list.findIndex((r) => r.sha256 === sha);
    if (at >= 0) list[at] = { ...meta, hasBytes: bytes.byteLength > 0 };
  }
  index = [...list].sort((a, b) => b.at - a.at);
  bump();
}

/** 取原文件字节（只取一个，避免把整个库读进内存） */
export async function readBytes(sha: string): Promise<Uint8Array | undefined> {
  try {
    const stored = await tx<StoredRecord | undefined>('readonly', (store) => store.get(sha));
    const bytes = stored?.bytes;
    if (!bytes) return undefined;
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  } catch {
    return undefined;
  }
}

export async function removeFromLibrary(shas: readonly string[]): Promise<void> {
  for (const sha of shas) await tx('readwrite', (store) => store.delete(sha));
  index = (index ?? []).filter((r) => !shas.includes(r.sha256));
  bump();
}

export async function clearLibrary(): Promise<void> {
  await tx('readwrite', (store) => store.clear());
  index = [];
  bump();
}

export interface LibraryStats {
  count: number;
  reimbursed: number;
  printed: number;
  /** 库里原文件占的体积（字节） */
  bytes: number;
  /** 报销总额（分） */
  total: number;
}

export function statsOf(records: readonly LibraryRecord[]): LibraryStats {
  let reimbursed = 0;
  let printed = 0;
  let bytes = 0;
  let total = 0;
  for (const record of records) {
    if (record.mark === 'reimbursed') reimbursed += 1;
    else printed += 1;
    bytes += record.fileSize;
    if (record.mark === 'reimbursed') total += record.invoice.total ?? 0;
  }
  return { count: records.length, reimbursed, printed, bytes, total };
}
