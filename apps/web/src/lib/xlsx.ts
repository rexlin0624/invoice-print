/**
 * `ExportTable` → `.xlsx`（ExcelJS 的浏览器构建）。
 *
 * 这里只做「表格数据 → 单元格」的映射，取字段与合计口径全在内核
 * （`packages/core/src/export/invoices.ts`），保证 CSV 与 XLSX 说的是同一件事。
 *
 * 两个刻意的选择：
 * - **开票日期写成真的日期**（不是文本），这样 Excel 里能按日期排序 / 按月分组，
 *   自动筛选也才正常。构造时用**本地中午 12 点**，任何时区都不会把日期挪一天。
 * - **号码列设成文本格式**（`@`），否则 Excel 会把 20 位号码变成科学计数法。
 */

import type { ExportTable } from '@invoice-tool/core';

const MONEY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'yyyy-mm-dd';

/** 'YYYY-MM-DD' → 本地中午的 Date（避开时区导致的错一天） */
function isoToDate(iso: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export interface XlsxOptions {
  sheetName?: string;
  /** 首行说明（筛选条件之类） */
  caption?: string;
}

export async function tableToXlsx(table: ExportTable, options: XlsxOptions = {}): Promise<Uint8Array> {
  // 懒加载：ExcelJS 的浏览器构建压缩后接近 1 MB，首屏不该为它买单
  const mod = await import('exceljs');
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '发票工具';
  workbook.created = new Date();

  const columns = table.columns;
  const sheet = workbook.addWorksheet(options.sheetName ?? '发票汇总', {
    views: [{ state: 'frozen', ySplit: options.caption ? 2 : 1 }],
    properties: { defaultRowHeight: 16 },
  });

  sheet.columns = columns.map((column) => ({
    key: column.field,
    width: column.width,
    style:
      column.kind === 'money'
        ? { numFmt: MONEY_FORMAT }
        : column.kind === 'date'
          ? { numFmt: DATE_FORMAT }
          : { numFmt: '@' },
  }));

  let rowOffset = 0;
  if (options.caption) {
    const row = sheet.addRow([options.caption]);
    row.font = { italic: true, color: { argb: 'FF6B7280' } };
    sheet.mergeCells(row.number, 1, row.number, Math.max(1, columns.length));
    rowOffset = 1;
  }

  const headerRow = sheet.addRow(table.header);
  headerRow.font = { bold: true };
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F5' } };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });

  for (const values of table.rows) {
    const row = sheet.addRow(
      values.map((value, i) => {
        const column = columns[i];
        if (value === undefined || column === undefined) return null;
        if (column.kind === 'date' && typeof value === 'string') return isoToDate(value) ?? value;
        return value;
      }),
    );
    row.alignment = { vertical: 'middle' };
  }

  if (table.totals) {
    const row = sheet.addRow(
      table.totals.map((value, i) => {
        const column = columns[i];
        if (value === undefined || column === undefined) return null;
        if (column.kind === 'date' && typeof value === 'string') return isoToDate(value) ?? value;
        return value;
      }),
    );
    row.font = { bold: true };
    row.eachCell((cell) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FF9CA3AF' } } };
    });
  }

  // 自动筛选只覆盖表头到合计行之前，别把合计行也筛进去
  const lastDataRow = rowOffset + 1 + table.rows.length;
  sheet.autoFilter = {
    from: { row: rowOffset + 1, column: 1 },
    to: { row: lastDataRow, column: Math.max(1, columns.length) },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
