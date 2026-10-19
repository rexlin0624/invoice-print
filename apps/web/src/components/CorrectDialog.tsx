/**
 * 校正发票字段（含「人工补录」）。
 *
 * 这是参考项目里两套校正的合体，它们本来就是同一件事的两半：
 * - **人工补录**：未识别 / 部分识别的票，补上号码、代码、金额、日期四个关键字段；
 * - **校正字段**：任何一张票，主字段 + 货物明细整体核对一遍。
 *
 * 合在一处的理由：两个入口看到的是同一张票、同一份字段，分成两个表单迟早会
 * 「补录能改日期、校正不能」这类不一致。**入口文案不同，表单只有一个。**
 *
 * 三条贯穿始终的规矩：
 * 1. 只提交**真的改过**的字段（`diffPatch`）—— 于是 `provenance` 里的 `manual`
 *    标记是诚实的，用户没动过的字段不会被贴上「人工填写」，也不会把解析结果覆盖掉。
 * 2. 清空 = `null`（内核三态）。清干净就是「票上确实没有」，不能留旧值。
 * 3. 校验在保存前做完（日期格式、金额能不能解析），错误就地显示、不关弹窗 ——
 *    关掉弹窗再报错，用户就得重新填一遍。
 */

import type { CorrectPatch, Invoice, InvoiceKind } from '@invoice-tool/core';
import { INVOICE_KIND_LABEL, correctedFields, decimalToCents } from '@invoice-tool/core';
import { useEffect, useMemo, useState } from 'react';

import type { CorrectForm, ItemForm } from '../lib/correctForm';
import { diffPatch, emptyRow, toForm } from '../lib/correctForm';
import { money } from '../lib/format';
import { PageViewer, type ViewerSource } from './PageViewer';
import { CloseIcon } from './icons';

const SOURCE_LABEL: Record<string, string> = {
  xml: 'XML 结构化',
  ofd: 'OFD 结构化',
  qr: '二维码',
  'pdf-text': 'PDF 文字层',
  ocr: 'OCR',
  manual: '手工填写',
  derived: '推算',
};

const KINDS = Object.keys(INVOICE_KIND_LABEL) as InvoiceKind[];

interface Props {
  invoice: Invoice;
  /** 能看原图就给一个（本次导入直接给字节，库里按需读） */
  source?: ViewerSource | (() => Promise<ViewerSource | undefined>) | undefined;
  /** 保存。宿主负责把补丁落到 state / 已报销库 */
  onSave: (patch: CorrectPatch) => void;
  onClose: () => void;
}

export function CorrectDialog({ invoice, source, onSave, onClose }: Props) {
  const [form, setForm] = useState<CorrectForm>(() => toForm(invoice));
  const [errors, setErrors] = useState<string[]>([]);
  const [viewer, setViewer] = useState<ViewerSource | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);

  useEffect(() => {
    setForm(toForm(invoice));
    setErrors([]);
  }, [invoice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof CorrectForm>(key: K, value: CorrectForm[K]): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const alreadyCorrected = useMemo(() => correctedFields(invoice), [invoice]);
  const missingKey = !invoice.invoiceNo;
  const title = missingKey ? '人工补录' : '校正发票字段';

  const openOriginal = async (): Promise<void> => {
    if (!source) return;
    setViewerBusy(true);
    try {
      const resolved = typeof source === 'function' ? await source() : source;
      if (resolved) setViewer(resolved);
      else setErrors(['这一条没有存原文件，看不了原图。']);
    } catch (err) {
      setErrors([`读取原文件失败：${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setViewerBusy(false);
    }
  };

  const submit = (): void => {
    const { patch, errors: found } = diffPatch(form, invoice);
    if (found.length > 0) {
      setErrors(found);
      return;
    }
    if (Object.keys(patch).length === 0) {
      onClose(); // 什么都没改，直接关掉，不留一条空的「校正」
      return;
    }
    onSave(patch); // 宿主负责应用：三态语义与出处只有内核那一份实现
  };

  const formTotal = decimalToCents(form.total.trim() || '0');
  const sumParts =
    decimalToCents(form.amount.trim() || '0') !== undefined && decimalToCents(form.tax.trim() || '0') !== undefined
      ? (decimalToCents(form.amount.trim() || '0') ?? 0) + (decimalToCents(form.tax.trim() || '0') ?? 0)
      : undefined;
  const mismatch = formTotal !== undefined && sumParts !== undefined && formTotal !== sumParts && sumParts > 0;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal correct" role="dialog" aria-label={title} aria-modal>
        <div className="drawer-head">
          {title}
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            {invoice.fileName}
          </span>
          <span className="spacer" />
          {source && (
            <button type="button" className="btn btn-sm" disabled={viewerBusy} onClick={() => void openOriginal()}>
              🔍 {viewerBusy ? '读取中…' : '查看原图'}
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          {alreadyCorrected.length > 0 && (
            <p className="help-note">
              这张票已经有 {alreadyCorrected.length} 个字段是人工填的（诊断里显示「手工填写」）；
              下面标着「来自…」的是这次还没动过的原值。
            </p>
          )}

          <section className="group">
            <h3>发票字段</h3>
            <div className="form-grid">
              <Field label="票种">
                <select value={form.kind} onChange={(e) => set('kind', e.target.value as InvoiceKind)}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {INVOICE_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="发票号码"
                hint={hintOf(invoice, 'invoiceNo')}
                warn={form.invoiceNo.trim() !== '' && !/^(\d{8}|\d{20})$/.test(form.invoiceNo.trim())}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="8 位老票 / 20 位数电票"
                  value={form.invoiceNo}
                  onChange={(e) => set('invoiceNo', e.target.value)}
                />
              </Field>
              <Field label="发票代码" hint={hintOf(invoice, 'invoiceCode')}>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="老票才有（10 / 12 位）"
                  value={form.invoiceCode}
                  onChange={(e) => set('invoiceCode', e.target.value)}
                />
              </Field>
              <Field label="开票日期" hint={hintOf(invoice, 'issueDate')}>
                <input
                  type="text"
                  placeholder="2026-01-31"
                  value={form.issueDate}
                  onChange={(e) => set('issueDate', e.target.value)}
                />
              </Field>
              <Field label="销售方名称" hint={hintOf(invoice, 'sellerName')}>
                <input type="text" value={form.sellerName} onChange={(e) => set('sellerName', e.target.value)} />
              </Field>
              <Field label="销售方税号" hint={hintOf(invoice, 'sellerTaxId')}>
                <input type="text" value={form.sellerTaxId} onChange={(e) => set('sellerTaxId', e.target.value)} />
              </Field>
              <Field label="购买方名称" hint={hintOf(invoice, 'buyerName')}>
                <input type="text" value={form.buyerName} onChange={(e) => set('buyerName', e.target.value)} />
              </Field>
              <Field label="购买方税号" hint={hintOf(invoice, 'buyerTaxId')}>
                <input type="text" value={form.buyerTaxId} onChange={(e) => set('buyerTaxId', e.target.value)} />
              </Field>
              <Field label="不含税金额（元）" hint={hintOf(invoice, 'amount')}>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.amount}
                  onChange={(e) => set('amount', e.target.value)}
                />
              </Field>
              <Field label="税额（元）" hint={hintOf(invoice, 'tax')}>
                <input type="text" inputMode="decimal" placeholder="0.00" value={form.tax} onChange={(e) => set('tax', e.target.value)} />
              </Field>
              <Field label="价税合计（元）" hint={hintOf(invoice, 'total')}>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.total}
                  onChange={(e) => set('total', e.target.value)}
                />
              </Field>
              <Field label="价税合计（大写）" hint={hintOf(invoice, 'totalInWords')}>
                <input type="text" placeholder="壹佰贰拾叁元肆角伍分" value={form.totalInWords} onChange={(e) => set('totalInWords', e.target.value)} />
              </Field>
              <Field
                label="校验码"
                hint={
                  form.invoiceNo.trim() !== (invoice.invoiceNo ?? '')
                    ? '号码改了，保存时会自动清掉（校验码是号码算出来的）'
                    : hintOf(invoice, 'checkCode')
                }
              >
                <input type="text" value={form.checkCode} onChange={(e) => set('checkCode', e.target.value)} />
              </Field>
            </div>
            {mismatch && (
              <p className="help-note warn">
                价税合计 {money(formTotal)} 与「不含税 + 税额」{money(sumParts)} 不一致，核对一下（不一致也能保存，只是会一直提示）。
              </p>
            )}
            {formTotal !== undefined && sumParts === formTotal && (
              <p className="help-note">合计对得上。</p>
            )}
          </section>

          {invoice.pageCount > 1 && (
            <section className="group">
              <h3>打印哪些页</h3>
              <p className="muted">这份文件有 {invoice.pageCount} 页。比如一页是发票、下一页是清单，可以把清单页去掉。</p>
              <div className="row-inline">
                {Array.from({ length: invoice.pageCount }, (_, i) => {
                  const checked = form.pages.includes(i);
                  // 最后一页不许取消：一页都不留的票没法打印
                  const lastOne = checked && form.pages.length === 1;
                  return (
                    <label key={i} className="check-inline" title={lastOne ? '至少要留一页' : ''}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={lastOne}
                        onChange={(e) =>
                          set(
                            'pages',
                            e.target.checked ? [...form.pages, i] : form.pages.filter((p) => p !== i),
                          )
                        }
                      />
                      第 {i + 1} 页
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          <section className="group">
            <h3>货物明细（可选）</h3>
            {form.items.length === 0 && <p className="muted">这张票没有提取到明细。需要汇总表里有明细时再补。</p>}
            {form.items.map((row, i) => (
              <div className="item-edit" key={i}>
                <div className="row-inline">
                  <b>明细 {i + 1}</b>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => set('items', form.items.filter((_, j) => j !== i))}
                  >
                    删除
                  </button>
                </div>
                <div className="form-grid">
                  <Field label="名称">
                    <input type="text" value={row.name} onChange={(e) => patchRow(set, form, i, { name: e.target.value })} />
                  </Field>
                  <Field label="规格型号">
                    <input type="text" value={row.spec} onChange={(e) => patchRow(set, form, i, { spec: e.target.value })} />
                  </Field>
                  <Field label="单位">
                    <input type="text" value={row.unit} onChange={(e) => patchRow(set, form, i, { unit: e.target.value })} />
                  </Field>
                  <Field label="数量">
                    <input type="text" inputMode="decimal" value={row.quantity} onChange={(e) => patchRow(set, form, i, { quantity: e.target.value })} />
                  </Field>
                  <Field label="单价（元）">
                    <input type="text" inputMode="decimal" value={row.unitPrice} onChange={(e) => patchRow(set, form, i, { unitPrice: e.target.value })} />
                  </Field>
                  <Field label="金额（元）">
                    <input type="text" inputMode="decimal" value={row.amount} onChange={(e) => patchRow(set, form, i, { amount: e.target.value })} />
                  </Field>
                  <Field label="税率">
                    <input type="text" placeholder="13%" value={row.taxRate} onChange={(e) => patchRow(set, form, i, { taxRate: e.target.value })} />
                  </Field>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => set('items', [...form.items, emptyRow()])}>
              ＋ 明细行
            </button>
          </section>

          {errors.length > 0 && (
            <ul className="issues">
              {errors.map((msg) => (
                <li key={msg} className="error">
                  {msg}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="drawer-foot">
          <span className="muted">
            价税合计{' '}
            <b>{form.total.trim() === '' ? money(undefined) : money(formTotal)}</b>
          </span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            保存
          </button>
        </div>
      </div>

      {viewer && <PageViewer item={viewer} onClose={() => setViewer(null)} />}
    </>
  );
}

type Setter = <K extends keyof CorrectForm>(key: K, value: CorrectForm[K]) => void;

function patchRow(set: Setter, form: CorrectForm, index: number, patch: Partial<ItemForm>): void {
  set(
    'items',
    form.items.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  );
}

/** 「来自二维码 0.95」这类出处提示；已人工填过就不再提原值来源 */
function hintOf(inv: Invoice, field: keyof Invoice): string {
  const prov = inv.provenance[field];
  if (!prov) return '';
  if (prov.source === 'manual') return '手工填写';
  return `来自${SOURCE_LABEL[prov.source] ?? prov.source}`;
}

function Field({
  label,
  hint,
  warn,
  children,
}: {
  label: string;
  hint?: string;
  warn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className={warn ? 'field-hint warn' : 'field-hint'}>{hint}</span>}
      </span>
      {children}
    </label>
  );
}
