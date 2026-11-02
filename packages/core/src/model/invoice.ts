import type { Cents } from './money';

/** 票种。用稳定的机器可读枚举，中文名走 `INVOICE_KIND_LABEL`。 */
export type InvoiceKind =
  | 'vat-special' // 增值税专用发票 / 数电专票
  | 'vat-general' // 增值税普通发票 / 数电普票（含电子发票（普通发票））
  | 'train' // 铁路电子客票
  | 'air' // 航空运输电子客票行程单
  | 'toll' // 通行费
  | 'taxi' // 出租车
  | 'ride' // 网约车
  | 'medical' // 医疗票据
  | 'nontax' // 非税收入
  | 'vehicle-tax' // 车船税
  | 'unknown';

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  'vat-special': '专票',
  'vat-general': '普票',
  train: '火车票',
  air: '行程单',
  toll: '通行费',
  taxi: '出租车',
  ride: '网约车',
  medical: '医疗',
  nontax: '非税',
  'vehicle-tax': '车船税',
  unknown: '未知',
};

/** 票种在「打印分组」时的归类：不同尺寸的票要各自成页。 */
export const INVOICE_KIND_GROUP: Record<InvoiceKind, 'standard' | 'ticket' | 'receipt'> = {
  'vat-special': 'standard',
  'vat-general': 'standard',
  toll: 'standard',
  ride: 'standard',
  medical: 'standard',
  nontax: 'standard',
  'vehicle-tax': 'standard',
  train: 'ticket',
  air: 'ticket',
  taxi: 'ticket',
  unknown: 'standard',
};

/** 字段来源。可信度从高到低排列。 */
export type FieldSource = 'xml' | 'ofd' | 'qr' | 'pdf-text' | 'ocr' | 'manual' | 'derived';

export const SOURCE_CONFIDENCE: Record<FieldSource, number> = {
  xml: 0.99,
  ofd: 0.97,
  qr: 0.95,
  'pdf-text': 0.85,
  ocr: 0.6,
  manual: 1,
  derived: 0.9,
};

/** 每个字段都带出处，避免「不知道这个值是哪来的」。 */
export interface Provenance {
  source: FieldSource;
  /** 0–1 */
  confidence: number;
}

/** 明细行（价税合计的构成）。M1 只做尽力而为的提取，允许为空。 */
export interface InvoiceItem {
  name?: string;
  spec?: string;
  unit?: string;
  quantity?: number;
  unitPrice?: Cents;
  amount?: Cents; // 不含税金额
  taxRate?: string; // 原样保留，如 "13%"
  tax?: Cents;
}

export type IssueCode =
  // 解析相关
  | 'no-text-layer'
  | 'unsupported-format'
  | 'parse-failed'
  /** 文件超过解析预算（XML 体积 / 压缩包解压后体积） */
  | 'file-too-large'
  /** PDF 声明的页数超过上限，已按上限处理 */
  | 'page-count-clamped'
  | 'low-confidence'
  // 二维码相关
  /** 二维码与票面文字层对同一件事给出了不同答案 —— 必须人工核对 */
  | 'qr-mismatch'
  /** 只靠二维码取到字段（图片/扫描件，没有文字层） */
  | 'qr-only'
  /** 剔除了明细页（医疗票据） */
  | 'detail-page-skipped'
  /** 用离线 OCR 认出了字段（扫描件/图片） */
  | 'ocr-used'
  /** 需要 OCR 但本机没装模型 —— 说清楚怎么装上 */
  | 'ocr-unavailable'
  /** OCR 没在合理时间内出结果（后台标签页会限流渲染） */
  | 'ocr-timeout'
  /** 购销方看起来读串了（两侧同名/同税号） */
  | 'party-suspect'
  /** 红冲（负数）发票：金额从合计中抵扣，不参与凑票 */
  | 'red-invoice'
  // 校验相关
  | 'amount-mismatch'
  | 'capital-mismatch'
  | 'tax-id-invalid'
  | 'invoice-no-shape'
  /** 字段形状/长度不合理，已被忽略（不会进入去重与打印） */
  | 'field-invalid'
  | 'missing-field'
  | 'date-invalid'
  // 去重 / 报销相关
  | 'duplicate-file'
  | 'duplicate-invoice-no'
  | 'suspected-duplicate'
  | 'already-reimbursed';

export interface Issue {
  code: IssueCode;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** 关联字段名，便于 UI 高亮定位 */
  field?: keyof Invoice;
}

/** 内部结构：字段值 + 出处 */
export interface Field<T> {
  value: T;
  source: FieldSource;
  confidence: number;
}

/** 唯一事实来源的发票模型。拿不到的字段就是 undefined，绝不用空串或 0 冒充。 */
export interface Invoice {
  /** 内部 id（导入时生成） */
  id: string;
  /** 来源文件名（展示用） */
  fileName: string;
  fileSize: number;
  /** 文件内容 sha256（十六进制），文件级去重依据 */
  sha256: string;

  kind: InvoiceKind;
  /** 特定业务标签，如「成品油」「通行费」「建筑服务」 */
  businessTag?: string;

  /** 发票号码：数电票 20 位，老票 8 位 */
  invoiceNo?: string;
  /** 发票代码：老票才有 */
  invoiceCode?: string;
  /** 开票日期 ISO：YYYY-MM-DD */
  issueDate?: string;

  sellerName?: string;
  sellerTaxId?: string;
  buyerName?: string;
  buyerTaxId?: string;

  /** 不含税金额 */
  amount?: Cents;
  /** 税额 */
  tax?: Cents;
  /** 价税合计（小写） */
  total?: Cents;
  /** 价税合计（大写），原样保留 */
  totalInWords?: string;
  /** 校验码（老票 20 位） */
  checkCode?: string;

  /**
   * 红冲（负数）发票。
   *
   * 三态，和别的字段一致：`undefined` = 没判过（由 `isRedInvoice()` 按金额推断），
   * `true` = 红冲，`false` = 人工确认为**不是**红冲（覆盖掉推断）。
   *
   * 为什么要单独一个字段：金额为负只是「红冲的表现」，不是「红冲这件事」。
   * 汇总、凑票、查重都要按语义处理（抵扣、排除、与正数票配对），
   * 三处各写一次 `total < 0` 迟早会漏掉一处。
   */
  isRed?: boolean;

  items: InvoiceItem[];

  /** 文件里的页数（跨页票按一张逻辑票处理） */
  pageCount: number;
  /**
   * 不打印的页（0 基下标）。目前只有一种来源：医疗票据的**明细页**。
   * 空/缺省 = 全部打印。用 `printablePages()` 取实际要打的页。
   */
  skipPages?: number[];
  /** 每个字段的出处 */
  provenance: Partial<Record<keyof Invoice, Provenance>>;
  /** 解析与校验过程中发现的问题 */
  issues: Issue[];

  /** 导入时间戳（ms）。内核不读时钟，由外壳传入。 */
  importedAt?: number;
}

export function makeIssue(
  code: IssueCode,
  level: Issue['level'],
  message: string,
  field?: keyof Invoice,
): Issue {
  return field === undefined ? { code, level, message } : { code, level, message, field };
}

/**
 * 人工校正的补丁。**三态**，和 `IntakeItem.crop` 一样的规矩：
 *
 * - 键不出现 / `undefined` = 别动这个字段（没提到它）
 * - `null` = 清空（这个字段确实没有值）
 * - 其它 = 写死成这个值
 *
 * 为什么要三态：只给「有值」的字段，就没法区分「用户没改」和「用户确认这里就是空的」——
 * 而「票上没有这个字段」本身就是一个结论，不能被旧值覆盖回去。
 */
export interface CorrectPatch {
  kind?: InvoiceKind;
  invoiceNo?: string | null;
  invoiceCode?: string | null;
  issueDate?: string | null;
  sellerName?: string | null;
  sellerTaxId?: string | null;
  buyerName?: string | null;
  buyerTaxId?: string | null;
  amount?: Cents | null;
  tax?: Cents | null;
  total?: Cents | null;
  totalInWords?: string | null;
  checkCode?: string | null;
  /** 人工确认这张是不是红冲票（`null` = 清掉标记，回到按金额推断） */
  isRed?: boolean | null;
  items?: InvoiceItem[];
  /** 要打印的源文件页下标（0 基）。整套替换 */
  skipPages?: number[];
}

/** 补丁里能出现的字段名（`items`/`skipPages` 是整体替换，不在 provenance 的白名单外） */
const PATCH_FIELDS = [
  'kind',
  'invoiceNo',
  'invoiceCode',
  'issueDate',
  'sellerName',
  'sellerTaxId',
  'buyerName',
  'buyerTaxId',
  'amount',
  'tax',
  'total',
  'totalInWords',
  'checkCode',
  'isRed',
  'items',
  'skipPages',
] as const;

/**
 * 红冲结论所依赖的「证据字段」。
 *
 * `isRed` 在解析期往往是**推出来的**（金额为负 / 大写金额写了「负」），
 * 但它会被持久化到 `Invoice` 上。不主动作废就会留下过期结论：
 * 把 -5000 人工改成 +6000 之后，`isRed` 仍是 `true`，`invoiceTotal()` 照旧算出
 * -6000 —— 用户改的那一刀等于没改。
 *
 * 所以校正时按**来源**区分（见 `applyCorrection`）：
 * - `derived`：只是推断，证据字段一变就丢掉，让 `isRedInvoice()` 按新值重新推；
 * - 票面「红字/红冲」字样、人工标记：是独立事实，保留，矛盾交给 `validateInvoice()` 报 warn。
 */
const RED_EVIDENCE_FIELDS: ReadonlySet<keyof Invoice> = new Set([
  'total',
  'amount',
  'tax',
  'totalInWords',
]);

/** 归一化后比较「号码有没有真的变」（空串与 undefined 视为同一件事） */
function sameText(a: string | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  return left === right;
}

/** 按白名单字段名写入/删除。白名单是 `PATCH_FIELDS`，类型由调用点保证。 */
function setField(target: Invoice, field: keyof Invoice, value: unknown): void {
  (target as unknown as Record<string, unknown>)[field] = value;
}

function clearField(target: Invoice, field: keyof Invoice): void {
  delete (target as unknown as Record<string, unknown>)[field];
}

/**
 * 把人工校正应用到一个 `Invoice` 上，返回**新的** Invoice（不改原对象）。
 *
 * 三件事一起做，缺一个都会留下隐患：
 * 1. 写值，并把这些字段的出处标成 `manual`（可信度 1）—— 于是诊断面板里能看出
 *    「这个值是你看过的」，而不是永远显示「来自 PDF 文字层 0.85」。
 * 2. **号码改了就把校验码丢掉**：老票的校验码是「号码 + 代码 + 金额 + 日期」算出来的，
 *    号码一改，那个校验码必然对不上；继续留着会让校验报 `tax-id-invalid` 之类的假警。
 *    本次同时给了新校验码时不丢（调用方明确写了，就以调用方为准）。
 * 3. 丢掉**针对这些字段**的解析问题（如「二维码与票面不一致，请人工核对」）——
 *    人工已经核过了，再挂着这条提示只会让红色警告永远消不掉。
 *    不带 `field` 的问题（解析失败、没文字层……）原样保留。
 */
export function applyCorrection(invoice: Invoice, patch: CorrectPatch): Invoice {
  const next: Invoice = { ...invoice, provenance: { ...invoice.provenance } };
  const provenance = next.provenance;
  const touched = new Set<keyof Invoice>();

  for (const field of PATCH_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue; // 没提到它
    touched.add(field as keyof Invoice);
    // 空串等同于「清空」：输入框清干净就是「这张票上确实没有」，不该留下一个空壳值
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      clearField(next, field as keyof Invoice);
      delete provenance[field as keyof Invoice];
      continue;
    }
    setField(next, field as keyof Invoice, typeof value === 'string' ? value.trim() : value);
    provenance[field as keyof Invoice] = { source: 'manual', confidence: SOURCE_CONFIDENCE.manual };
  }

  // 号码变了 → 旧校验码作废（除非本次一并给了新校验码）
  const noChanged =
    patch.invoiceNo !== undefined && !sameText(invoice.invoiceNo, patch.invoiceNo);
  if (noChanged && patch.checkCode === undefined) {
    delete next.checkCode;
    delete provenance.checkCode;
    touched.add('checkCode');
  }

  if (touched.size > 0) {
    next.issues = invoice.issues.filter((issue) => !(issue.field && touched.has(issue.field)));
  }
  // 「推算出来的」红冲结论随证据一起失效。
  //
  // 只清 `derived`：票面写着「红字/红冲」、或人工标过的方向是**独立事实**，
  // 不能因为改了金额就丢掉 —— 那种矛盾应该由 validate 报 warn 让人看见。
  // 清掉之后 `isRedInvoice()` 立刻按新值重新推：改成正数就不再是红冲，
  // 只改绝对值（-5000 → -6000）则仍然是红冲。
  const redWasDerived =
    invoice.isRed !== undefined && invoice.provenance.isRed?.source === 'derived';
  const redEvidenceTouched = [...RED_EVIDENCE_FIELDS].some((field) => touched.has(field));
  if (redWasDerived && redEvidenceTouched && patch.isRed === undefined) {
    clearField(next, 'isRed');
    delete provenance.isRed;
    // 说明也是按旧值写的（「金额为负，已按红冲处理」），一并作废
    next.issues = next.issues.filter((issue) => issue.code !== 'red-invoice');
  }
  // 人工定了「是不是红冲」，所有自动得出的红冲结论就都过期了 —— 哪怕那条 issue 的
  // field 指向的是「给证据的那一格」（大写金额 / 价税合计），用户改的却是 `isRed`。
  // 不按 code 再清一次，界面上会同时挂着「识别为红冲」和「已标记为不是红冲」。
  if (touched.has('isRed' as keyof Invoice)) {
    next.issues = next.issues.filter((issue) => issue.code !== 'red-invoice');
  }
  return next;
}

/** 哪些字段是人工改过的 */
export function correctedFields(invoice: Pick<Invoice, 'provenance'>): Array<keyof Invoice> {
  return (Object.keys(invoice.provenance) as Array<keyof Invoice>).filter(
    (key) => invoice.provenance[key]?.source === 'manual',
  );
}

/** 这张票有人工校正过吗（UI 上给一个小标记） */
export function isCorrected(invoice: Pick<Invoice, 'provenance'>): boolean {
  return correctedFields(invoice).length > 0;
}

/**
 * 这张票「算多少钱」。
 *
 * 唯一口径，内核与两个外壳都从这里取：优先价税合计，其次「不含税 + 税额」。
 * 关键是**不要**在金额缺失时返回 0 —— 那会把「没识别出来」混进「这张票是 0 元」，
 * 汇总时会静默漏账。拿不到就 undefined，由调用方决定怎么显示、怎么计数。
 *
 * **红冲一律返回负数**：票面写了「红字/红冲」、但解析到的金额漏了负号时，
 * 若照着正数返回，就会出现「汇总说抵扣了 5000、合计却多了 5000」这种事。
 * 原始字段（`invoice.total`）保持解析到的样子，方便对着票面排查；
 * 该矛盾由 `validate` 给 warn。这里只保证**记账口径**一致。
 */
export function invoiceTotal(
  invoice: Pick<Invoice, 'total' | 'amount' | 'tax' | 'isRed' | 'totalInWords'>,
): Cents | undefined {
  const raw =
    invoice.total !== undefined
      ? invoice.total
      : invoice.amount !== undefined && invoice.tax !== undefined
        ? invoice.amount + invoice.tax
        : undefined;
  if (raw === undefined) return undefined;
  // 方向也走 `isRedInvoice()`，不在这里另判 `isRed === true`。
  // 否则「票面写了红字、数字金额漏了负号」这类票会出现内部打架：`settle()` 给了
  // `isRed = true`、`redCount` 记了 1 张，合计却把 5000 加了进去。
  // 而人工构造 / 旧数据里还可能只有大写带「负」、`isRed` 仍是 `undefined`，
  // 那时同样只能靠 `isRedInvoice()` 兜住。
  return isRedInvoice(invoice) ? -Math.abs(raw) : raw;
}

/**
 * 这张票是不是红冲（负数）票。
 *
 * 唯一的判定口径，汇总 / 凑票 / 查重 / 导出都从这里取。
 *
 * 优先级：显式标记（解析时从票面判断、或人工校正）> 金额符号。
 * 人工把 `isRed` 设成 `false` 时**必须**尊重它 —— 否则「我确认过这不是红冲」
 * 会被 `total < 0` 重新推翻，人工校正就白做了。
 */
export function isRedInvoice(
  invoice: Pick<Invoice, 'isRed' | 'total' | 'amount' | 'totalInWords'>,
): boolean {
  if (invoice.isRed !== undefined) return invoice.isRed;
  return amountIsNegative(invoice) || wordsSayNegative(invoice);
}

/** 金额（价税合计优先，其次不含税）为负 —— 红冲最硬的证据 */
export function amountIsNegative(
  invoice: Pick<Invoice, 'total' | 'amount'>,
): boolean {
  return (invoice.total !== undefined && invoice.total < 0) || (invoice.amount !== undefined && invoice.amount < 0);
}

/** 大写金额正文里会出现的字符（正体 + 繁体「萬/圓」+ 常见异写） */
const WORDS_AMOUNT_CHAR = /[零壹贰叁肆伍陆柒捌玖拾佰仟萬万亿圓圆元角分整正〇]/;

/** 方向写在金额后面的括号里：『伍仟圆整（负）』『伍仟圆整（负数）』 */
const WORDS_SIGNED_SUFFIX = /[（(]\s*负(?:数)?\s*[)）]\s*$/;

/**
 * 大写金额里带「负」字（部分红冲票只在这里体现方向）。
 *
 * **不能简单 `test(/负/)`**：`totalInWords` 在 XML / OFD 路径上是自由文本
 * （`parse/xml.ts` 只限长度），「伍仟圆整（备注：不负任何责任）」这种备注就会
 * 让一张正常票被静默按负数入账 —— 金额直接变负、进合计、还可能和原票配成红冲对。
 *
 * 所以认三种写法，别的一概不认：
 * 1. 方向在金额正文**之前**：`负伍仟圆整`、`（负）伍仟圆整`、`人民币负伍仟圆整`；
 * 2. 方向是金额前面的负号：`-伍仟圆整`、`－伍仟圆整`（自研模板/全角化会这么拼）；
 * 3. 方向写在金额**之后**的括号里：`伍仟圆整（负）`、`伍仟圆整（负数）` ——
 *    只认「括号里就是负/负数」，`（备注：不负任何责任）` 这类不算。
 *
 * 繁体「負」一并认（有些票面/OCR 会混用）。
 */
export function wordsSayNegative(invoice: Pick<Invoice, 'totalInWords'>): boolean {
  const words = invoice.totalInWords;
  if (words === undefined) return false;
  const firstAmount = words.search(WORDS_AMOUNT_CHAR);
  // 一个金额字符都没有，就不是大写金额，别拿它当方向证据
  if (firstAmount === -1) return false;
  const head = words.slice(0, firstAmount);
  if (/[负負\-－—]/.test(head)) return true;
  return WORDS_SIGNED_SUFFIX.test(words);
}

/**
 * 红冲票的「抵扣额」（正数，分）。
 *
 * 汇总时要说「其中红冲 2 张，-¥1,000.00」，这里的 1000.00 就是这个函数给的。
 * 拿不到金额时返回 `undefined` —— 和别处一样，不用 0 冒充。
 */
export function redMagnitude(invoice: Invoice): Cents | undefined {
  if (!isRedInvoice(invoice)) return undefined;
  const total = invoiceTotal(invoice);
  return total === undefined ? undefined : Math.abs(total);
}

/**
 * 一张票最多按多少页处理。
 *
 * 页数会被预览、排版、打印**逐页展开**，所以它不能直接采信文件里的 `/Count`：
 * 一个 1 KB 的 PDF 可以声明 20 亿页。500 页对发票来说已经非常宽松
 * （医疗票据的明细页通常也就几页）。
 */
export const MAX_INVOICE_PAGES = 500;

/**
 * 实际要打印的**源文件页下标**（0 基，顺序即打印顺序）。
 *
 * 排版与打印都按「第几张要打的页」说话（`Slot.page` 是这个序号），
 * 由这里统一换算回源文件里的真实页号 —— 于是「剔除明细页」只需要维护一份 `skipPages`，
 * 不必让排版和打印各自记得哪些页不打印。
 */
export function printablePages(inv: Pick<Invoice, 'pageCount' | 'skipPages'>): number[] {
  const skip = new Set(inv.skipPages ?? []);
  const out: number[] = [];
  // 解析层已经夹过一次；这里再夹一次是兜底：页数可能来自旧备份或手改的库记录。
  // `Math.trunc(NaN)` 还是 NaN，`Math.max(1, NaN)` 也还是 NaN —— 必须单独判掉，
  // 否则整页列表会变成空的（最后靠下面那行兜成 [0]）。
  const raw = Math.trunc(inv.pageCount);
  const count = Number.isNaN(raw) ? 1 : Math.min(Math.max(1, raw), MAX_INVOICE_PAGES);
  for (let i = 0; i < count; i++) {
    if (!skip.has(i)) out.push(i);
  }
  // 理论上 skipPages 不会把页剔光（见 parse/medical.ts 的安全边界），兜一手
  return out.length > 0 ? out : [0];
}
