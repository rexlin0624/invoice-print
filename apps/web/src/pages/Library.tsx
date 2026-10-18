import type { LibraryRecord } from '../lib/library';
import {
  clearLibrary,
  readBytes,
  removeFromLibrary,
  setMark,
  statsOf,
} from '../lib/library';
import { saveBytes, saveText } from '../lib/save';
import { pushBackup } from '../lib/libraryBackup';
import { formatBytes, money } from '../lib/format';
import { useIntake } from '../state/useIntake';
import { useLibrary, useLibraryLoad } from '../state/useLibrary';
import { useLibraryBackup } from '../state/useLibraryBackup';
import { useStore } from '../state/store';
import { buildExportTable, tableToCsv } from '@invoice-tool/core';
import { useMemo, useState } from 'react';

function dayOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type MarkFilter = 'all' | 'printed' | 'reimbursed';

export function Library() {
  const { intakeFromBytes, busy } = useIntake();
  const { dispatch } = useStore();
  useLibraryLoad();
  const records = useLibrary();
  const backup = useLibraryBackup();

  const [query, setQuery] = useState('');
  const [markFilter, setMarkFilter] = useState<MarkFilter>('all');
  const [month, setMonth] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);

  const months = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) if (r.invoice.issueDate) set.add(r.invoice.issueDate.slice(0, 7));
    return [...set].sort().reverse();
  }, [records]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((r) => {
      if (markFilter !== 'all' && r.mark !== markFilter) return false;
      if (month !== 'all' && (r.invoice.issueDate?.slice(0, 7) ?? '') !== month) return false;
      if (!needle) return true;
      const hay = [
        r.fileName,
        r.invoice.invoiceNo ?? '',
        r.invoice.sellerName ?? '',
        r.invoice.buyerName ?? '',
        r.invoice.businessTag ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [records, query, markFilter, month]);

  const stats = useMemo(() => statsOf(records), [records]);
  const shown = useMemo(() => statsOf(filtered), [filtered]);

  const table = useMemo(
    () =>
      buildExportTable(
        filtered.map((r) => r.invoice),
        {
          fields: ['issueDate', 'invoiceNo', 'kind', 'sellerName', 'total', 'mark', 'fileName'],
          marks: Object.fromEntries(filtered.map((r) => [r.invoice.id, r.mark])),
          totalsLabel: `合计 ${filtered.length} 条`,
          caption: `已报销库导出 · 共 ${filtered.length} 条 · ${dayOf(Date.now())}`,
        },
      ),
    [filtered],
  );

  const toggleMark = async (record: LibraryRecord): Promise<void> => {
    await setMark([record.sha256], record.mark === 'reimbursed' ? 'printed' : 'reimbursed');
    void pushBackup();
  };

  const remove = async (record: LibraryRecord): Promise<void> => {
    await removeFromLibrary([record.sha256]);
    void pushBackup();
    dispatch({
      type: 'toast',
      toast: {
        text: `已从本机库删除「${record.invoice.fileName}」（不影响你磁盘上的原文件）。`,
        actions: [{ label: '好', run: () => undefined }],
      },
    });
  };

  const download = async (record: LibraryRecord): Promise<void> => {
    const bytes = await readBytes(record.sha256);
    if (!bytes || bytes.byteLength === 0) {
      window.alert('这一条没存原文件（可能是在旧版本里记下的），无法下载。');
      return;
    }
    const isPdf = record.visual === 'pdf';
    const mime = isPdf
      ? 'application/pdf'
      : record.visual === 'image'
        ? 'image/*'
        : 'application/octet-stream';
    try {
      await saveBytes(bytes, record.fileName, { mime, filter: isPdf ? 'pdf' : undefined });
    } catch (err) {
      window.alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loadInto = async (list: readonly LibraryRecord[]): Promise<void> => {
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    for (const record of list) {
      const bytes = await readBytes(record.sha256);
      if (bytes && bytes.byteLength > 0) entries.push({ name: record.fileName, data: bytes });
    }
    if (entries.length === 0) {
      window.alert('这些记录里没有原文件，无法加入。');
      return;
    }
    await intakeFromBytes(entries);
    dispatch({ type: 'view', view: 'merge' });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>已报销库</h1>
          <p className="page-sub">
            存在这台电脑的浏览器数据库里（不上传）。记录票据信息与原文件，所以能搜索、能再打一份。
          </p>
        </div>
        <span className="spacer" />
        <div className="stat">
          <b>{stats.count}</b>
          <span>条记录 · {formatBytes(stats.bytes)}</span>
        </div>
        <div className="stat">
          <b>{stats.reimbursed}</b>
          <span>已报销 · {money(stats.total)}</span>
        </div>
      </div>

      <div className="page-body">
        <section className="card">
          <div className="row-inline">
            <input
              type="search"
              className="grow"
              placeholder="搜文件名 / 发票号码 / 销售方 / 购买方"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="seg" role="group" aria-label="状态筛选">
              {(
                [
                  ['all', '全部'],
                  ['reimbursed', '已报销'],
                  ['printed', '已打印'],
                ] as Array<[MarkFilter, string]>
              ).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={markFilter === value} onClick={() => setMarkFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
            <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="开票月份">
              <option value="all">所有月份</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="row-inline">
            <span className="muted">
              筛选出 {filtered.length} 条 · 金额 {money(shown.total)} · 已报销 {shown.reimbursed} 条
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm"
              disabled={filtered.length === 0}
              onClick={() => {
                void saveText(tableToCsv(table), `已报销库-${dayOf(Date.now())}.csv`, {
                  filter: 'csv',
                }).catch((err: unknown) =>
                  window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`),
                );
              }}
            >
              导出筛选结果 CSV
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={filtered.length === 0 || busy}
              onClick={() => void loadInto(filtered)}
            >
              加进本次导入
            </button>
          </div>
        </section>

        {/* 有情况才出现：桌面版每次库变动都会留一份清单备份，库被清过就能看出来 */}
        {backup.missing.length > 0 && (
          <section className="card">
            <h2>本机备份里有 {backup.missing.length} 条不在这个库里</h2>
            <p className="muted">
              备份在应用数据目录里（帮助 → 打开数据目录），不受「清浏览数据」影响。
              恢复只补记录与报销状态；原文件字节不在备份里，恢复出来的记录不能「再打一份」。
            </p>
            <div className="row-inline">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={backup.restoring}
                onClick={() => {
                  void backup.restore().then((count) =>
                    dispatch({
                      type: 'toast',
                      toast: {
                        text: `从备份恢复了 ${count} 条记录。`,
                        actions: [{ label: '好', run: () => undefined }],
                      },
                    }),
                  );
                }}
              >
                {backup.restoring ? '恢复中…' : '从备份恢复'}
              </button>
            </div>
          </section>
        )}

        {records.length === 0 ? (
          <section className="card">
            <h2>还是空的</h2>
            <p className="muted">
              在「合并打印」页点打印后，选择「标记已报销」，这些票就会自动进库。
              之后导入重复的票时会提前提醒你「这张上次已经报过了」。
            </p>
          </section>
        ) : filtered.length === 0 ? (
          <section className="card">
            <h2>没有符合条件的记录</h2>
            <p className="muted">换个关键词，或把筛选切回「全部」。</p>
          </section>
        ) : (
          <section className="card">
            <table className="dtable">
              <thead>
                <tr>
                  <th>开票日期</th>
                  <th>发票号码</th>
                  <th>票种</th>
                  <th>销售方</th>
                  <th>价税合计</th>
                  <th>状态</th>
                  <th>入库时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => (
                  <tr key={record.sha256}>
                    <td>{record.invoice.issueDate ?? '—'}</td>
                    <td>{record.invoice.invoiceNo ?? '—'}</td>
                    <td>{record.invoice.businessTag ?? record.invoice.kind}</td>
                    <td className="ellipsis" title={record.invoice.sellerName ?? ''}>
                      {record.invoice.sellerName ?? '—'}
                    </td>
                    <td data-num="true">{money(record.invoice.total ?? undefined)}</td>
                    <td>
                      <button
                        type="button"
                        className={record.mark === 'reimbursed' ? 'mark-chip ok' : 'mark-chip'}
                        onClick={() => void toggleMark(record)}
                        title="点一下切换状态"
                      >
                        {record.mark === 'reimbursed' ? '已报销' : '已打印'}
                      </button>
                    </td>
                    <td className="muted">{dayOf(record.at)}</td>
                    <td className="row-actions">
                      <button type="button" className="link" onClick={() => void download(record)}>
                        下载
                      </button>
                      <button type="button" className="link" onClick={() => void loadInto([record])}>
                        再打一份
                      </button>
                      <button type="button" className="link danger" onClick={() => void remove(record)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {records.length > 0 && (
          <section className="card">
            <h2>清理</h2>
            <p className="muted">
              库里现在存着 {formatBytes(stats.bytes)} 的原文件。删掉记录不会删你磁盘上的发票原件。
            </p>
            <div className="row-inline">
              {confirmClear ? (
                <>
                  <span>确定清空整个库？这一步不可撤销。</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      // 刻意不 push 空的备份：备份是保险，别被一次误清空带走
                      void clearLibrary();
                      setConfirmClear(false);
                    }}
                  >
                    确定清空
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirmClear(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => setConfirmClear(true)}>
                  清空整个库
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
