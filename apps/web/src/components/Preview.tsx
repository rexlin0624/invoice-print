import type { LayoutSpec } from '@invoice-tool/core';
import { useEffect, useState } from 'react';

import { kindLabel, money } from '../lib/format';
import type { IntakeItem } from '../lib/intake';
import { sourcePage, sourcePages } from '../lib/pages';
import { imageThumbnailFor, thumbnailFor } from '../lib/thumb';
import { useStore } from '../state/store';

interface Props {
  spec: LayoutSpec;
  items: IntakeItem[];
  zoom: number;
  cutLines: boolean;
  /** 点槽位角上的「看原图」时回调（页下标是**源文件**的 0 基页号） */
  onOpenOriginal?: ((itemId: string, pageIndex: number) => void) | undefined;
}

export function Preview({ spec, items, zoom, cutLines, onOpenOriginal }: Props) {
  const byId = new Map(items.map((it) => [it.id, it]));

  if (spec.pages.length === 0) {
    return (
      <div className="preview">
        <p style={{ color: 'var(--muted)' }}>没有要打印的发票（可能都被跳过了）。</p>
      </div>
    );
  }

  return (
    <div className="preview">
      {spec.pages.map((page) => (
        <div className="sheet-wrap" key={page.index}>
          <div
            className="sheet"
            style={{ width: page.width * zoom, height: page.height * zoom }}
          >
            {page.slots.map((slot, i) => {
              const item = byId.get(slot.id);
              const padLeft = slot.contentX - slot.x;
              const padTop = slot.contentY - slot.y;
              const pageCount = item ? sourcePages(item).length : 1;
              return (
                <div
                  key={`${slot.id}-${i}`}
                  className={cutLines ? 'slot slot-cut' : 'slot'}
                  style={{
                    left: slot.x * zoom,
                    top: slot.y * zoom,
                    width: slot.w * zoom,
                    height: slot.h * zoom,
                    padding: `${padTop * zoom}px ${padLeft * zoom}px`,
                  }}
                >
                  {item ? (
                    item.visual === 'none' ? (
                      <InfoCard item={item} />
                    ) : (
                      <Thumb item={item} widthPt={slot.contentW} page={slot.page} />
                    )
                  ) : (
                    <div className="slot-missing">找不到这张票</div>
                  )}
                  {item && item.visual !== 'none' && onOpenOriginal && (
                    <button
                      type="button"
                      className="slot-zoom"
                      title="看原图（放大核对号码与金额）"
                      onClick={() => onOpenOriginal(item.id, sourcePage(item, slot.page))}
                    >
                      🔍
                    </button>
                  )}
                  {pageCount > 1 && (
                    <span className="slot-pages">
                      第 {slot.page + 1} / {pageCount} 页
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="sheet-label">
            第 {page.index + 1} / {spec.pageCount} 页
          </div>
        </div>
      ))}
    </div>
  );
}

function Thumb({ item, widthPt, page }: { item: IntakeItem; widthPt: number; page: number }) {
  const { dispatch } = useStore();
  const [src, setSrc] = useState<string>();
  const key = item.invoice.sha256 || item.id;
  const targetPx = Math.max(280, Math.round(widthPt * 2));
  const box = item.crop ?? undefined;

  useEffect(() => {
    let alive = true;
    // 页序 vs 源文件页号：明细页已被剔除，所以要换算（见 lib/pages.ts）
    const task =
      item.visual === 'image'
        ? imageThumbnailFor(key, item.data, targetPx, box)
        : thumbnailFor(key, item.data, targetPx, sourcePage(item, page), box);
    void task.then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [key, item.data, item.visual, page, targetPx, box]);

  if (!src) return <div className="sr-loading">渲染中…</div>;

  return (
    <img
      src={src}
      alt={item.invoice.fileName}
      draggable={false}
      onClick={() => dispatch({ type: 'select', id: item.id })}
    />
  );
}

/** XML / OFD 票没有可嵌入的页面，在预览里给出结构化摘要 */
function InfoCard({ item }: { item: IntakeItem }) {
  const inv = item.invoice;
  return (
    <div className="slot-card">
      <div className="t">
        {kindLabel(inv.kind)}
        {inv.businessTag ? ` · ${inv.businessTag}` : ''}
      </div>
      <div className="r">
        <b>销售方</b>
        <span>{inv.sellerName ?? '未识别'}</span>
      </div>
      <div className="r">
        <b>开票日期</b>
        <span>{inv.issueDate ?? '未识别'}</span>
      </div>
      <div className="r">
        <b>价税合计</b>
        <span>{money(inv.total ?? undefined)}</span>
      </div>
      <div className="r n">{inv.invoiceNo ?? '号码未识别'}</div>
    </div>
  );
}
