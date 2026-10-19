import type { Invoice, Issue } from '@invoice-tool/core';
import { correctedFields, isCorrected, worstLevel } from '@invoice-tool/core';
import { useState } from 'react';

import { displayTotal, kindChipClass, kindLabel, money } from '../lib/format';
import type { IntakeItem } from '../lib/intake';
import { saveText } from '../lib/save';
import type { Mark } from '../state/store';
import { tally, useStore } from '../state/store';
import { AddButton } from './AddButton';
import { PageViewer, viewerSourceOf } from './PageViewer';
import { CheckIcon, InvoiceIcon, WarnIcon } from './icons';

const FIELD_LABEL: Partial<Record<keyof Invoice, string>> = {
  kind: '票种',
  invoiceNo: '发票号码',
  invoiceCode: '发票代码',
  issueDate: '开票日期',
  sellerName: '销售方',
  sellerTaxId: '销售方税号',
  buyerName: '购买方',
  buyerTaxId: '购买方税号',
  amount: '不含税金额',
  tax: '税额',
  total: '价税合计',
  totalInWords: '大写金额',
  checkCode: '校验码',
};

const SOURCE_LABEL: Record<string, string> = {
  xml: 'XML 结构化',
  ofd: 'OFD 结构化',
  qr: '二维码',
  'pdf-text': 'PDF 文字层',
  ocr: 'OCR',
  manual: '手工填写',
  derived: '推算',
};

const MONEY_FIELDS = new Set(['amount', 'tax', 'total']);

interface Props {
  items: IntakeItem[];
  problems: Map<string, Issue[]>;
  skipped: Set<string>;
}

export function InvoicePanel({ items, problems, skipped }: Props) {
  const { state, dispatch } = useStore();
  const [openDiag, setOpenDiag] = useState<string | null>(null);

  const printable = items.filter((it) => !skipped.has(it.id));
  const total = printable.reduce((sum, it) => sum + (displayTotal(it.invoice) ?? 0), 0);
  const marks = tally(state.marks, printable);

  return (
    <aside className="panel">
      <div className="panel-head">
        <span className="count">发票 {items.length} 张</span>
        {marks.reimbursed > 0 && <span className="mark-chip">已报销 {marks.reimbursed}</span>}
        {marks.reimbursed === 0 && marks.printed > 0 && (
          <span className="mark-chip">已打印 {marks.printed}</span>
        )}
        {skipped.size > 0 && <span className="chip">跳过 {skipped.size}</span>}
        <span className="spacer" />
        <AddButton className="btn-sm" variant="ghost" label="添加" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="按开票日期从早到晚排序"
          onClick={() => dispatch({ type: 'sort', by: 'date' })}
        >
          按日期
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            if (window.confirm('清空当前列表？不会删除你磁盘上的原文件。')) dispatch({ type: 'clear' });
          }}
        >
          清空
        </button>
      </div>

      <div className="panel-list">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            issues={problems.get(item.id) ?? []}
            needless={skipped.has(item.id)}
            mark={state.marks[item.id]}
            selected={state.selectedId === item.id}
            diagOpen={openDiag === item.id}
            onToggleDiag={() => setOpenDiag(openDiag === item.id ? null : item.id)}
          />
        ))}
      </div>

      <div className="panel-foot">
        <button
          type="button"
          className="btn btn-sm"
          title="导出当前清单（CSV，Excel 可直接打开；M2 换成 .xlsx）"
          onClick={() => {
            void import('../lib/print')
              .then(({ invoicesToCsv }) =>
                saveText(invoicesToCsv(printable.map((it) => it.invoice)), '发票清单.csv', {
                  filter: 'csv',
                }),
              )
              .catch((err: unknown) => {
                dispatch({
                  type: 'toast',
                  toast: {
                    text: `导出失败：${err instanceof Error ? err.message : String(err)}`,
                    actions: [{ label: '好', run: () => undefined }],
                  },
                });
              });
          }}
        >
          导出 Excel
        </button>
        <span className="spacer" />
        <span className="total">
          合计 <b>{money(total)}</b>
        </span>
      </div>
    </aside>
  );
}

interface RowProps {
  item: IntakeItem;
  issues: Issue[];
  needless: boolean;
  mark: Mark | undefined;
  selected: boolean;
  diagOpen: boolean;
  onToggleDiag: () => void;
}

function ItemRow({ item, issues, needless, mark, selected, diagOpen, onToggleDiag }: RowProps) {
  const [viewing, setViewing] = useState(false);
  const { dispatch } = useStore();
  const inv = item.invoice;
  const level = worstLevel(issues);
  const total = displayTotal(inv);
  const parseErrors = inv.issues.filter((i) => i.level === 'error').length;
  const title = inv.sellerName ?? inv.fileName;

  return (
    <div
      className="item"
      data-selected={selected}
      data-skipped={needless}
      role="button"
      tabIndex={0}
      title={inv.fileName}
      onClick={() => dispatch({ type: 'select', id: item.id })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') dispatch({ type: 'select', id: item.id });
      }}
    >
      <div className="item-thumb" aria-hidden>
        <InvoiceIcon size={18} />
      </div>

      <div className="item-main">
        <div className="item-name">{title}</div>
        <div className="item-sub">
          <span className={kindChipClass(inv.kind)}>{kindLabel(inv.kind)}</span>
          {/* 业务标签与票种同名时不重复显示（如通行费票既是 toll 又带「通行费」业务标签） */}
          {inv.businessTag && inv.businessTag !== kindLabel(inv.kind) && (
            <span className="chip">{inv.businessTag}</span>
          )}
          {isCorrected(inv) && (
            <span className="chip chip-corrected" title={`手工填写了 ${correctedFields(inv).length} 个字段`}>
              已校正
            </span>
          )}
          <span>{inv.issueDate ?? '日期未识别'}</span>
          <span className="file-note" title={`发票号码 ${inv.invoiceNo ?? '未识别'}`}>
            {inv.invoiceNo ?? '号码未识别'}
          </span>
          {mark === 'reimbursed' && (
            <span className="flag flag-ok">
              <CheckIcon />
              已报销
            </span>
          )}
          {mark === 'printed' && (
            <span className="flag flag-ok">
              <CheckIcon />
              已打印
            </span>
          )}
          <span className="item-flags">
            {parseErrors > 0 && (
              <span className="flag flag-error" title="解析出错">
                <WarnIcon />
              </span>
            )}
            {level === 'error' && (
              <span className="flag flag-error" title="校验不通过">
                <WarnIcon />
              </span>
            )}
            {level === 'warn' && (
              <span className="flag flag-warn" title="需要确认">
                <WarnIcon />
              </span>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                onToggleDiag();
              }}
              title="查看取数来源与问题"
              aria-label="查看取数来源与问题"
            >
              ⓘ
            </button>
          </span>
        </div>
      </div>

      <div className="item-amount">
        <span className={level === 'error' ? 'warn' : undefined}>{money(total)}</span>
      </div>

      {diagOpen && (
        <div className="diag" onClick={(e) => e.stopPropagation()}>
          <dl>
            {(Object.keys(FIELD_LABEL) as Array<keyof Invoice>).map((key) => {
              const value = inv[key];
              if (value === undefined) return null;
              const prov = inv.provenance[key];
              const shown =
                MONEY_FIELDS.has(String(key))
                  ? money(value as number)
                  : key === 'kind'
                    ? kindLabel(value as Invoice['kind'])
                    : String(value);
              return (
                <div key={String(key)} style={{ display: 'contents' }}>
                  <dt>{FIELD_LABEL[key]}</dt>
                  <dd>
                    {shown}
                    {prov && <span className="src">（来自{SOURCE_LABEL[prov.source] ?? prov.source}）</span>}
                  </dd>
                </div>
              );
            })}
          </dl>

          {(inv.issues.length > 0 || issues.length > 0) && (
            <ul className="issues">
              {inv.issues.map((issue, i) => (
                <li key={`p${i}`} className={issue.level}>
                  解析：{issue.message}
                </li>
              ))}
              {issues.map((issue, i) => (
                <li key={`v${i}`} className={issue.level}>
                  校验：{issue.message}
                </li>
              ))}
            </ul>
          )}

          <div className="diag-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => dispatch({ type: 'correcting', id: item.id })}
            >
              {inv.invoiceNo ? '校正字段' : '补录号码'}
            </button>
            {item.visual !== 'none' && (
              <button type="button" className="btn btn-sm" onClick={() => setViewing(true)}>
                看原图
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => dispatch({ type: 'skip', id: item.id, skip: !needless })}
            >
              {needless ? '恢复打印这张' : '不打印这张'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (window.confirm(`把「${inv.fileName}」从列表里移除？（不会删原文件）`)) {
                  dispatch({ type: 'remove', id: item.id });
                }
              }}
            >
              移除
            </button>
          </div>

          {viewing && (
            <PageViewer item={viewerSourceOf(item)} onClose={() => setViewing(false)} />
          )}
        </div>
      )}
    </div>
  );
}
