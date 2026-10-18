/**
 * 桌面外壳桥的契约测试。
 *
 * 这些用例钉住的是**跨语言的约定**，不是实现细节：
 * 请求体是裸字节、元信息走 header 且是百分比编码、响应靠内容类型决定是 `ArrayBuffer` 还是 JSON。
 * 约定一旦漂了，Rust 侧（`files.rs` / `store.rs`）就会读不到名字 —— 那种 bug
 * 只有在打包好的桌面版里才会现形，所以必须在单测里钉住。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installShell, uninstallShell } from '../test/tauriFake';
import {
  LOG_NAME,
  appInfo,
  asBytes,
  encodeHeaderValue,
  isDesktop,
  logLine,
  openPath,
  pickDocuments,
  printDocument,
  readDocument,
  revealPath,
  saveDocument,
  storeAppend,
  storeList,
  storeRead,
  storeRemove,
  storeWrite,
} from './shell';

afterEach(() => {
  uninstallShell();
  vi.restoreAllMocks();
});

describe('外壳探测', () => {
  it('浏览器里没有外壳', () => {
    expect(isDesktop()).toBe(false);
  });

  it('注入了 IPC 就是桌面端', () => {
    installShell(() => null);
    expect(isDesktop()).toBe(true);
  });

  it('没有 invoke 的残缺注入不算外壳', () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(isDesktop()).toBe(false);
  });
});

describe('header 编码', () => {
  it('中文文件名百分比编码成纯 ASCII（header 只收可见 ASCII）', () => {
    const encoded = encodeHeaderValue('发票合并打印.pdf');
    expect(encoded).toBe('%E5%8F%91%E7%A5%A8%E5%90%88%E5%B9%B6%E6%89%93%E5%8D%B0.pdf');
    expect(/^[\x20-\x7e]*$/.test(encoded)).toBe(true);
  });
});

describe('字节进出', () => {
  it('读文件：请求带 path，响应 ArrayBuffer 转成 Uint8Array', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { calls } = installShell(() => bytes.buffer);
    const got = await readDocument('/tmp/票.pdf');
    expect(calls[0]).toEqual({ cmd: 'read_document', payload: { path: '/tmp/票.pdf' } });
    expect(Array.from(got)).toEqual([1, 2, 3]);
  });

  it('asBytes 对非字节内容直接报错，不静默返回空', () => {
    expect(() => asBytes({ oops: true }, 'x')).toThrow(/外壳没有返回字节/);
    expect(() => asBytes(null, 'x')).toThrow(/外壳没有返回字节/);
  });

  it('保存：请求体是裸字节，名字与扩展名走 header，取消返回 null', async () => {
    const bytes = new Uint8Array([9, 9]);
    const { calls } = installShell((call) =>
      call.cmd === 'save_document' ? { path: '/Users/me/发票.pdf', name: '发票.pdf', size: 2 } : null,
    );
    const written = await saveDocument(bytes, '发票.pdf', 'pdf');
    expect(calls[0]!.payload).toBe(bytes); // 裸字节，不是 JSON
    expect(calls[0]!.options?.headers).toEqual({ name: encodeHeaderValue('发票.pdf'), filter: 'pdf' });
    expect(written).toEqual({ path: '/Users/me/发票.pdf', name: '发票.pdf', size: 2 });

    installShell(() => null);
    expect(await saveDocument(bytes, '发票.pdf')).toBeNull();
  });

  it('打印：名字走 header，结果按 JSON 解析', async () => {
    const { calls } = installShell(() => ({ ok: true, message: '已发送到打印机「HP」', path: '/tmp/x.pdf' }));
    const outcome = await printDocument(new Uint8Array([1]), '票.pdf');
    expect(calls[0]!.cmd).toBe('print_document');
    expect(calls[0]!.options?.headers).toEqual({ name: encodeHeaderValue('票.pdf') });
    expect(outcome.ok).toBe(true);
    expect(outcome.path).toBe('/tmp/x.pdf');
  });

  it('交给系统：在文件管理器里显示 / 默认程序打开', async () => {
    const { calls } = installShell(() => null);
    await revealPath('/tmp/a.pdf');
    await openPath('/tmp/a.pdf');
    expect(calls.map((c) => c.cmd)).toEqual(['reveal_path', 'open_path']);
    expect(calls[0]!.payload).toEqual({ path: '/tmp/a.pdf' });
  });
});

describe('数据目录', () => {
  it('清单是 JSON 数组', async () => {
    installShell(() => [{ name: LOG_NAME, size: 12, modified: 1 }]);
    const entries = await storeList();
    expect(entries).toEqual([{ name: LOG_NAME, size: 12, modified: 1 }]);
  });

  it('读不存在的文件返回 undefined（首次启动要看备份，不是错误）', async () => {
    // Rust 侧「没有这个文件」= 空字节；null 是防御性的兜底
    installShell(() => new ArrayBuffer(0));
    expect(await storeRead('library-backup.json')).toBeUndefined();
    installShell(() => null);
    expect(await storeRead('library-backup.json')).toBeUndefined();
  });

  it('写与追加：body 是字节，名字走 header', async () => {
    const { calls } = installShell(() => 3);
    await storeWrite('library-backup.json', new Uint8Array([123, 125]));
    await storeAppend(LOG_NAME, '你好');
    expect(calls[0]!.cmd).toBe('store_write');
    expect(calls[0]!.options?.headers).toEqual({ name: encodeHeaderValue('library-backup.json') });
    expect(calls[1]!.cmd).toBe('store_append');
    expect(Array.from(calls[1]!.payload as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('你好')));
  });

  it('删除只要名字', async () => {
    const { calls } = installShell(() => null);
    await storeRemove(LOG_NAME);
    expect(calls[0]).toEqual({ cmd: 'store_remove', payload: { name: LOG_NAME } });
  });
});

describe('应用信息与日志', () => {
  it('应用信息是 JSON 对象', async () => {
    installShell(() => ({
      name: '发票工具',
      version: '0.1.0',
      tauriVersion: '2.12.4',
      os: 'macos',
      arch: 'aarch64',
      dataDir: '/Users/me/Library/Application Support/dev.invoicetool.desktop',
      debug: false,
    }));
    const info = await appInfo();
    expect(info.dataDir).toContain('dev.invoicetool.desktop');
  });

  it('浏览器里写日志是空操作（不该有 IPC 调用）', () => {
    const { calls } = installShell(() => 0);
    uninstallShell();
    logLine('不该发出去');
    expect(calls).toHaveLength(0);
  });

  it('桌面端日志带时间戳，写进固定文件名', async () => {
    const { calls } = installShell(() => 0);
    logLine('print ok: 已发送');
    expect(calls[0]!.cmd).toBe('store_append');
    expect(calls[0]!.options?.headers).toEqual({ name: encodeHeaderValue(LOG_NAME) });
    const text = new TextDecoder().decode(calls[0]!.payload as Uint8Array);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z print ok: 已发送$/);
  });
});

describe('选择发票', () => {
  it('取消返回空数组', async () => {
    installShell(() => []);
    expect(await pickDocuments()).toEqual([]);
  });

  it('返回路径/名字/大小', async () => {
    installShell(() => [{ path: '/tmp/票.pdf', name: '票.pdf', size: 100 }]);
    expect(await pickDocuments()).toEqual([{ path: '/tmp/票.pdf', name: '票.pdf', size: 100 }]);
  });
});
