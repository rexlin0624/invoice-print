/**
 * 给「可能卡住的可选增强步骤」加一个上限。
 *
 * 为什么需要：二维码解码、OCR、白边探测都要**渲染画布**，
 * 而渲染是「切成一堆小任务、每段之间让出事件循环」的实现。
 * 在**隐藏的标签页**里浏览器会把定时器限流到 1 秒一次，
 * 于是同一个渲染可能从 800 ms 变成好几分钟 —— 用户看到的是「卡住了」。
 * （这不是假想：本机自动化环境里 `document.hidden === true`，
 * 一次 `page.render()` 等 20 秒都没回来。）
 *
 * 这三件事都是**锦上添花**：拿不到就退回「只有文字层」的正常路径，
 * 绝不能因为它们把整批导入卡死。所以超时就放弃，并留下一条说明。
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T | undefined> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = window.setTimeout(() => {
          console.warn(`[timeout] ${label}超过 ${Math.round(ms / 1000)} 秒，已跳过。`);
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/** 二维码解码上限。正常票 1 秒内就出结果。 */
export const QR_TIMEOUT_MS = 15_000;
/** 一张票的 OCR 上限（含加载模型与渲染；正常单页 3–10 秒）。 */
export const OCR_TIMEOUT_MS = 120_000;
/** 白边探测上限。它只渲染 72 dpi 的小图，正常几百毫秒。 */
export const CROP_TIMEOUT_MS = 15_000;
