import type { LayoutSettings, Margin, Orientation, PerPage } from '@invoice-tool/core';
import { useEffect, useState } from 'react';

import type { ThemePreference } from '../lib/theme';
import { setThemePreference, themePreference } from '../lib/theme';
import { useStore } from '../state/store';
import { CloseIcon } from './icons';

const PER_PAGE: Array<{ value: PerPage; label: string }> = [
  { value: 1, label: '1 张（1 行 × 1 列）' },
  { value: 2, label: '2 张（2 行 × 1 列）' },
  { value: 4, label: '4 张（2 行 × 2 列）' },
];

const ORIENTATION: Array<{ value: Orientation; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'portrait', label: '竖向' },
  { value: 'landscape', label: '横向' },
];

const MARGIN: Array<{ value: Margin; label: string }> = [
  { value: 'narrow', label: '窄' },
  { value: 'normal', label: '标准' },
  { value: 'wide', label: '宽' },
];

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export function Drawer() {
  const { state, dispatch } = useStore();
  const open = state.drawerOpen;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dispatch({ type: 'drawer', open: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dispatch]);

  if (!open) return null;

  const set = (patch: Partial<LayoutSettings>): void => {
    dispatch({ type: 'settings', patch });
  };
  const close = (): void => dispatch({ type: 'drawer', open: false });

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="drawer" role="dialog" aria-label="更多设置" aria-modal>
        <div className="drawer-head">
          更多设置
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          <section className="group">
            <h3>纸张与排版</h3>
            <Row label="纸张">
              <select value="a4" onChange={() => undefined}>
                <option value="a4">A4</option>
              </select>
            </Row>
            <Row label="方向" hint="自动 = 哪种更省纸用哪种">
              <select
                value={state.settings.orientation}
                onChange={(e) => set({ orientation: e.target.value as Orientation })}
              >
                {ORIENTATION.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="每页张数">
              <select
                value={state.settings.perPage}
                onChange={(e) => set({ perPage: Number(e.target.value) as PerPage })}
              >
                {PER_PAGE.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="页边距">
              <div className="seg" role="group" aria-label="页边距">
                {MARGIN.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={state.settings.margin === o.value}
                    onClick={() => set({ margin: o.value })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="允许旋转 90°" hint="票会侧躺，但更省纸">
              <Switch
                checked={state.settings.allowRotation}
                onChange={(v) => set({ allowRotation: v })}
              />
            </Row>
          </section>

          <section className="group">
            <h3>打印效果</h3>
            <Row label="裁切线" hint="每张票四角画虚线，方便裁开">
              <Switch checked={state.settings.cutLines} onChange={(v) => set({ cutLines: v })} />
            </Row>
            <Row label="裁掉白边" hint="只裁单页票；多页票各页边界不同，不裁更安全">
              <Switch
                checked={state.settings.cropWhitespace}
                onChange={(v) => set({ cropWhitespace: v })}
              />
            </Row>
            <Row label="页脚页码">
              <Switch
                checked={state.settings.pageNumbers}
                onChange={(v) => set({ pageNumbers: v })}
              />
            </Row>
            <Row label="黑白打印" hint="转成纯黑白，省墨、字更实">
              <Switch
                checked={state.settings.blackWhite}
                onChange={(v) => set({ blackWhite: v })}
              />
            </Row>
            <Row label="老打印机兼容" hint="整份转成图片，牺牲清晰度换兼容">
              <Switch
                checked={state.settings.rasterCompat}
                onChange={(v) => set({ rasterCompat: v })}
              />
            </Row>
          </section>

          <section className="group">
            <h3>分组与识别</h3>
            <Row label="火车票 / 行程单单独成页" hint="尺寸差太多，混排会很难看">
              <Switch
                checked={state.settings.groupTickets}
                onChange={(v) => set({ groupTickets: v })}
              />
            </Row>
            <Row label="专票与普票分开">
              <Switch
                checked={state.settings.separateTaxType}
                onChange={(v) => set({ separateTaxType: v })}
              />
            </Row>
            <Row label="导入时自动跳过重复" hint="文件相同或发票号码相同">
              <Switch
                checked={state.prefs.autoDedupe}
                onChange={(v) => dispatch({ type: 'prefs', patch: { autoDedupe: v } })}
              />
            </Row>
            <Row label="打印后提示标记已报销">
              <Switch
                checked={state.prefs.remindReimburse}
                onChange={(v) => dispatch({ type: 'prefs', patch: { remindReimburse: v } })}
              />
            </Row>
            <Row label="火车票 / 行程单的识别">
              <Soon>
                <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>未支持</span>
              </Soon>
            </Row>
            <Row
              label="扫描件用本机 OCR 识别"
              hint="没有文字层的 PDF 与图片会在这台电脑上离线识别（慢，不上传）"
            >
              <Switch
                checked={state.prefs.ocr}
                onChange={(v) => dispatch({ type: 'prefs', patch: { ocr: v } })}
              />
            </Row>
            <OcrModelNotice />
          </section>

          <section className="group">
            <h3>报销设置（用于风险提示）</h3>
            <Row label="公司抬头" hint="填了就会提示抬头不一致的票">
              <input
                type="text"
                placeholder="未设置"
                value={state.prefs.companyName}
                onChange={(e) => dispatch({ type: 'prefs', patch: { companyName: e.target.value } })}
              />
            </Row>
            <Row label="公司税号">
              <input
                type="text"
                placeholder="18 位统一社会信用代码"
                value={state.prefs.companyTaxId}
                onChange={(e) => dispatch({ type: 'prefs', patch: { companyTaxId: e.target.value } })}
              />
            </Row>
            <Row label="已报销状态保存到本机" hint="存字段与原文件，可搜索、可「再打一份」">
              <Switch
                checked={state.prefs.saveLibrary}
                onChange={(v) => dispatch({ type: 'prefs', patch: { saveLibrary: v } })}
              />
            </Row>
          </section>

          <section className="group">
            <h3>界面</h3>
            <ThemeRow />
          </section>
        </div>

        <div className="drawer-foot">
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: 'settings/reset' })}
          >
            恢复默认
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" onClick={close}>
            完成
          </button>
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="row">
      <span className="label">
        {label}
        {hint && <span className="sub">{hint}</span>}
      </span>
      <span className="control">{children}</span>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <span className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span />
    </span>
  );
}

/** 标注「还没做」的开关，避免让人以为是坏的 */
function Soon({ children }: { children: React.ReactNode }) {
  return (
    <span className="soon">
      {children}
      <span className="m2">M2</span>
    </span>
  );
}

/**
 * OCR 模型装没装 —— 不装的话扫描件只能从二维码取到三个字段，
 * 而用户看到的是「销售方未识别」，根本猜不到原因。所以在这里挑明。
 */
function OcrModelNotice() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    void import('../lib/ocr')
      .then((ocr) => ocr.ocrAssetsReady())
      .then((ready) => {
        if (alive) setMissing(!ready);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!missing) return null;
  return (
    <p className="help-note" style={{ marginTop: 6 }}>
      没检测到离线 OCR 中文模型（约 24 MB）。在项目目录执行一次
      <code> pnpm ocr:prepare </code>
      再刷新本页即可；模型只在这台电脑上，发票不会被上传。
    </p>
  );
}

function ThemeRow() {
  const [pref, setPref] = useState<ThemePreference>(themePreference);
  return (
    <Row label="主题" hint="默认跟随系统">
      <div className="seg" role="group" aria-label="主题">
        {THEMES.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={pref === t.value}
            onClick={() => {
              setThemePreference(t.value);
              setPref(t.value);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
    </Row>
  );
}
