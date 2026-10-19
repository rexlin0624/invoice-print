import type { CorrectPatch } from '@invoice-tool/core';
import {
  applyCorrection,
  buildLayout,
  recognitionRate,
  summarizeBatch,
  summaryText,
  worstLevel,
} from '@invoice-tool/core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CorrectDialog } from '../components/CorrectDialog';
import { EmptyState } from '../components/EmptyState';
import { InvoicePanel } from '../components/InvoicePanel';
import { PageViewer, viewerSourceOf } from '../components/PageViewer';
import { Preview } from '../components/Preview';
import { PrinterIcon } from '../components/icons';
import type { Box } from '../lib/box';
import type { IntakeItem } from '../lib/intake';
import { alreadyHandled, updateInvoiceFields } from '../lib/library';
import { anyCropped, layoutItems } from '../lib/pages';
import { saveBytes, revealSaved, saveText } from '../lib/save';
import { isDesktop, openPath } from '../lib/shell';
import { money } from '../lib/format';
import { tally, toPrint, useProblems, useStore } from '../state/store';
import { useLibrary } from '../state/useLibrary';

export function MergePrint() {
  const { state, dispatch } = useStore();
  const problems = useProblems();
  const [composing, setComposing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const skipped = useMemo(() => new Set(state.skipped), [state.skipped]);
  const printItems = useMemo(() => toPrint(state), [state]);

  // 本机库里已经报过的票：提前提醒，避免重复报销。library 变一次就重算一次。
  const library = useLibrary();
  const repeatRisk = useMemo(
    () =>
      printItems
        .map((it) => ({ item: it, hit: alreadyHandled(it.invoice, it.invoice.sha256) }))
        .filter((row) => row.hit?.mark === 'reimbursed'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [printItems, library],
  );

  /**
   * 有票被裁过白边就不再旋转。
   * 裁剪后再旋转，槽位与裁剪区的换算有两层变换，容易出错；而旋转只是省纸的小优化。
   */
  const settings = useMemo(
    () =>
      anyCropped(printItems)
        ? { ...state.settings, allowRotation: false }
        : state.settings,
    [printItems, state.settings],
  );

  const spec = useMemo(
    () => buildLayout(layoutItems(printItems), settings),
    [printItems, settings],
  );

  // ---- 裁掉白边：开关打开后，惰性探测每张票的内容边界 ----
  const cropsWanted = state.settings.cropWhitespace;
  /**
   * 还没探测过的票。注意 `undefined` 才是「没探测」，
   * `null` 是「探测过、不需要裁」（见 `IntakeItem.crop` 三态）——
   * 早先只有 undefined 表示不裁，于是探测超时/判无白边的票永远算「没探测」，
   * effect 每轮都重跑，进度永远停在「正在识别白边…」。
   */
  const pendingCropIds = useMemo(
    () =>
      cropsWanted
        ? state.items
            .filter((it) => it.crop === undefined && it.visual !== 'none')
            .map((it) => it.id)
        : [],
    [cropsWanted, state.items],
  );
  /**
   * 依赖用**稳定的字符串 key**，不要把数组直接放进 deps：
   * `state.items` 每次「标记 / 跳过 / 库同步」都会换引用，
   * 数组进 deps 会让 effect 被无谓地取消重跑 —— 探测到一半的结果存不进去，
   * 进度文字也会留在屏幕上。
   */
  const pendingCropKey = pendingCropIds.join(',');

  const itemsRef = useRef(state.items);
  itemsRef.current = state.items;

  useEffect(() => {
    const ids = pendingCropKey === '' ? [] : pendingCropKey.split(',');
    if (ids.length === 0) return;
    let alive = true;
    setProgress('正在识别白边…');
    void (async () => {
      try {
        const { detectBoxFor } = await import('../lib/detect');
        const crops: Record<string, Box | null | undefined> = {};
        for (const id of ids) {
          const item = itemsRef.current.find((it) => it.id === id);
          if (item) crops[id] = await detectBoxFor(item);
        }
        if (alive) dispatch({ type: 'crop/set', crops });
      } finally {
        if (alive) setProgress(null);
      }
    })();
    return () => {
      alive = false;
      // 被取消（清空 / 关开关 / 换页）也要把进度收掉，别留一行「正在识别白边…」
      setProgress(null);
    };
  }, [pendingCropKey, dispatch]);

  useEffect(() => {
    if (!cropsWanted) dispatch({ type: 'crop/clear' });
  }, [cropsWanted, dispatch]);

  // 让 A4 正好铺满舞台宽度
  const stageRef = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(0.62);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = (): void => {
      const available = el.clientWidth - 40;
      const raw = spec.paperWidth > 0 ? available / spec.paperWidth : 0.62;
      setZoom(Math.min(Math.max(raw, 0.24), 0.92));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [spec.paperWidth]);

  /**
   * 「已裁白边」不能只看开关：开关打开只代表**想要**裁。
   * 探测可能得出「本来就没白边」或者失败（`IntakeItem.crop` 是三态）。
   * 开关写着已裁、实际没裁，用户会以为省了纸 —— 所以这里如实说发生了什么。
   */
  const cropHint = useMemo(() => {
    if (!state.settings.cropWhitespace) return '';
    if (anyCropped(printItems)) return ' · 已裁白边';
    if (printItems.some((it) => it.crop === undefined)) return ' · 白边探测中…';
    return ' · 无白边可裁';
  }, [state.settings.cropWhitespace, printItems]);

  const errorCount = printItems.filter((it) => worstLevel(problems.get(it.id) ?? []) === 'error').length;
  const warnCount = printItems.filter((it) => worstLevel(problems.get(it.id) ?? []) === 'warn').length;
  const marks = tally(state.marks, printItems);
  const everPrinted = marks.printed + marks.reimbursed > 0;

  // 汇总：口径在内核里只有一份（缺金额不算 0 元，缺了单独计数）
  const summary = useMemo(
    () => summarizeBatch(printItems.map((it) => it.invoice)),
    [printItems],
  );

  /** 正在校正的那张票（弹窗开着时非空） */
  const correcting = useMemo(
    () => state.items.find((it) => it.id === state.correctingId) ?? null,
    [state.items, state.correctingId],
  );

  /** 正在看原图的那张票（预览里点 🔍 打开） */
  const [viewing, setViewing] = useState<{ item: IntakeItem; pageIndex: number } | null>(null);

  /**
   * 「复制统计」：这段文字是贴进群里对账用的。
   *
   * 剪贴板 API 在非安全上下文里直接不可用（file:// 打开网页版时就是这样），
   * 所以失败要退回「存成文本文件」—— 不能给一个点了没反应的按钮。
   */
  const copySummary = (): void => {
    const text = summaryText(summary, { title: '本次打印汇总' });
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        dispatch({ type: 'toast', toast: { text: '汇总已复制到剪贴板', actions: [] } });
      } catch {
        await saveText(text, `发票汇总-${new Date().toISOString().slice(0, 10)}.txt`, { bom: true });
        dispatch({
          type: 'toast',
          toast: { text: '这个环境不让写剪贴板，已经存成文本文件了', actions: [] },
        });
      }
    })();
  };

  /**
   * 保存校正。
   *
   * 落到两处，缺一处就会「界面改了、库里还是旧的」：
   * - state（本次导入的票，去重与打印立刻按新值算）
   * - 已报销库（这张票要是已经在库里，字段得跟着更新，否则「再打一份」打出旧数据）
   */
  const saveCorrection = (patch: CorrectPatch): void => {
    if (!correcting) return;
    const id = correcting.id;
    const sha = correcting.invoice.sha256;
    const next = applyCorrection(correcting.invoice, patch);
    dispatch({ type: 'correct', id, patch });
    dispatch({ type: 'correcting', id: null });
    // 库里也要跟着更新，否则「再打一份」打出来的还是旧字段（没入库的票静默跳过）
    void updateInvoiceFields(sha, next).catch(() => undefined);
  };

  const compose = async (mode: 'print' | 'download'): Promise<void> => {
    if (printItems.length === 0 || composing) return;
    setComposing(true);
    try {
      const { composePrintPdf, printPdf } = await import('../lib/print');
      const rasterized = state.settings.rasterCompat || state.settings.blackWhite;
      const { bytes } = await composePrintPdf(printItems, spec, {
        cutLines: state.settings.cutLines,
        pageNumbers: state.settings.pageNumbers,
        rasterCompat: state.settings.rasterCompat,
        blackWhite: state.settings.blackWhite,
        onProgress: rasterized
          ? (done, total) => setProgress(`正在转成图片 ${done}/${total} 页…`)
          : undefined,
      });
      setProgress(null);

      // 签名字节有点长，但这里就是「点一下就把事情做完」的地方，拆开反而更难读
      const ids = printItems.map((it) => it.id);

      if (mode === 'download') {
        const outcome = await saveBytes(bytes, '发票合并打印.pdf', {
          mime: 'application/pdf',
          filter: 'pdf',
        });
        // 桌面版才知道存到哪儿了 —— 顺带给一个「在文件夹里显示」
        if (outcome.path) {
          dispatch({
            type: 'toast',
            toast: {
              text: `已保存：${outcome.name}`,
              actions: [
                { label: '在文件夹里显示', primary: true, run: () => revealSaved(outcome.path) },
                { label: '好', run: () => undefined },
              ],
            },
          });
        }
        return;
      }

      const result = await printPdf(bytes, '发票合并打印.pdf');

      if (!result.ok) {
        // 打印没成：告诉用户为什么，并给一条「自己打」的出路 —— 不要死胡同
        dispatch({
          type: 'toast',
          toast: {
            text: result.message,
            actions: [
              ...(result.path
                ? [
                    {
                      label: '用系统程序打开',
                      primary: true,
                      run: () => {
                        void openPath(result.path as string).catch(() => undefined);
                      },
                    },
                  ]
                : []),
              { label: '好', run: () => undefined },
            ],
          },
        });
        return;
      }

      dispatch({ type: 'printed', ids });
      // 桌面上报一下交给了哪台打印机（toast 只有一个，后面「标记已报销」会盖掉它 —— 报销更重要）
      if (result.message && isDesktop()) {
        dispatch({
          type: 'toast',
          toast: { text: result.message, actions: [{ label: '好', run: () => undefined }] },
        });
      }
      if (state.prefs.remindReimburse) {
        dispatch({
          type: 'toast',
          toast: {
            text: `要把这 ${printItems.length} 张标记为已报销吗？下次导入重复的会提醒你。`,
            actions: [
              {
                label: '标记已报销',
                primary: true,
                run: () => dispatch({ type: 'reimbursed', ids }),
              },
              { label: '不用了', run: () => undefined },
            ],
          },
        });
      }
    } catch (err) {
      dispatch({
        type: 'toast',
        toast: {
          text: `生成打印文件失败：${err instanceof Error ? err.message : String(err)}`,
          actions: [{ label: '好', run: () => undefined }],
        },
      });
    } finally {
      setProgress(null);
      setComposing(false);
    }
  };

  if (state.items.length === 0) return <EmptyState dragOver={false} />;

  return (
    <div className="workspace">
      <InvoicePanel items={state.items} problems={problems} skipped={skipped} />

      <main className="stage" ref={stageRef}>
        <div className="toolbar">
          <span className="tool-label">每页</span>
          <div className="seg" role="group" aria-label="每页张数">
            {([1, 2, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={state.settings.perPage === n}
                onClick={() => dispatch({ type: 'perPage', perPage: n })}
              >
                {n} 张
              </button>
            ))}
          </div>
          <span className="paper-hint">
            A4 · {spec.orientation === 'portrait' ? '竖向' : '横向'}
            {state.settings.orientation === 'auto' ? '（自动）' : ''} · 共 {spec.pageCount} 页
            {state.settings.blackWhite ? ' · 黑白' : ''}
            {cropHint}
          </span>

          <span className="spacer" />

          {progress !== null && <span className="working">{progress}</span>}
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: 'drawer', open: true })}
          >
            ⚙ 更多设置
          </button>
          <button
            type="button"
            className="btn"
            disabled={composing || printItems.length === 0}
            onClick={() => void compose('download')}
          >
            ⬇ 下载 PDF
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={composing || printItems.length === 0}
            onClick={() => void compose('print')}
          >
            <PrinterIcon />
            {composing ? '生成中…' : everPrinted ? '再次打印' : `打印 ${spec.pageCount} 页`}
          </button>
        </div>

        {printItems.length > 0 && (
          <div className="summary-bar">
            <span>
              本次打印 {summary.count} 张 · 合计 <b>{money(summary.amountTotal)}</b>
              {summary.missingAmount > 0 && <span className="muted">（{summary.missingAmount} 张没金额）</span>}
            </span>
            <span className="sep">|</span>
            <span>
              已识别号码 {summary.recognized}/{summary.count}（
              {Math.round(recognitionRate(summary) * 100)}%）
            </span>
            {summary.missingNo > 0 && (
              <>
                <span className="sep">|</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    const first = printItems.find((it) => !it.invoice.invoiceNo);
                    if (first) dispatch({ type: 'correcting', id: first.id });
                  }}
                >
                  {summary.missingNo} 张要补录
                </button>
              </>
            )}
            <span className="spacer" />
            <button type="button" className="link" onClick={copySummary}>
              复制统计
            </button>
          </div>
        )}

        {skipped.size > 0 && !state.dedupeUndone && (
          <div className="banner">
            <span>
              已自动跳过 {skipped.size} 张重复发票
              {state.dedupeGroups[0] ? `（${state.dedupeGroups[0].reason}）` : ''}
            </span>
            <span className="spacer" />
            <button type="button" className="link" onClick={() => dispatch({ type: 'dedupe/undo' })}>
              撤销，全部打印
            </button>
          </div>
        )}

        {repeatRisk.length > 0 && (
          <div className="banner warn">
            <span>
              其中 {repeatRisk.length} 张在你的已报销库里（
              {repeatRisk
                .slice(0, 2)
                .map((row) => row.item.invoice.invoiceNo ?? row.item.invoice.fileName)
                .join('、')}
              {repeatRisk.length > 2 ? ' 等' : ''}
              ），留意别重复报销。
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="link"
              onClick={() => dispatch({ type: 'view', view: 'library' })}
            >
              去库里看
            </button>
          </div>
        )}

        {errorCount + warnCount > 0 && (
          <div className="banner warn">
            <span>
              {errorCount > 0 ? `${errorCount} 张票有问题` : `${warnCount} 张票需要确认`}
              ，点列表里的 ⓘ 看明细。
            </span>
            <span className="spacer" />
          </div>
        )}

        <Preview
          spec={spec}
          items={printItems}
          zoom={zoom}
          cutLines={state.settings.cutLines}
          onOpenOriginal={(itemId, pageIndex) => {
            const item = printItems.find((it) => it.id === itemId);
            if (item) setViewing({ item, pageIndex });
          }}
        />
      </main>

      {viewing && (
        <PageViewer
          item={viewerSourceOf(viewing.item)}
          pageIndex={viewing.pageIndex}
          onClose={() => setViewing(null)}
        />
      )}

      {correcting && (
        <CorrectDialog
          invoice={correcting.invoice}
          // XML / OFD 没有「原图」可看（只有结构化字段），别给一个点了会报错的按钮
          source={
            correcting.visual === 'none'
              ? undefined
              : () => Promise.resolve(viewerSourceOf(correcting))
          }
          onSave={saveCorrection}
          onClose={() => dispatch({ type: 'correcting', id: null })}
        />
      )}
    </div>
  );
}
