/**
 * 按需渲染「原图」。
 *
 * 为什么要单独做这个：列表里的缩略图只有一两百像素，**看不清发票号码和金额** ——
 * 而人工校正恰恰要求逐位核对。参考项目的做法（D07）是按需渲染当前这一页、
 * 一眼看完就丢，这里照搬它的纪律：
 *
 * - 只渲染**当前这一页**，按需生成，不落盘、不发网络请求；
 * - 关掉弹窗立刻 `revokeObjectURL`，同一页同档位再打开就复用（不重复画）；
 * - 像素一律走 `lib/render/client.ts` 的 `renderPage()`（默认在 Worker 里画，
 *   标签页不可见也算数，见 AGENTS.md §6）—— 不要在这里自己 `getDocument()`。
 */

import { useEffect, useRef, useState } from 'react';

import type { IntakeItem } from '../lib/intake';
import { renderPage, resultBytes } from '../lib/render/client';
import { CloseIcon } from './icons';

/** 两档就够：适应窗口看全貌，放大看号码 */
const ZOOMS = [
  { value: 'fit', label: '适应窗口', px: 1400, maxScale: 4 },
  { value: 'zoom', label: '放大看清', px: 2600, maxScale: 6 },
] as const;

type Zoom = (typeof ZOOMS)[number]['value'];

/** 「能看的一张图」需要的最小信息 —— 让本次导入的票和库里的记录都能喂进来 */
export interface ViewerSource {
  data: Uint8Array;
  visual: 'pdf' | 'image' | 'none';
  fileName: string;
  pageCount: number;
  /** 缓存 key（同一份文件同一页不必重画） */
  key: string;
}

/** 本次导入的票 → 可看原图 */
export function viewerSourceOf(item: IntakeItem, fileName = item.invoice.fileName): ViewerSource {
  return {
    data: item.data,
    visual: item.visual,
    fileName,
    pageCount: item.invoice.pageCount,
    key: item.invoice.sha256,
  };
}

interface Props {
  item: ViewerSource;
  /** 源文件页下标（0 基）。默认第一页 */
  pageIndex?: number;
  onClose: () => void;
}

export function PageViewer({ item, pageIndex = 0, onClose }: Props) {
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  /** 当前 objectURL 与其来源 key：同 key 直接复用，换 key 才重画 */
  const urlRef = useRef('');
  const keyRef = useRef('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 关掉弹窗（组件卸载）时把最后一个 URL 收回来，SPA 里不会泄漏
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  useEffect(() => {
    if (item.visual === 'none') {
      setBusy(false);
      return;
    }
    const preset = ZOOMS.find((z) => z.value === zoom)!;
    const key = `${item.key}:${pageIndex}:${preset.px}`;
    if (key === keyRef.current && urlRef.current) return; // 已经画过这一张

    let alive = true;
    setBusy(true);
    setError('');
    void (async () => {
      try {
        const result = await renderPage(item.data, {
          kind: item.visual === 'pdf' ? 'pdf' : 'image',
          pageIndex,
          maxWidthPx: preset.px,
          maxScale: preset.maxScale,
          encode: 'image/jpeg',
          quality: 0.92,
        });
        const blob = new Blob([resultBytes(result)], { type: result.mime ?? 'image/jpeg' });
        const next = URL.createObjectURL(blob);
        if (!alive) {
          URL.revokeObjectURL(next);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        keyRef.current = key;
        setUrl(next);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [item, pageIndex, zoom]);

  if (item.visual === 'none') {
    return (
      <Shell title={`原图 · ${item.fileName}`} onClose={onClose}>
        <p className="muted">
          这份文件里没有页面图像（XML / OFD 是结构化数据），没有原图可看。
        </p>
      </Shell>
    );
  }

  return (
    <Shell title={`原图 · ${item.fileName}`} onClose={onClose}>
      <div className="row-inline">
        <div className="seg" role="group" aria-label="缩放">
          {ZOOMS.map((z) => (
            <button
              key={z.value}
              type="button"
              aria-pressed={zoom === z.value}
              onClick={() => setZoom(z.value)}
            >
              {z.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="muted">
          {item.pageCount > 1 ? `第 ${pageIndex + 1} / ${item.pageCount} 页 · ` : ''}
          {busy ? '正在渲染…' : '放大后核对号码与金额'}
        </span>
      </div>

      <div className="viewer-stage">
        {error !== '' ? (
          <p className="warn">原图渲染失败：{error}</p>
        ) : url ? (
          <img className="viewer-img" src={url} alt="发票原图" />
        ) : (
          <p className="muted">正在渲染…</p>
        )}
      </div>
    </Shell>
  );
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal viewer" role="dialog" aria-label={title} aria-modal>
        <div className="drawer-head">
          {title}
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
}
