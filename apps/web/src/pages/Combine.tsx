import type { Invoice } from '@invoice-tool/core';
import { chooseInvoices, groupTotals } from '@invoice-tool/core';
import { useMemo, useState } from 'react';

import { money } from '../lib/format';
import { readBytes } from '../lib/library';
import { useIntake } from '../state/useIntake';
import { useLibrary, useLibraryLoad } from '../state/useLibrary';
import { toPrint, useStore } from '../state/store';

/** 「1000」「1,000.5」「￥1000」都能吃；解析不出来返回 undefined */
function parseYuan(text: string): number | undefined {
  const cleaned = text.replace(/[,\s￥¥]/g, '');
  if (cleaned === '') return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : undefined;
}

export function Combine() {
  const { state, dispatch } = useStore();
  const { intakeFromBytes, busy } = useIntake();
  useLibraryLoad();
  const library = useLibrary();

  const [source, setSource] = useState<'current' | 'library'>('current');
  const [targetText, setTargetText] = useState('');
  const [mode, setMode] = useState<'under' | 'nearest'>('under');
  const [maxCount, setMaxCount] = useState(30);
  const [toleranceText, setToleranceText] = useState('0');
  /** 用户手动剔掉的票（算法给的解不一定合意，得能改） */
  const [excluded, setExcluded] = useState<string[]>([]);
  const [added, setAdded] = useState<number | null>(null);

  const currentItems = useMemo(() => toPrint(state), [state]);
  const pool: Invoice[] = useMemo(
    () =>
      source === 'current'
        ? currentItems.map((it) => it.invoice)
        : library.map((r) => r.invoice),
    [source, currentItems, library],
  );

  const target = parseYuan(targetText);
  const tolerance = parseYuan(toleranceText) ?? 0;

  const result = useMemo(() => {
    if (target === undefined) return undefined;
    return chooseInvoices(pool, target, { mode, maxCount, tolerance: Math.max(0, tolerance), nodeBudget: 120_000 });
  }, [pool, target, mode, maxCount, tolerance]);

  const picked = useMemo(
    () => (result?.picked ?? []).filter((inv) => !excluded.includes(inv.id)),
    [result, excluded],
  );

  const sum = picked.reduce((acc, inv) => acc + (inv.total ?? 0), 0);
  const diff = target === undefined ? 0 : sum - target;
  const bySeller = useMemo(() => groupTotals(picked, 'seller').slice(0, 4), [picked]);

  /** 当前导入里的 id 才能直接「只打印这些」 */
  const inCurrent = useMemo(() => new Set(currentItems.map((it) => it.id)), [currentItems]);
  const pickedAllInCurrent = picked.length > 0 && picked.every((inv) => inCurrent.has(inv.id));

  const onlyPrint = (): void => {
    const ids = picked.map((inv) => inv.id);
    dispatch({ type: 'skip/many', ids: state.items.map((it) => it.id), skip: true });
    dispatch({ type: 'skip/many', ids, skip: false });
    dispatch({ type: 'view', view: 'merge' });
  };

  const addToImport = async (): Promise<void> => {
    const wanted = picked.map((inv) => inv.id);
    const records = library.filter((r) => wanted.includes(r.invoice.id));
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    for (const record of records) {
      const bytes = await readBytes(record.sha256);
      if (bytes && bytes.byteLength > 0) entries.push({ name: record.fileName, data: bytes });
    }
    if (entries.length === 0) {
      setAdded(0);
      return;
    }
    const items = await intakeFromBytes(entries);
    setAdded(items.length);
    setSource('current');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>凑票</h1>
          <p className="page-sub">
            给一个目标金额，从票里挑一组最贴近的组合。额度场景选「不超过」，对账场景选「最接近」。
          </p>
        </div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="票据来源">
          <button type="button" aria-pressed={source === 'current'} onClick={() => setSource('current')}>
            本次导入（{currentItems.length}）
          </button>
          <button type="button" aria-pressed={source === 'library'} onClick={() => setSource('library')}>
            已报销库（{library.length}）
          </button>
        </div>
      </div>

      <div className="page-body">
        <section className="card">
          <h2>目标</h2>
          <div className="form-grid">
            <label>
              <span>要凑到（元）</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="例如 3000"
                value={targetText}
                onChange={(e) => setTargetText(e.target.value)}
              />
            </label>
            <label>
              <span>口径</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'under' | 'nearest')}>
                <option value="under">不超过目标（报销额度）</option>
                <option value="nearest">最接近目标（对账）</option>
              </select>
            </label>
            <label>
              <span>最多几张</span>
              <input
                type="number"
                min={1}
                max={200}
                value={maxCount}
                onChange={(e) => setMaxCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
              />
            </label>
            <label>
              <span>容差（元）</span>
              <input
                type="text"
                inputMode="decimal"
                value={toleranceText}
                onChange={(e) => setToleranceText(e.target.value)}
              />
            </label>
          </div>
          {targetText !== '' && target === undefined && (
            <p className="muted">这个金额没看懂，试试「3000」或「3000.50」。</p>
          )}
        </section>

        {result && target !== undefined && (
          <section className="card">
            <h2>
              结果
              <span className="count">
                挑中 {picked.length} 张 · 合计 {money(sum)} ·{' '}
                {diff === 0 ? '正好' : diff < 0 ? `差 ${money(-diff)}` : `超 ${money(diff)}`}
                {Math.abs(diff) <= tolerance && diff !== 0 ? '（在容差内）' : ''}
              </span>
            </h2>

            {picked.length === 0 ? (
              <p className="muted">
                {pool.length === 0
                  ? '这一边没有带金额的票可以凑。'
                  : '没有凑出组合（可能被「最多几张」限制住了）。'}
              </p>
            ) : (
              <>
                <ul className="pick-list">
                  {picked.map((inv) => (
                    <li key={inv.id}>
                      <input
                        type="checkbox"
                        checked
                        onChange={() => setExcluded((prev) => [...prev, inv.id])}
                        aria-label={`去掉 ${inv.fileName}`}
                      />
                      <span className="pick-name">{inv.sellerName ?? inv.fileName}</span>
                      <span className="muted">{inv.issueDate ?? '无日期'}</span>
                      <span className="spacer" />
                      <b>{money(inv.total ?? undefined)}</b>
                    </li>
                  ))}
                </ul>

                {(result.budgetExhausted || excluded.length > 0) && (
                  <p className="muted">
                    {result.budgetExhausted ? '票太多，搜索提前收敛，这已经是很接近的一组。' : ''}
                    {excluded.length > 0 ? ` 你手动去掉了 ${excluded.length} 张。` : ''}
                    {excluded.length > 0 && (
                      <>
                        {' '}
                        <button type="button" className="link" onClick={() => setExcluded([])}>
                          恢复
                        </button>
                      </>
                    )}
                  </p>
                )}

                {bySeller.length > 0 && (
                  <div className="pick-groups">
                    {bySeller.map((row) => (
                      <span key={row.key} className="pick-group">
                        {row.key} × {row.count} · {money(row.total)}
                      </span>
                    ))}
                  </div>
                )}

                <div className="row-inline">
                  {pickedAllInCurrent ? (
                    <button type="button" className="btn btn-primary" onClick={onlyPrint}>
                      只打印这 {picked.length} 张
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || source === 'current'}
                      onClick={() => void addToImport()}
                    >
                      {busy ? '正在载入…' : '把这组加进本次导入'}
                    </button>
                  )}
                  <span className="spacer" />
                  {added !== null && (
                    <span className="muted">
                      {added === 0 ? '库里没有这些票的原文件，无法加入。' : `已加入 ${added} 张，去「合并打印」看结果。`}
                    </span>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        <section className="card">
          <h2>核对</h2>
          <p className="muted">
            算法给的是建议，不是结论。票据张数、销售方、日期都在上面列着，付款前自己再过一眼。
            {mode === 'under' ? ' 「不超过」保证不会超出额度。' : ''}
          </p>
        </section>
      </div>
    </div>
  );
}
