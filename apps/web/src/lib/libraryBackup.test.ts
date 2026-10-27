/**
 * 本机库备份：**序列化格式**与**恢复语义**的测试。
 *
 * 备份文件是「清过浏览数据之后还能救回来」的唯一依靠，所以两件事必须钉住：
 * 1. 格式稳定且能容错（坏文件当没有，不许抛）；
 * 2. 恢复只补库里没有的，且按原状态分组写（状态只升不降，顺序错了会把「已报销」打回「已打印」）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LibraryRecord } from './library';
import {
  BACKUP_NAME,
  backupJson,
  missingFrom,
  parseBackup,
  pushBackup,
  readBackup,
  restoreFromBackup,
  summaryOf,
} from './libraryBackup';
import { installShell, uninstallShell } from '../test/tauriFake';

const { remember, currentLibrary } = vi.hoisted(() => ({
  remember: vi.fn(async () => undefined),
  currentLibrary: vi.fn((): LibraryRecord[] => []),
}));
vi.mock('./library', () => ({ remember, currentLibrary }));

function invoice(sha: string, total = 1234) {
  return {
    id: sha,
    kind: 'vat-general' as const,
    fileName: `${sha}.pdf`,
    fileSize: 1000,
    sha256: sha,
    total,
    items: [],
    pageCount: 1,
    provenance: {},
    issues: [],
  };
}

function record(sha: string, mark: 'printed' | 'reimbursed' = 'reimbursed'): LibraryRecord {
  return {
    sha256: sha,
    invoice: invoice(sha),
    mark,
    at: 1_700_000_000_000,
    addedAt: 1_600_000_000_000,
    ...(mark === 'reimbursed' ? { reimbursedAt: 1_650_000_000_000 } : { printedAt: 1_640_000_000_000 }),
    fileName: `${sha}.pdf`,
    fileSize: 1000,
    visual: 'pdf',
    hasBytes: true,
  };
}

afterEach(() => {
  uninstallShell();
  remember.mockClear();
  currentLibrary.mockReset();
  currentLibrary.mockReturnValue([]);
});

describe('格式', () => {
  it('序列化 → 解析：字段与时间戳都保住（不含原文件字节）', () => {
    const text = backupJson([record('a'), record('b', 'printed')], 1_700_000_001_000);
    const backup = parseBackup(text)!;
    expect(backup.at).toBe(1_700_000_001_000);
    expect(backup.records).toHaveLength(2);
    expect(backup.records[0]).toMatchObject({
      sha256: 'a',
      mark: 'reimbursed',
      addedAt: 1_600_000_000_000,
      reimbursedAt: 1_650_000_000_000,
      fileName: 'a.pdf',
    });
    expect(backup.records[1]!.printedAt).toBe(1_640_000_000_000);
    // 字节不进备份
    expect(text).not.toContain('bytes');
  });

  it('坏文件 / 空文件当没有，绝不抛', () => {
    expect(parseBackup('')).toBeUndefined();
    expect(parseBackup('这不是 JSON')).toBeUndefined();
    expect(parseBackup('{"records":[]}')).toBeUndefined();
    expect(parseBackup('{"records":[{"sha256":"a"}]}')).toBeUndefined(); // 缺字段的记录被丢掉 → 空 → 当没有
  });

  it('invoice 形状/数值不合理 → 整条记录丢掉（备份在数据目录里，同机可改）', () => {
    const pages = record('a');
    pages.invoice = { ...pages.invoice, pageCount: 999_999_999 };
    expect(parseBackup(backupJson([pages]))).toBeUndefined();

    const amount = record('b');
    amount.invoice = { ...amount.invoice, total: Number.POSITIVE_INFINITY };
    expect(parseBackup(backupJson([amount]))).toBeUndefined();
  });

  it('概况：条数与已报销数', () => {
    const backup = parseBackup(backupJson([record('a'), record('b', 'printed')]))!;
    expect(summaryOf(backup)).toEqual({ count: 2, reimbursed: 1, at: backup.at });
  });

  it('「备份里有、库里没有」才是要恢复的', () => {
    const backup = parseBackup(backupJson([record('a'), record('b')]))!;
    expect(missingFrom([record('a')], backup).map((r) => r.sha256)).toEqual(['b']);
  });
});

describe('存取', () => {
  it('桌面版：写到数据目录里的固定文件名，内容能读回来', async () => {
    const { calls } = installShell(() => 0);
    await pushBackup([record('a')], 1_700_000_000_000);
    expect(calls[0]!.cmd).toBe('store_write');
    expect(calls[0]!.options?.headers?.name).toBe(encodeURIComponent(BACKUP_NAME));
    const written = new TextDecoder().decode(calls[0]!.payload as Uint8Array);
    expect(parseBackup(written)?.records[0]?.sha256).toBe('a');
  });

  it('网页版：不写（没有数据目录这回事）', async () => {
    const { calls } = installShell(() => 0);
    uninstallShell();
    await pushBackup([record('a')]);
    expect(calls).toHaveLength(0);
  });

  it('还没有备份 → undefined，不是空备份', async () => {
    installShell(() => new ArrayBuffer(0));
    expect(await readBackup()).toBeUndefined();
  });

  it('有备份 → 解析出记录', async () => {
    const text = backupJson([record('a')]);
    installShell(() => new TextEncoder().encode(text).buffer);
    expect((await readBackup())?.records).toHaveLength(1);
  });
});

describe('恢复', () => {
  it('按原状态分组写：先已打印、后已报销，并带上原始时间', async () => {
    const backup = parseBackup(backupJson([record('a', 'reimbursed'), record('b', 'printed')]))!;
    const restored = await restoreFromBackup(backup);

    expect(restored).toBe(2);
    expect(remember).toHaveBeenCalledTimes(2);

    const [printedInputs, printedMark] = remember.mock.calls[0] as unknown as [unknown[], string];
    const [reimbursedInputs, reimbursedMark] = remember.mock.calls[1] as unknown as [unknown[], string];
    expect(printedMark).toBe('printed');
    expect(reimbursedMark).toBe('reimbursed');

    const printed = printedInputs[0] as Record<string, unknown>;
    expect(printed.sha256).toBe('b');
    expect(printed.printedAt).toBe(1_640_000_000_000);
    expect((printed.bytes as Uint8Array).byteLength).toBe(0); // 备份里没有原文件
    expect(printed.visual).toBe('none');

    const reimbursed = reimbursedInputs[0] as Record<string, unknown>;
    expect(reimbursed.reimbursedAt).toBe(1_650_000_000_000);
    expect(reimbursed.addedAt).toBe(1_600_000_000_000);
  });

  it('库里都有 → 不动，返回 0', async () => {
    currentLibrary.mockReturnValue([record('a')]);
    const backup = parseBackup(backupJson([record('a')]))!;
    expect(await restoreFromBackup(backup)).toBe(0);
    expect(remember).not.toHaveBeenCalled();
  });
});
