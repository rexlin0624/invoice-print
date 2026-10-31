/**
 * 离线 OCR（tesseract.js）+ 中文语言模型。
 *
 * 为什么是 tesseract 而不是 PP-OCR：
 * 参考实现走的是 MNN + PP-OCRv6（原生端）。搬到浏览器里要么带一整套
 * onnxruntime-web + 检测/识别两个模型 + CTC 解码（工作量大、包更大），
 * 要么用 tesseract。这一版选了 tesseract：**一个 wasm 核心 + 一个语言模型**
 * 就能跑，识别中文印刷体票面够用。代价是准确率不如 PP-OCR，
 * 所以 OCR 的置信度定得低（0.6），并且强制走「复核」提示。
 *
 * 本地化（这段是重点）：
 * tesseract.js 默认从 jsDelivr CDN 拉 **worker / wasm 核心 / 语言模型** 三样。
 * 本项目承诺「不上传、断网可用」，所以三样都指到同源的 `public/ocr/`
 * （由 `scripts/prepare-ocr.mjs` 准备）。运行时**零外部请求**。
 *
 * 内存纪律：本机 8 GB。worker 活着的时候吃几百 MB，所以
 * ①同一时刻只有一个 worker；②空闲 60 秒自动销毁；③识别用的图像宽度封顶 1600 px
 * （画图那一步已经交给渲染引擎 —— 它在 Worker 里跑，不占主线程内存也不受标签页可见性影响）。
 */

import type { OcrPageInput } from '@invoice-tool/core';
import type { createWorker } from 'tesseract.js';

import { ocrAssetResponseIsUsable } from './ocrNotice';
import { renderPage, resultBytes } from './render/client';

const OCR_BASE = new URL(`${import.meta.env.BASE_URL}ocr/`, document.baseURI).href;
const WORKER_URL = `${OCR_BASE}worker.min.js`;
const CORE_FILE = `${OCR_BASE}tesseract-core-lstm.wasm.js`;
const LANG_PATH = OCR_BASE;
const LANG = 'chi_sim';

/** 识别用的图像宽度上限（像素）。再高对 tesseract 的收益很小，内存却翻倍。 */
const MAX_OCR_WIDTH = 1600;
/**
 * 低于这个置信度的词直接丢。
 * 不设太高：中文单字在 tesseract 里置信度波动很大（实测同一行里有 89 也有 4），
 * 20 会把「体」「州」「公」这类**正确但低分**的字丢掉，公司名就残了。
 * 噪声字（表格边框、印章）的置信度反而常常很高，所以这个阈值只用来挡明显乱码。
 */
const MIN_WORD_CONFIDENCE = 10;
/** 空闲这么久就把 worker 销毁，把内存还给系统 */
const IDLE_TERMINATE_MS = 60_000;

export type OcrPhase = 'runtime' | 'language' | 'recognizing' | 'done';

export interface OcrProgress {
  phase: OcrPhase;
  /** 0–1 */
  progress: number;
  label: string;
}

/** tesseract 的 worker 类型（只借类型，运行时是动态 import 的） */
type OcrWorker = Awaited<ReturnType<typeof createWorker>>;

let worker: OcrWorker | undefined;
let workerPending: Promise<OcrWorker> | undefined;
let idleTimer: number | undefined;

/** tesseract 的状态字符串 → 给人看的中文 */
function labelFor(status: string): { phase: OcrPhase; label: string } {
  if (status.includes('core')) return { phase: 'runtime', label: '正在加载 OCR 引擎' };
  if (status.includes('language') || status.includes('traineddata')) {
    return { phase: 'language', label: '正在加载中文模型（首次约 20 MB）' };
  }
  if (status.includes('initializ')) return { phase: 'runtime', label: '正在启动 OCR 引擎' };
  return { phase: 'recognizing', label: '正在识别文字' };
}

/** 模型在不在这台机器上（用于给出「先跑一次准备脚本」的提示） */
export async function ocrAssetsReady(): Promise<boolean> {
  try {
    const res = await fetch(`${LANG_PATH}${LANG}.traineddata.gz`, {
      method: 'HEAD',
    });
    // 只看 res.ok 会被 SPA 兜底骗过（缺失路径回成 200 + index.html），
    // 必须再看 Content-Type —— 否则模型没装时 OCR 静默失败，用户一头雾水。
    return ocrAssetResponseIsUsable(res.ok, res.headers.get('content-type'));
  } catch {
    return false;
  }
}

async function getWorker(onProgress?: (p: OcrProgress) => void): Promise<OcrWorker> {
  if (worker) {
    resetIdle();
    return worker;
  }
  workerPending ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    return createWorker(LANG, undefined, {
      workerPath: WORKER_URL,
      corePath: CORE_FILE,
      langPath: LANG_PATH,
      // 同源 URL 不需要 blob 包装，也少一层 CSP 麻烦
      workerBlobURL: false,
      logger: (message: { status?: string; progress?: number }) => {
        const status = String(message.status ?? '');
        const { phase, label } = labelFor(status);
        onProgress?.({ phase, progress: Number(message.progress ?? 0), label });
      },
    });
  })();

  try {
    worker = await workerPending;
  } catch (err) {
    workerPending = undefined;
    throw err;
  }
  resetIdle();
  return worker;
}

function resetIdle(): void {
  if (idleTimer !== undefined) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    void releaseOcr();
  }, IDLE_TERMINATE_MS);
}

/** 主动释放（换页/关闭后台时用，也给空闲计时器用） */
export async function releaseOcr(): Promise<void> {
  if (idleTimer !== undefined) {
    window.clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const dying = worker;
  worker = undefined;
  workerPending = undefined;
  if (dying) await dying.terminate().catch(() => undefined);
}

/** tesseract 的词 → 内核的 TextToken（坐标按 scale 还原回业务坐标系） */
interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * tesseract.js 的返回结构变过，而且**默认什么都不给**：
 *
 * - v4：顶层 `data.words`；
 * - v6/v7：只有嵌套的 `blocks[].paragraphs[].lines[].words[]`，
 *   并且 `blocks` 默认不生成 —— 必须在 `recognize()` 第三个参数里显式要
 *   （见 `worker-script/constants/defaultOutput.js`，默认只有 `text: true`）。
 *
 * 这个坑的后果很隐蔽：识别成功了、`data.text` 也有内容，
 * 但按 `data.words` 取就是空数组 → **一个字都进不了内核**，
 * 表现成「OCR 跑了但字段全空」。
 *
 * 所以这里三条路都走：v7 的 blocks → v4 的 words → TSV 解析兜底。
 */
interface OcrResult {
  text?: string;
  words?: OcrWord[];
  blocks?: { paragraphs?: { lines?: { words?: OcrWord[] }[] }[] }[] | null;
  tsv?: string | null;
}

/** TSV 兜底：level=5 的行就是词，列序是 left/top/width/height/conf/text */
function wordsFromTsv(tsv: string): OcrWord[] {
  const out: OcrWord[] = [];
  for (const row of tsv.split('\n')) {
    const cols = row.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = cols[11]!.trim();
    if (text === '') continue;
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const confidence = Number(cols[10]);
    if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
    out.push({
      text,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
    });
  }
  return out;
}

function collectWords(data: OcrResult): OcrWord[] {
  if (Array.isArray(data.words) && data.words.length > 0) return data.words;

  const nested: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) nested.push(word);
      }
    }
  }
  if (nested.length > 0) return nested;

  return data.tsv ? wordsFromTsv(data.tsv) : [];
}

function wordsToTokens(words: readonly OcrWord[], scale: number): OcrPageInput['tokens'] {
  const tokens: OcrPageInput['tokens'] = [];
  for (const word of words) {
    const text = word.text.replace(/\s+/g, '');
    if (text === '') continue;
    if (word.confidence < MIN_WORD_CONFIDENCE) continue;
    const { x0, y0, x1, y1 } = word.bbox;
    tokens.push({
      text,
      x: x0 / scale,
      y: y0 / scale,
      width: Math.max(1, (x1 - x0) / scale),
      height: Math.max(1, (y1 - y0) / scale),
    });
  }
  return tokens;
}

/** 认一张图片（tesseract 收 Blob / File / canvas / OffscreenCanvas，不收 ImageData） */
async function recognizeImageLike(
  image: Blob,
  scale: number,
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrPageInput['tokens']> {
  const engine = await getWorker(onProgress);
  onProgress?.({ phase: 'recognizing', progress: 0, label: '正在识别文字' });
  // `blocks: true` 是**必需的**（默认只有 text），见 collectWords 的说明
  const result = await engine.recognize(image, {}, { blocks: true });
  resetIdle();
  return wordsToTokens(collectWords(result.data as unknown as OcrResult), scale);
}

/** 认 PDF 的一页：先让渲染引擎把它画成 PNG（渲染在 Worker 里，标签页不可见也算数） */
async function recognizePdfPage(
  data: Uint8Array,
  pageIndex: number,
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrPageInput | undefined> {
  const rendered = await renderPage(data, {
    kind: 'pdf',
    pageIndex,
    // 宽度封顶 + 上限 4 倍：与 canvasFor() 原来那套语义一致
    maxWidthPx: MAX_OCR_WIDTH,
    maxScale: 4,
    encode: 'image/png',
  }).catch(() => undefined);
  if (!rendered) return undefined;

  const image = new Blob([resultBytes(rendered)], { type: 'image/png' });
  const tokens = await recognizeImageLike(image, rendered.scale, onProgress);
  return { width: rendered.base.width, height: rendered.base.height, tokens };
}

/**
 * 认 PDF 的若干页。
 *
 * `pages` 是**源文件页下标**（明细页的换算已由调用方处理）。
 * 返回的坐标是页面 pt（左上原点，y 向下），与文字层完全同构。
 */
export async function recognizePdfPages(
  data: Uint8Array,
  pages: readonly number[],
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrPageInput[]> {
  const out: OcrPageInput[] = [];
  for (const index of pages) {
    const page = await recognizePdfPage(data, index, onProgress);
    if (page) out.push(page);
  }
  return out;
}

/** 认一张图片（png/jpg）。坐标用图片原始像素，和 `imageSize()` 同一套。 */
export async function recognizeImage(
  data: Uint8Array,
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrPageInput | undefined> {
  const rendered = await renderPage(data, {
    kind: 'image',
    maxWidthPx: MAX_OCR_WIDTH,
    maxScale: 4,
    encode: 'image/png',
  }).catch(() => undefined);
  if (!rendered) return undefined;

  const image = new Blob([resultBytes(rendered)], { type: 'image/png' });
  const tokens = await recognizeImageLike(image, rendered.scale, onProgress);
  return { width: rendered.base.width, height: rendered.base.height, tokens };
}
