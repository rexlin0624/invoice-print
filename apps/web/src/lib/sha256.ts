/** 文件指纹。内核不做哈希（不能依赖浏览器/Node API），由外壳提供。 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // 复制一份：crypto.subtle 不接受 SharedArrayBuffer 视图，也不接受被 detach 的 buffer
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
