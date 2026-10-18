/**
 * 「只渲染页面的一块区域」的参数计算（纯几何，无 DOM）。
 *
 * 为什么在内核：网页版与桌面端都要做同一件事 —— 预览缩略图、二维码区域放大、
 * 白边探测、黑白/栅格化。而这里有一个**违反直觉**的 pdfjs 行为，两端各写一遍
 * 就会各踩一次坑（参考项目「两端各算一套、五处同步」的教训）。
 *
 * ⚠️ pdfjs 的 `render({ viewport, transform })` 里，`transform` 是**乘在 viewport 之上**的：
 * 源码 `CanvasGraphics.beginDrawing()` 先 `ctx.transform(...transform)`，再
 * `ctx.transform(...viewport.transform)`。所以 **viewport 必须传 `scale: 1`**，
 * 缩放只写在 transform 里。
 *
 * 缩放写两遍的后果是**平方**（s → s²，2.66 变 7.07）：画布只有 region 那么大，
 * 于是画进去的只有页面左上角 1/s² 一块，还被放大 s 倍 ——
 * 症状就是「预览里整张票只显示左上角一小块、字特别大、右边和下边被切断」。
 *
 * 这个坑特别难查，因为白边探测用的是 72dpi、scale 恰好 1，看起来完全正常；
 * 只有放大过的路径（缩略图、黑白/栅格化）才出错。
 */

/** pdfjs 页面代理里我们唯一需要的能力（用最小结构类型，免得依赖 pdfjs 的类型路径） */
export interface ViewportSource<V> {
  getViewport(params: { scale: number }): V;
}

export interface RenderRegionArgs<V> {
  /** 必须原样传给 `page.render({ viewport })` */
  viewport: V;
  /** 必须原样传给 `page.render({ transform })` */
  transform: [number, number, number, number, number, number];
}

/**
 * 渲染参数：把页面坐标里的 `origin`（pt，左上原点、y 向下）挪到画布原点，
 * 整体缩放 `scale` 倍。
 *
 * 调用方负责把画布开成 `region 尺寸 × scale`（见 `apps/web/src/lib/thumb.ts` 等）。
 */
export function regionRenderArgs<V>(
  page: ViewportSource<V>,
  scale: number,
  origin: { x: number; y: number },
): RenderRegionArgs<V> {
  // `-0` 与 `0` 算术上等价，但会让「同一个变换」比较起来不相等（断言 / 缓存都会踩），这里归一化
  const tx = origin.x === 0 ? 0 : -origin.x * scale;
  const ty = origin.y === 0 ? 0 : -origin.y * scale;
  return {
    // 只能是 scale 1：缩放再乘一次就被平方（见文件头说明）
    viewport: page.getViewport({ scale: 1 }),
    transform: [scale, 0, 0, scale, tx, ty],
  };
}
