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
import { FALLBACK_HINT } from '../lib/fallback';
import { previewFallbacks } from '../lib/fallback';
import type { IntakeItem } from '../lib/intake';
import { alreadyHandled, updateInvoiceFields } from '../lib/library';
import { anyCropped, layoutItems } from '../lib/pages';
import { rememberedPrinter } from '../lib/printer';
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

  /**
   * 印不成票面原样、会退化成信息卡的票（OFD / XML / 解析失败）。
   *
   * 这些票**必须在出纸之前**说清楚：早先它们被静默画成信息卡，用户贴报销单时
   * 才发现拿到手的不是发票。横幅常驻 + 打印前再确认一次。
   */
  const fallbacks = useMemo(() => previewFallbacks(printItems), [printItems]);
  const fallbackKey = fallbacks.map((f) => f.id).join(',');
  /** 同一批票只确认一次：用户点过「仍然打印」之后不该每次再问 */
  const ackedFallbacks = useRef('');

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

  const runCompose = async (mode: 'print' | 'download'): Promise<void> => {
    if (printItems.length === 0 || composing) return;
    setComposing(true);
    try {
      const { composePrintPdf, printPdf } = await import('../lib/print');
      const rasterized = state.settings.rasterCompat || state.settings.blackWhite;
      const composed = await composePrintPdf(printItems, spec, {
        cutLines: state.settings.cutLines,
        pageNumbers: state.settings.pageNumbers,
        rasterCompat: state.settings.rasterCompat,
        blackWhite: state.settings.blackWhite,
        onProgress: rasterized
          ? (done, total) => setProgress(`正在转成图片 ${done}/${total} 页…`)
          : undefined,
      });
      const bytes = composed.bytes;
      setProgress(null);

      /**
       * 合成之后才知道的降级（是 PDF 但没嵌进去）—— 打印前那份清单里没有它。
       * 这种是意外，得当场说，用户要靠「老打印机兼容」自救。
       */
      const unexpected = composed.fallbacks.filter((f) => f.reason === 'embed-failed');
      const surprise =
        unexpected.length > 0
          ? `其中 ${unexpected.length} 张票面没嵌进去，打成了信息卡，试试勾上「老打印机兼容」再打一次`
          : '';

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
              text: surprise ? `已保存：${outcome.name}（${surprise}）` : `已保存：${outcome.name}`,
              actions: [
                { label: '在文件夹里显示', primary: true, run: () => revealSaved(outcome.path) },
                { label: '好', run: () => undefined },
              ],
            },
          });
        }
        return;
      }

      // 桌面版：发到用户在设置里选的那台打印机（没选就跟随系统、弹打印对话框）
      const result = await printPdf(bytes, '发票合并打印.pdf', rememberedPrinter() || undefined);

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
      if (result.message && (isDesktop() || surprise)) {
        dispatch({
          type: 'toast',
          toast: {
            text: surprise ? `${result.message}；${surprise}` : result.message,
            actions: [{ label: '好', run: () => undefined }],
          },
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

  const compose = async (mode: 'print' | 'download'): Promise<void> => {
    if (printItems.length === 0 || composing) return;

    /**
     * 有票印不成票面：先问一句再出纸。
     *
     * 「出纸之后再说」是没有意义的 —— 那时纸已经打出来了。这里给两条出路：
     * 继续（用户就是要这张信息卡当凭证摘要）或剔除（多数时候 OFD 打信息卡没意义）。
     * 同一批票只问一次，否则每次点打印都要多一次点击。
     */
    if (fallbacks.length > 0 && ackedFallbacks.current !== fallbackKey) {
      const reasons = new Set(fallbacks.map((f) => f.reason));
      const why =
        reasons.size === 1 && fallbacks[0]
          ? FALLBACK_HINT[fallbacks[0].reason]
          : '没有可打印的票面';
      dispatch({
        type: 'toast',
        toast: {
          text: `其中 ${fallbacks.length} 张${why}，打出来的是信息卡（只有号码 / 金额 / 日期），不是发票原样。`,
          actions: [
            {
              label: mode === 'print' ? '仍然打印' : '仍然下载',
              primary: true,
              run: () => {
                ackedFallbacks.current = fallbackKey;
                void runCompose(mode);
              },
            },
            {
              label: '剔除这些票',
              run: () => {
                dispatch({ type: 'skip/many', ids: fallbacks.map((f) => f.id), skip: true });
                dispatch({ type: 'toast', toast: null });
              },
            },
          ],
        },
      });
      return;
    }

    await runCompose(mode);
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
              {summary.redCount > 0 && (
                <span className="muted">
                  （含红冲 {summary.redCount} 张 -{money(summary.redTotal)}，已抵扣）
                </span>
              )}
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

        {fallbacks.length > 0 && (
          <div className="banner warn">
            <span>
              其中 {fallbacks.length} 张没有票面（
              {new Set(fallbacks.map((f) => f.reason)).size === 1 && fallbacks[0]
                ? FALLBACK_HINT[fallbacks[0].reason]
                : '原因不止一种'}
              ），打印出来的是<b>信息卡</b>，不是发票原样。
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="link"
              onClick={() =>
                dispatch({ type: 'skip/many', ids: fallbacks.map((f) => f.id), skip: true })
              }
            >
              从本次打印中剔除
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
