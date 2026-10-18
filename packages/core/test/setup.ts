/**
 * vitest 全局准备。
 *
 * pdfjs 4.x 用到 `Promise.withResolvers`（Node 22+ 才有）。本机是 Node 20，
 * 所以这里补一个 polyfill —— 浏览器端旧 Safari 同理（见 apps/web/src/polyfills.ts）。
 */
if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== 'function') {
  (Promise as unknown as { withResolvers: () => unknown }).withResolvers = function withResolvers() {
    let resolve: unknown;
    let reject: unknown;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
