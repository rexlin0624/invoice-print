/**
 * 渲染 Worker 的入口。
 *
 * 为什么要把 pdfjs 的画布渲染搬出主线程（两条理由，第二条是主要的）：
 *
 * 1. 导入一叠发票时主线程会连着几十次 `page.render()`（每次几十到几百毫秒），
 *    界面直接卡住 —— 缩略图、进度条都不动。
 * 2. **pdfjs 在 Worker 里推进渲染不依赖 `rAF`。** 源码里那行是
 *    `_useRequestAnimationFrame = useRequestAnimationFrame === true && typeof window !== 'undefined'`，
 *    而标签页不可见时浏览器会暂停 rAF —— 于是「后台标签页 / 不可见窗口」里
 *    原来的渲染**永远跑不完**（本仓库 `docs/解析规则参考.md` §7.10 记的就是这个）。
 *    搬进 Worker 之后，这条路径与标签页可见性彻底无关。
 *
 * 单线程纪律：请求在这里**排队串行**执行。一次只画一张，内存峰值就是一张画布；
 * 这台 8 GB 的机器上并发画两张 A4@200dpi 就已经进入危险区（见 AGENTS.md 第 1 节）。
 *
 * ⚠️ 这个文件不许 import 任何碰 `document` 的模块 —— `engine.ts` 已经做到了。
 */

import { render } from './render/engine';
import { serializeError, transferablesOf, type RpcRequest, type RpcResponse } from './render/rpc';

/**
 * Worker 作用域。
 *
 * 不写 `/// <reference lib="webworker" />`：那会把 WebWorker 的全局声明灌进
 * 整个 web 程序，和 `DOM` lib 打架（两处都声明 `self` / `addEventListener`）。
 * 这里只需要两个方法，手写一个最小结构更省事。
 */
const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<RpcRequest>) => void): void;
  postMessage(message: RpcResponse, transfer?: Transferable[]): void;
};

/** 串行队列：上一个请求彻底结束（含失败）才处理下一个 */
let queue: Promise<void> = Promise.resolve();

scope.addEventListener('message', (event: MessageEvent<RpcRequest>) => {
  const { id, args } = event.data;
  queue = queue.then(async () => {
    let response: RpcResponse;
    let transfer: ArrayBuffer[] = [];
    try {
      const result = await render(args);
      response = { id, ok: true, result };
      transfer = transferablesOf(result);
    } catch (err) {
      response = { id, ok: false, error: serializeError(err) };
    }
    scope.postMessage(response, transfer);
  });
});
