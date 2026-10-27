/**
 * 解析预算：**陌生人给的字节能长什么样，不能靠猜**。
 *
 * 收票是这个工具唯一接受外部输入的地方，而压缩包、OFD、XML 都可以用很小的
 * 体积换很大的内存。把上限集中在这一处，解析器只做「超了就拒绝」，
 * 免得每个调用点各写一个数字、谁先谁后还说不清。
 *
 * 这些值按「真实发票够用」定，不是按「机器扛得住」定：
 * - 一个压缩包里的发票通常是个位数，200 张已经是一次很夸张的批量；
 * - 单张发票解析后 64 MB、整包 256 MB，扫描件（300 dpi A4 约 8 MB）也远远够；
 * - OFD 的 Content.xml 真实大小是几十 KB，2 MB 已经非常宽松。
 */

import type JSZip from 'jszip';

/** 压缩包里最多展开多少张（超出部分忽略，不报错 —— 和以前的行为一致） */
export const MAX_ARCHIVE_ENTRIES = 200;

/** 单个条目解压后的上限 */
export const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;

/** 整个压缩包解压后的总上限 */
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;

/** 单个 XML 文件（不是压缩包）的字节上限 */
export const MAX_XML_BYTES = 20 * 1024 * 1024;

/** OFD 的 Content.xml 解出来之后的字符上限 */
export const MAX_TEXT_XML_CHARS = 2 * 1024 * 1024;

/** 一页 OFD 最多认多少个 TextCode（真实发票远小于这个数） */
export const MAX_TEXT_CODES = 20_000;

export interface ArchiveLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

/** 读一个条目时能用的预算（测试会把它调小） */
function resolveLimits(limits: ArchiveLimits): Required<ArchiveLimits> {
  return {
    maxEntries: limits.maxEntries ?? MAX_ARCHIVE_ENTRIES,
    maxEntryBytes: limits.maxEntryBytes ?? MAX_ARCHIVE_ENTRY_BYTES,
    maxTotalBytes: limits.maxTotalBytes ?? MAX_ARCHIVE_TOTAL_BYTES,
  };
}

/**
 * ZIP 中央目录里声明的原始大小。
 *
 * JSZip 没有把它放进公开类型，但 `_data.uncompressedSize` 是它内部一直在用的字段。
 * 这不是安全边界（压缩包可以撒谎），只是**提前拒绝**明显不合理的条目，
 * 免得先分配几个 GB 再判断。真正的边界是下面的流式读取。
 */
export function declaredSize(file: JSZip.JSZipObject): number | undefined {
  const data = (file as { _data?: { uncompressedSize?: unknown } })._data;
  const size = data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : undefined;
}

interface CappedStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): CappedStream;
  on(event: 'end', callback: () => void): CappedStream;
  on(event: 'error', callback: (error: Error) => void): CappedStream;
  resume(): CappedStream;
  pause(): CappedStream;
}

type StreamableObject = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): CappedStream;
};

/**
 * 流式解压，超过预算立刻停。
 *
 * 不用 `file.async()`：那个 API 会**先把整个条目解出来**再返回，预算只能事后检查，
 * 而「事后」正是内存已经没了的时候。`internalStream` 是 JSZip 的低层接口，
 * 分块产出，超预算时暂停即可；老版本没有这个方法时退回 `async`（仍有事后检查）。
 *
 * @returns 超出 `budget` 时返回 `undefined`（调用方决定是跳过还是报错）
 */
export async function readCapped(
  file: JSZip.JSZipObject,
  budget: number,
): Promise<Uint8Array | undefined> {
  if (!Number.isFinite(budget) || budget <= 0) return undefined;

  const streamable = file as Partial<StreamableObject>;
  const internalStream = streamable.internalStream;
  if (typeof internalStream !== 'function') {
    // 没有流式接口时，先用中央目录里声明的大小挡一道：`async()` 会把整个条目
    // 解出来才返回，等拿到字节再判断，内存早就被吃掉了。声明值可以撒谎，
    // 所以下面仍然会事后检查一次。
    const declared = declaredSize(file);
    if (declared !== undefined && declared > budget) return undefined;
    const bytes = await file.async('uint8array');
    return bytes.byteLength > budget ? undefined : bytes;
  }

  return await new Promise<Uint8Array | undefined>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const stream = internalStream.call(file, 'uint8array');

    stream.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > budget) {
        settled = true;
        stream.pause();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      const out = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      resolve(out);
    });
    stream.resume();
  });
}

/** 给用户看的体积（只用在报错里，不参与判断） */
export function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** 解压预算超了 —— 单独一个类型，方便调用方给出「这张票跳过」而不是「整批失败」 */
export class ArchiveLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveLimitError';
  }
}

export { resolveLimits };
