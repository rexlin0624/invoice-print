/**
 * 本机库的**清单备份**：每次库变动，把「谁报过、报了多少、什么时候」写一份到应用数据目录。
 *
 * 为什么只备份清单、不备份原文件：
 * - 原文件动辄几百 MB，每次变动重写一遍不现实；
 * - 真正**丢了找不回来**的是「这张票我报过了」这个事实 —— 原文件用户手上还有。
 *
 * 为什么需要它：桌面版的库在 webview 里（IndexedDB），用户清一次浏览数据就没了；
 * 备份文件在数据目录（帮助里能打开），不受影响。
 * 库页会自己发现「备份里有、库里没有」，那时才给一个「从备份恢复」（有情况才出现）。
 *
 * 注意：清空本机库**不会**删掉备份 —— 备份就是保险，不该被一次误操作带走。
 * 真想删，去数据目录删文件（帮助 → 打开数据目录）。
 */

import type { Invoice, Issue } from '@invoice-tool/core';
import { INVOICE_KIND_LABEL, MAX_AMOUNT_CENTS, MAX_INVOICE_PAGES } from '@invoice-tool/core';

import type { LibraryMark, LibraryRecord, RememberInput } from './library';
import { currentLibrary, remember } from './library';
import { isDesktop, logLine, storeRead, storeWrite } from './shell';

export const BACKUP_NAME = 'library-backup.json';
const BACKUP_VERSION = 1;
/**
 * 备份里最多认多少条记录。
 *
 * 备份文件是可被同机其他进程改的：一个 20 MB 的 JSON 塞几十万条记录，恢复时会一条条
 * 写回 IndexedDB。上限给得很宽松（正常用户远到不了），只挡「明显不是我们写的」文件。
 */
const MAX_BACKUP_RECORDS = 200_000;

export interface BackupRecord {
  sha256: string;
  mark: LibraryMark;
  at: number;
  addedAt: number;
  printedAt?: number;
  reimbursedAt?: number;
  fileName: string;
  fileSize: number;
  invoice: Invoice;
}

export interface Backup {
  version: number;
  /** 备份时间（ms） */
  at: number;
  records: BackupRecord[];
}

function recordOf(record: LibraryRecord): BackupRecord {
  return {
    sha256: record.sha256,
    mark: record.mark,
    at: record.at,
    addedAt: record.addedAt,
    fileName: record.fileName,
    fileSize: record.fileSize,
    invoice: record.invoice,
    ...(record.printedAt !== undefined ? { printedAt: record.printedAt } : {}),
    ...(record.reimbursedAt !== undefined ? { reimbursedAt: record.reimbursedAt } : {}),
  };
}

export function backupJson(records: readonly LibraryRecord[], at = Date.now()): string {
  const backup: Backup = { version: BACKUP_VERSION, at, records: records.map(recordOf) };
  return JSON.stringify(backup);
}

/** 备份文件是**数据**不是代码：坏了就当没有，绝不抛。 */
export function parseBackup(text: string): Backup | undefined {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; at?: unknown; records?: unknown };
    if (!parsed || !Array.isArray(parsed.records)) return undefined;
    if (parsed.records.length > MAX_BACKUP_RECORDS) return undefined;
    const records = parsed.records.filter(isBackupRecord);
    if (records.length === 0) return undefined;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : BACKUP_VERSION,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      records,
    };
  } catch {
    return undefined;
  }
}

function isBackupRecord(value: unknown): value is BackupRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<BackupRecord>;
  return (
    typeof record.sha256 === 'string' &&
    /^[0-9a-fA-F]{1,128}$/.test(record.sha256) &&
    (record.mark === 'printed' || record.mark === 'reimbursed') &&
    typeof record.fileName === 'string' &&
    record.fileName.length <= 1024 &&
    isFiniteNonNegative(record.fileSize) &&
    isTimestamp(record.at) &&
    isTimestamp(record.addedAt) &&
    (record.printedAt === undefined || isTimestamp(record.printedAt)) &&
    (record.reimbursedAt === undefined || isTimestamp(record.reimbursedAt)) &&
    isInvoice(record.invoice)
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 出处表只用来显示「来自哪儿」：浅校验即可，但不许是数组/超大对象 */
function isProvenance(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.keys(value).length <= 64;
}

/** 时间戳：毫秒，且不能是 1970 以前或几百年以后 */
function isTimestamp(value: unknown): value is number {
  return isFiniteNonNegative(value) && value <= 4_102_444_800_000; // 2100-01-01
}

const INVOICE_KINDS = new Set<string>(Object.keys(INVOICE_KIND_LABEL));
const ISSUE_LEVELS = new Set(['info', 'warn', 'error']);

function optionalString(value: unknown, maxLength = 1024): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function optionalCents(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_AMOUNT_CENTS
  );
}

/**
 * 备份里的 `invoice` 也要按完整形状校验。
 *
 * 备份文件在应用数据目录里，恶意软件/同机其他用户能改；恢复后这些字段会进
 * 列表、去重、打印与报销统计。只检查「是个对象」等于把一份任意 JSON 当发票用。
 */
function isInvoice(value: unknown): value is Invoice {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Partial<Invoice>;

  if (typeof inv.id !== 'string' || inv.id.length === 0 || inv.id.length > 256) return false;
  if (typeof inv.fileName !== 'string' || inv.fileName.length > 1024) return false;
  if (!isFiniteNonNegative(inv.fileSize)) return false;
  if (typeof inv.sha256 !== 'string' || inv.sha256.length > 128) return false;
  if (typeof inv.kind !== 'string' || !INVOICE_KINDS.has(inv.kind)) return false;
  if (!isFiniteNonNegative(inv.pageCount) || inv.pageCount < 1 || inv.pageCount > MAX_INVOICE_PAGES) return false;
  if (!Array.isArray(inv.items) || inv.items.length > 10_000) return false;
  if (!Array.isArray(inv.issues) || inv.issues.length > 10_000) return false;
  if (!isProvenance(inv.provenance)) return false;

  if (!optionalString(inv.businessTag)) return false;
  if (!optionalString(inv.invoiceNo, 64)) return false;
  if (!optionalString(inv.invoiceCode, 64)) return false;
  if (!optionalString(inv.issueDate, 32)) return false;
  if (!optionalString(inv.sellerName)) return false;
  if (!optionalString(inv.sellerTaxId, 64)) return false;
  if (!optionalString(inv.buyerName)) return false;
  if (!optionalString(inv.buyerTaxId, 64)) return false;
  if (!optionalString(inv.totalInWords)) return false;
  if (!optionalString(inv.checkCode, 64)) return false;
  if (!optionalCents(inv.amount)) return false;
  if (!optionalCents(inv.tax)) return false;
  if (!optionalCents(inv.total)) return false;
  if (inv.importedAt !== undefined && !isTimestamp(inv.importedAt)) return false;
  if (inv.skipPages !== undefined) {
    if (!Array.isArray(inv.skipPages)) return false;
    if (inv.skipPages.length > MAX_INVOICE_PAGES) return false;
    if (!inv.skipPages.every((page) => Number.isInteger(page) && page >= 0 && page < MAX_INVOICE_PAGES)) {
      return false;
    }
  }
  if (!inv.issues.every(isIssue)) return false;
  if (!inv.items.every(isItem)) return false;

  return true;
}

/** 明细行也会进排版与打印：名称/规格限长，金额限范围，别让一行明细撑爆版面 */
function isItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<Invoice['items'][number]>;
  return (
    optionalString(item.name, 200) &&
    optionalString(item.spec, 200) &&
    optionalString(item.unit, 32) &&
    optionalString(item.taxRate, 32) &&
    optionalNumber(item.quantity, (n) => n >= 0 && n <= 1e9) &&
    optionalCents(item.unitPrice) &&
    optionalCents(item.amount) &&
    optionalCents(item.tax)
  );
}

function optionalNumber(value: unknown, inRange: (value: number) => boolean): boolean {
  return value === undefined || (
    typeof value === 'number' && Number.isFinite(value) && inRange(value)
  );
}

function isIssue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const issue = value as Partial<Issue>;
  return (
    typeof issue.code === 'string' &&
    typeof issue.level === 'string' &&
    ISSUE_LEVELS.has(issue.level) &&
    typeof issue.message === 'string' &&
    issue.message.length <= 4096
  );
}

/** 备份里有、当前库里没有的记录（按内容指纹比对）—— 页面上「有情况」的判据 */
export function missingFrom(
  library: readonly LibraryRecord[],
  backup: Backup,
): BackupRecord[] {
  const known = new Set(library.map((record) => record.sha256));
  return backup.records.filter((record) => !known.has(record.sha256));
}

export interface BackupSummary {
  count: number;
  reimbursed: number;
  at: number;
}

export function summaryOf(backup: Backup): BackupSummary {
  return {
    count: backup.records.length,
    reimbursed: backup.records.filter((record) => record.mark === 'reimbursed').length,
    at: backup.at,
  };
}

/** 写一份备份（非桌面端是空操作）。失败只记日志 —— 备份不该打扰用户手里的事。 */
export async function pushBackup(
  records: readonly LibraryRecord[] = currentLibrary(),
  at = Date.now(),
): Promise<void> {
  if (!isDesktop()) return;
  try {
    await storeWrite(BACKUP_NAME, new TextEncoder().encode(backupJson(records, at)));
  } catch (err) {
    logLine(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 读备份（非桌面端、或还没有备份 → `undefined`） */
export async function readBackup(): Promise<Backup | undefined> {
  if (!isDesktop()) return undefined;
  try {
    const bytes = await storeRead(BACKUP_NAME);
    if (!bytes || bytes.byteLength === 0) return undefined;
    return parseBackup(new TextDecoder().decode(bytes));
  } catch (err) {
    logLine(`backup read failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * 从备份恢复：只补**库里没有的**记录，已有的不动。
 *
 * 恢复出来的记录**没有原文件字节**（`hasBytes=false`）：字段、金额、状态都在，
 * 但「再打一份」做不到 —— 这是诚实的降级，不是假装原文件还在。
 * 返回恢复了几条。
 */
export async function restoreFromBackup(backup: Backup): Promise<number> {
  const missing = missingFrom(currentLibrary(), backup);
  if (missing.length === 0) return 0;

  const groups: Record<LibraryMark, RememberInput[]> = { printed: [], reimbursed: [] };
  for (const record of missing) {
    groups[record.mark].push({
      sha256: record.sha256,
      invoice: record.invoice,
      bytes: new Uint8Array(),
      fileName: record.fileName,
      fileSize: record.fileSize,
      visual: 'none',
      addedAt: record.addedAt,
      ...(record.printedAt !== undefined ? { printedAt: record.printedAt } : {}),
      ...(record.reimbursedAt !== undefined ? { reimbursedAt: record.reimbursedAt } : {}),
    });
  }

  // 先「已打印」再「已报销」：remember 里状态只升不降，两条都要写时顺序不能反
  await remember(groups.printed, 'printed');
  await remember(groups.reimbursed, 'reimbursed');
  logLine(`backup restored: ${missing.length} 条`);
  return missing.length;
}
