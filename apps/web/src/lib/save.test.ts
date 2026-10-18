/**
 * 保存路径的分流测试：**同一个 `saveBytes`，网页版下载、桌面版弹系统对话框**。
 * 页面不该知道自己在哪 —— 这个测试就是那句话的守卫。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installShell, uninstallShell } from '../test/tauriFake';
import { saveBytes, saveText, revealSaved } from './save';
import { LOG_NAME } from './shell';

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('./download', () => ({ downloadBlob }));

/** 等一轮微任务 + 宏任务：`logLine` 是「发了就不管」，断言前要让它落地 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  uninstallShell();
  downloadBlob.mockReset();
});

describe('网页版', () => {
  it('保存 = 浏览器下载，且**不知道**存到哪儿了', async () => {
    const bytes = new Uint8Array([1, 2]);
    const outcome = await saveBytes(bytes, '发票合并打印.pdf', {
      mime: 'application/pdf',
      filter: 'pdf',
    });
    expect(downloadBlob).toHaveBeenCalledWith(bytes, '发票合并打印.pdf', 'application/pdf');
    expect(outcome).toEqual({ saved: true, name: '发票合并打印.pdf' });
    expect(outcome.path).toBeUndefined();
  });

  it('文本默认加 BOM（不然 Windows 版 Excel 中文乱码）', async () => {
    await saveText('a,b', '清单.csv');
    const bytes = downloadBlob.mock.calls[0]![0] as Uint8Array;
    // 注意：`TextDecoder` 默认会**吃掉**开头的 BOM，所以这里断言原始字节
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe('a,b');
  });

  it('显式 bom:false 时不加', async () => {
    await saveText('a,b', '清单.csv', { bom: false });
    const bytes = downloadBlob.mock.calls[0]![0] as Uint8Array;
    expect(bytes[0]).toBe(0x61);
    expect(new TextDecoder().decode(bytes)).toBe('a,b');
  });

  it('revealSaved 在网页版什么都不做（没有路径这回事）', () => {
    expect(() => revealSaved(undefined)).not.toThrow();
    expect(() => revealSaved('/tmp/a.pdf')).not.toThrow();
  });
});

describe('桌面版', () => {
  it('保存走系统对话框，返回路径，并写一条日志', async () => {
    const { calls } = installShell(() =>
      ({ path: '/Users/me/发票.pdf', name: '发票.pdf', size: 2 }),
    );
    const outcome = await saveBytes(new Uint8Array([1, 2]), '发票.pdf', { filter: 'pdf' });

    expect(calls[0]!.cmd).toBe('save_document');
    expect(calls[0]!.options?.headers).toEqual({ name: '%E5%8F%91%E7%A5%A8.pdf', filter: 'pdf' });
    expect(outcome).toEqual({ saved: true, path: '/Users/me/发票.pdf', name: '发票.pdf' });

    await settle();
    const logged = calls.find((call) => call.cmd === 'store_append');
    expect(logged?.options?.headers?.name).toBe(encodeURIComponent(LOG_NAME));
  });

  it('用户在对话框里取消 = canceled，不是失败', async () => {
    installShell(() => null);
    const outcome = await saveBytes(new Uint8Array([1]), '发票.pdf');
    expect(outcome.saved).toBe(false);
    expect(outcome.canceled).toBe(true);
  });

  it('外壳报错时抛出（页面会弹提示），同时留一条日志', async () => {
    const { calls } = installShell(() => {
      throw new Error('磁盘满了');
    });
    await expect(saveBytes(new Uint8Array([1]), '发票.pdf')).rejects.toThrow('磁盘满了');
    await settle();
    expect(calls.some((call) => call.cmd === 'store_append')).toBe(true);
  });

  it('revealSaved 在桌面版会去「在文件夹里显示」', async () => {
    const { calls } = installShell(() => null);
    revealSaved('/Users/me/发票.pdf');
    await settle();
    expect(calls[0]).toEqual({ cmd: 'reveal_path', payload: { path: '/Users/me/发票.pdf' } });
  });
});
