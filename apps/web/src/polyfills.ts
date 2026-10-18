/**
 * 老浏览器补丁。只为 pdfjs 4.x 而存在（它用了 Promise.withResolvers，Safari 17.4 / Node 22 才有）。
 * 等基线提到 Safari 17.4+ 就可以删掉。
 */
const promiseWithResolvers = (
  Promise as unknown as {
    withResolvers?: <T>() => {
      promise: Promise<T>;
      resolve: (v: T | PromiseLike<T>) => void;
      reject: (r?: unknown) => void;
    };
  }
).withResolvers;

if (typeof promiseWithResolvers !== 'function') {
  (Promise as unknown as { withResolvers: unknown }).withResolvers = function withResolvers<T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (r?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
