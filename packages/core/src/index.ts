/**
 * @invoice-tool/core —— 发票内核。
 *
 * 纯函数 + 纯数据，零 DOM、零 Node API、零 Rust。
 * 网页版与桌面端共用这一份。
 */

export * from './model/invoice';
export * from './model/money';

export * from './text/lines';
export * from './text/anchors';

export * from './pdf/renderRegion';

export * from './parse/index';
export * from './parse/fields';
export * from './parse/qr';
export * from './parse/xml';
export * from './parse/ofd';
export * from './parse/medical';
export * from './parse/pdfText';

export * from './validate/index';
export * from './validate/uscc';

export * from './dedupe/index';
export * from './layout/index';
export * from './combine/index';
export * from './export/invoices';
export * from './export/summary';
