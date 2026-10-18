import type { ExportTable } from '@invoice-tool/core';

/**
 * 导出前的表格预览。
 *
 * 为什么一定要有预览：导出的字段是用户勾的，勾错了在 Excel 里才发现要重来一遍。
 * 这里直接把「内核生成的那份表格数据」按原样画出来，所见即所得。
 */
export function DataTable({ table, limit }: { table: ExportTable; limit?: number }) {
  const rows = limit === undefined ? table.rows : table.rows.slice(0, limit);
  const hidden = table.rows.length - rows.length;

  return (
    <div className="dtable-wrap">
      <table className="dtable">
        <thead>
          <tr>
            {table.header.map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((value, j) => (
                <td key={j} data-num={table.numeric[j] ? 'true' : undefined}>
                  {formatCell(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {table.totals && (
          <tfoot>
            <tr>
              {table.totals.map((value, i) => (
                <td key={i} data-num={table.numeric[i] ? 'true' : undefined}>
                  {formatCell(value)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {hidden > 0 && <div className="dtable-more">还有 {hidden} 行没显示（导出的是全部）</div>}
    </div>
  );
}

function formatCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'number') return value.toFixed(2);
  return value;
}
