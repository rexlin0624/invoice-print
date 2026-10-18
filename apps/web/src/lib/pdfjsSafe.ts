/**
 * 交给 pdfjs 之前，必须先过这一层。
 *
 * ⚠️ pdfjs 会把传入的 `ArrayBuffer` **转移（transfer）** 给它的 worker。
 * 转移之后，调用方手上那个 `Uint8Array` 就变成 detached：
 *   - `byteLength` 静默变成 0
 *   - 再 `slice()` / `subarray()` 直接抛
 *     `Cannot perform Construct on a detached ArrayBuffer`
 *
 * 这个坑只在**浏览器**里出现（Node 里没有 worker，不会转移），
 * 所以典型症状是「单元测试全绿、网页里全空」。
 *
 * 规则：`IntakeItem.data` 是外壳持有的**唯一一份原始字节**，谁都不许把它
 * 直接交给 pdfjs。要交给 pdfjs，先 `safeBytes()` 拷一份。
 */
export function safeBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  // slice() 一定分配一块新的普通 ArrayBuffer（不是 SharedArrayBuffer），
  // 返回类型写窄一点，调用方把 `.buffer` 交给 transfer / pdfjs 时不必再断言
  return data.slice();
}
