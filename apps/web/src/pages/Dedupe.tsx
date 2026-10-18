import { findDuplicates } from '@invoice-tool/core';
import { useMemo, useState } from 'react';

import { EmptyState } from '../components/EmptyState';
import { money } from '../lib/format';
import { useStore } from '../state/store';

/**
 * 查重页。
 *
 * 立场：**只给建议，不替用户删东西**。所有「跳过」都只是排版时的开关，
 * 原文件与列表项一直都在，随时可以「都保留」。
 * 疑似重复（销售方 + 金额 + 日期相同但号码不同）默认**不**跳过 ——
 * 同名同价同日的两张票是完全可能真实存在的（比如同一家店的两笔同额消费）。
 */
export function Dedupe() {
  const { state, dispatch } = useStore();
  const skipped = useMemo(() => new Set(state.skipped), [state.skipped]);

  /** 用户手动改过「留哪张」的分组（group 的 keep 换成另一个 id） */
  const [chosen, setChosen] = useState<Record<number, string>>({});

  const items = state.items;
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  const result = useMemo(() => findDuplicates(items.map((it) => it.invoice)), [items]);

  /** 每个分组的成员（保留的排第一） */
  const groups = useMemo(
    () =>
      result.groups.map((group, index) => {
        const members = [group.keep, ...group.drop];
        const keep = chosen[index] ?? group.keep;
        const ordered = [keep, ...members.filter((id) => id !== keep)];
        const drop = ordered.slice(1);
        const dropTotal = drop.reduce((sum, id) => sum + (byId.get(id)?.invoice.total ?? 0), 0);
        return { index, level: group.level, reason: group.reason, ordered, drop, dropTotal };
      }),
    [result.groups, chosen, byId],
  );

  const suspected = groups.filter((g) => g.level === 'suspected');
  const certain = groups.filter((g) => g.level !== 'suspected');

  const skippedCount = skipped.size;
  const skippedTotal = useMemo(
    () =>
      items.reduce((sum, it) => (skipped.has(it.id) ? sum + (it.invoice.total ?? 0) : sum), 0),
    [items, skipped],
  );

  const applyGroup = (ids: string[], keepId: string): void => {
    dispatch({ type: 'skip/many', ids: ids.filter((id) => id !== keepId), skip: true });
    dispatch({ type: 'skip/many', ids: [keepId], skip: false });
  };

  const keepAll = (ids: string[]): void => {
    dispatch({ type: 'skip/many', ids, skip: false });
  };

  if (items.length === 0) return <EmptyState dragOver={false} />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>查重</h1>
          <p className="page-sub">
            三层判定：文件相同 → 发票号码相同 → 疑似（销售方 + 金额 + 日期相同）。
            前两层可以放心跳过，疑似层只提示。
          </p>
        </div>
        <span className="spacer" />
        <div className="stat">
          <b>{skippedCount}</b>
          <span>张已跳过</span>
        </div>
        <div className="stat">
          <b>{money(skippedTotal)}</b>
          <span>不重复计入的金额</span>
        </div>
      </div>

      <div className="page-body">
        {groups.length === 0 && (
          <section className="card">
            <h2>没有发现重复</h2>
            <p className="muted">
              当前 {items.length} 张票两两之间没有相同的内容、号码，也没有「同销售方 + 同金额 + 同日期」的疑似组合。
            </p>
          </section>
        )}

        {certain.length > 0 && (
          <section className="card">
            <h2>
              确定重复
              <span className="count">{certain.length} 组</span>
            </h2>
            <p className="muted">
              同一张票导入了两次，或者同一张票的 PDF 与 OFD 各导入了一次。默认只留一张。
            </p>
            {certain.map((group) => (
              <div className="dupe" key={group.index}>
                <div className="dupe-head">
                  <span className="chip chip-ticket">{group.reason}</span>
                  <span className="spacer" />
                  <span className="muted">跳过可省 {money(group.dropTotal)}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => applyGroup(group.ordered, group.ordered[0]!)}
                  >
                    按建议跳过
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => keepAll(group.ordered)}
                  >
                    都保留
                  </button>
                </div>
                <ul className="dupe-list">
                  {group.ordered.map((id, i) => {
                    const item = byId.get(id);
                    if (!item) return null;
                    const isSkipped = skipped.has(id);
                    return (
                      <li key={id} className={i === 0 ? 'dupe-keep' : ''}>
                        <label>
                          <input
                            type="radio"
                            name={`keep-${group.index}`}
                            checked={i === 0}
                            onChange={() =>
                              setChosen((prev) => ({ ...prev, [group.index]: id }))
                            }
                          />
                          <span className="dupe-name">{item.invoice.fileName}</span>
                        </label>
                        <span className="dupe-meta">
                          {item.invoice.sellerName ?? '未识别销售方'} ·{' '}
                          {money(item.invoice.total ?? undefined)} · {item.invoice.issueDate ?? '无日期'}
                        </span>
                        <span className="spacer" />
                        <span className={isSkipped ? 'chip' : 'chip chip-special'}>
                          {isSkipped ? '打印时跳过' : '会打印'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}

        {suspected.length > 0 && (
          <section className="card">
            <h2>
              疑似重复
              <span className="count">{suspected.length} 组</span>
            </h2>
            <p className="muted">
              号码不同但销售方、金额、开票日期完全相同。可能真是两笔同额消费，也可能是同票不同号的老票换开 ——
              <b>默认都打印</b>，你看过票面再决定。
            </p>
            {suspected.map((group) => (
              <div className="dupe" key={group.index}>
                <div className="dupe-head">
                  <span className="chip chip-ticket">销售方 + 金额 + 日期相同</span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => applyGroup(group.ordered, group.ordered[0]!)}
                  >
                    只留第一张
                  </button>
                </div>
                <ul className="dupe-list">
                  {group.ordered.map((id) => {
                    const item = byId.get(id);
                    if (!item) return null;
                    return (
                      <li key={id}>
                        <label>
                          <input
                            type="radio"
                            name={`susp-${group.index}`}
                            checked={(chosen[group.index] ?? group.ordered[0]) === id}
                            onChange={() => setChosen((prev) => ({ ...prev, [group.index]: id }))}
                          />
                          <span className="dupe-name">{item.invoice.fileName}</span>
                        </label>
                        <span className="dupe-meta">
                          {item.invoice.invoiceNo ?? '无号码'} · {money(item.invoice.total ?? undefined)} ·{' '}
                          {item.invoice.issueDate ?? '无日期'}
                        </span>
                        <span className="spacer" />
                        <span className={skipped.has(id) ? 'chip' : 'chip chip-special'}>
                          {skipped.has(id) ? '打印时跳过' : '会打印'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>

      <div className="page-foot">
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'dedupe/undo' })}
          disabled={skippedCount === 0}
        >
          全部保留（清空跳过）
        </button>
        <span className="spacer" />
        <span className="muted">跳过只是不打印，文件与列表项都还在。</span>
      </div>
    </div>
  );
}
