import type { ExportField } from '@invoice-tool/core';
import { EXPORT_COLUMNS } from '@invoice-tool/core';

import { DataTable } from '../components/DataTable';
import { saveBytes, saveText } from '../lib/save';
import { useLibraryLoad, useLibrary } from '../state/useLibrary';
import { toPrint, useStore } from '../state/store';
import { useEffect, useMemo, useState } from 'react';
import { buildExportTable, tableToCsv } from '@invoice-tool/core';

const FIELDS_KEY = 'invoice-tool.export.fields.v1';

function loadFields(): ExportField[] {
  try {
    const raw = window.localStorage.getItem(FIELDS_KEY);
    if (!raw) return EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.field);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.field);
    }
    const known = new Set(EXPORT_COLUMNS.map((c) => c.field));
    const valid = parsed.filter((f): f is ExportField => typeof f === 'string' && known.has(f as ExportField));
    return valid.length > 0 ? valid : EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.field);
  } catch {
    return EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.field);
  }
}

type Scope = 'current' | 'library';

export function Excel() {
  const { state } = useStore();
  useLibraryLoad();
  const library = useLibrary();

  const [scope, setScope] = useState<Scope>('current');
  const [fields, setFields] = useState<ExportField[]>(loadFields);
  const [withTotals, setWithTotals] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(FIELDS_KEY, JSON.stringify(fields));
    } catch {
      /* 隐私模式忽略 */
    }
  }, [fields]);

  const items = useMemo(() => toPrint(state), [state]);
  const currentTable = useMemo(
    () =>
      buildExportTable(
        items.map((it) => it.invoice),
        { fields, marks: state.marks, includeTotals: withTotals },
      ),
    [items, fields, state.marks, withTotals],
  );

  const libraryTable = useMemo(
    () =>
      buildExportTable(
        library.map((r) => r.invoice),
        {
          fields,
          marks: Object.fromEntries(library.map((r) => [r.invoice.id, r.mark])),
          includeTotals: withTotals,
          totalsLabel: `已报销 ${library.filter((r) => r.mark === 'reimbursed').length} 张`,
          caption: `本机已报销库 · 共 ${library.length} 条 · 导出时间 ${new Date().toLocaleString('zh-CN')}`,
        },
      ),
    [library, fields, withTotals],
  );

  const table = scope === 'current' ? currentTable : libraryTable;
  const empty = scope === 'current' ? items.length === 0 : library.length === 0;

  const toggle = (field: ExportField): void => {
    setFields((prev) => (prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]));
  };

  const download = async (kind: 'xlsx' | 'csv'): Promise<void> => {
    if (table.rows.length === 0 || busy) return;
    setBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `发票汇总-${scope === 'library' ? '已报销库' : '本次导入'}-${stamp}`;
      if (kind === 'csv') {
        await saveText(tableToCsv(table), `${name}.csv`, { filter: 'csv' });
      } else {
        const { tableToXlsx } = await import('../lib/xlsx');
        const bytes = await tableToXlsx(table, { caption: table.caption });
        await saveBytes(bytes, `${name}.xlsx`, {
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filter: 'xlsx',
        });
      }
    } catch (err) {
      window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>转 Excel</h1>
          <p className="page-sub">
            勾选要的列，直接导出 .xlsx（也能导 CSV）。金额是数字能直接求和，发票号码是文本不会变成科学计数法。
          </p>
        </div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="导出范围">
          <button type="button" aria-pressed={scope === 'current'} onClick={() => setScope('current')}>
            本次导入（{items.length}）
          </button>
          <button type="button" aria-pressed={scope === 'library'} onClick={() => setScope('library')}>
            已报销库（{library.length}）
          </button>
        </div>
      </div>

      <div className="page-body">
        <section className="card">
          <h2>要哪些列</h2>
          <div className="checks">
            {EXPORT_COLUMNS.map((column) => (
              <label key={column.field} className="check">
                <input
                  type="checkbox"
                  checked={fields.includes(column.field)}
                  onChange={() => toggle(column.field)}
                />
                {column.label}
              </label>
            ))}
          </div>
          <div className="row-inline">
            <label className="check">
              <input
                type="checkbox"
                checked={withTotals}
                onChange={(e) => setWithTotals(e.target.checked)}
              />
              带合计行
            </label>
            <span className="spacer" />
            <button
              type="button"
              className="link"
              onClick={() => setFields(EXPORT_COLUMNS.filter((c) => c.on).map((c) => c.field))}
            >
              恢复默认列
            </button>
          </div>
        </section>

        <section className="card">
          <h2>
            预览
            <span className="count">
              {table.rows.length} 行{fields.length === 0 ? '（一列都没选）' : ''}
            </span>
          </h2>
          {empty ? (
            <p className="muted">
              {scope === 'current'
                ? '还没有导入发票。回到「合并打印」页拖入文件即可。'
                : '已报销库还是空的。标记过「已报销」的票会自动进库。'}
            </p>
          ) : fields.length === 0 ? (
            <p className="muted">至少勾一列。</p>
          ) : (
            <DataTable table={table} limit={8} />
          )}
        </section>
      </div>

      <div className="page-foot">
        <button type="button" className="btn btn-primary" disabled={empty || busy} onClick={() => void download('xlsx')}>
          {busy ? '生成中…' : '⬇ 下载 Excel（.xlsx）'}
        </button>
        <button type="button" className="btn" disabled={empty || busy} onClick={() => void download('csv')}>
          下载 CSV
        </button>
        <span className="spacer" />
        <span className="muted">导出在本机完成，文件不上传。</span>
      </div>
    </div>
  );
}
