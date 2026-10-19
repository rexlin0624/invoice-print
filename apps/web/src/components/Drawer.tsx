import type { LayoutSettings, Margin, Orientation, PerPage } from '@invoice-tool/core';
import { OFFSET_LIMIT_MM, clampOffsetMm } from '@invoice-tool/core';
import { useEffect, useState } from 'react';

import { buildCalibrationPdf } from '../lib/calib';
import { printPdf } from '../lib/print';
import type { LayoutPreset } from '../lib/presets';
import { deletePreset, describePreset, listPresets, savePreset } from '../lib/presets';
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
  const [presets, setPresets] = useState<LayoutPreset[]>(() => listPresets());
  const [presetName, setPresetName] = useState('');
  const [calibBusy, setCalibBusy] = useState(false);
  /**
   * 偏移输入框的**文本**副本。
   *
   * 为什么不直接把 `number` 绑到 value 上：用户打「-3」的第一个字符是「-」，
   * 当场 clamp 成 0 会把刚打的字吞掉（光标跳、数字变 0）。所以先留文本，
   * 能解析出数字才写回设置。
   */
  const [offsetText, setOffsetText] = useState({ x: '0', y: '0' });

  useEffect(() => {
    if (!open) return;
    setOffsetText({ x: String(state.settings.offsetXMm), y: String(state.settings.offsetYMm) });
    setPresets(listPresets());
    // 只在打开抽屉时同步一次：打字过程中不要被设置回灌
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  /** 打一张校准测试页：不走「合并打印」，直接生成一页 PDF 交给系统打印 */
  const printCalibration = async (): Promise<void> => {
    setCalibBusy(true);
    try {
      const bytes = await buildCalibrationPdf(state.settings);
      const result = await printPdf(bytes, '打印校准测试页.pdf');
      dispatch({ type: 'toast', toast: { text: result.message, actions: [] } });
    } catch (err) {
      dispatch({
        type: 'toast',
        toast: { text: `校准页生成失败：${err instanceof Error ? err.message : String(err)}`, actions: [] },
      });
    } finally {
      setCalibBusy(false);
    }
  };

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
            <h3>打印校准</h3>
            <Row label="偏移 X（mm）" hint="打出来整体偏右就填负数，偏左填正数">
              <input
                type="number"
                step="0.5"
                min={-OFFSET_LIMIT_MM}
                max={OFFSET_LIMIT_MM}
                value={offsetText.x}
                onChange={(e) => {
                  const raw = e.target.value;
                  setOffsetText((prev) => ({ ...prev, x: raw }));
                  if (raw.trim() !== '' && Number.isFinite(Number(raw))) set({ offsetXMm: clampOffsetMm(raw) });
                }}
                onBlur={() => setOffsetText((prev) => ({ ...prev, x: String(clampOffsetMm(prev.x)) }))}
              />
            </Row>
            <Row label="偏移 Y（mm）" hint="打出来整体偏下就填负数，偏上填正数">
              <input
                type="number"
                step="0.5"
                min={-OFFSET_LIMIT_MM}
                max={OFFSET_LIMIT_MM}
                value={offsetText.y}
                onChange={(e) => {
                  const raw = e.target.value;
                  setOffsetText((prev) => ({ ...prev, y: raw }));
                  if (raw.trim() !== '' && Number.isFinite(Number(raw))) set({ offsetYMm: clampOffsetMm(raw) });
                }}
                onBlur={() => setOffsetText((prev) => ({ ...prev, y: String(clampOffsetMm(prev.y)) }))}
              />
            </Row>
            <Row label="不知道偏多少？" hint="打一张带方格与直尺的测试页，量一下再填">
              <button type="button" className="btn btn-sm" disabled={calibBusy} onClick={() => void printCalibration()}>
                {calibBusy ? '生成中…' : '打印校准测试页'}
              </button>
            </Row>
            <p className="help-note" style={{ margin: '2px 0 6px' }}>
              测试页要按 <b>100% / 实际大小</b> 打，别勾「适应页面」。量蓝框到纸边的四边距离：
              偏右就 X 填负数、偏下就 Y 填负数。直尺量出来不是 100 mm 说明打印机在缩放，
              那是驱动设置的问题，别用偏移去凑。
            </p>
            {(state.settings.offsetXMm !== 0 || state.settings.offsetYMm !== 0) && (
              <Row label="当前偏移">
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    set({ offsetXMm: 0, offsetYMm: 0 });
                    setOffsetText({ x: '0', y: '0' });
                  }}
                >
                  归零（X {state.settings.offsetXMm} / Y {state.settings.offsetYMm} mm）
                </button>
              </Row>
            )}
          </section>

          <section className="group">
            <h3>排版预设</h3>
            <Row label="存下当前设置" hint="比如「报销季 4 张窄边距」，下次一键切回">
              <div className="row-inline">
                <input
                  type="text"
                  placeholder="预设名称"
                  maxLength={24}
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={presetName.trim() === ''}
                  onClick={() => {
                    setPresets(savePreset(presetName, state.settings));
                    setPresetName('');
                  }}
                >
                  保存
                </button>
              </div>
            </Row>
            {presets.length === 0 ? (
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
                还没有预设。存一个以后，换纸型、换打印机都不用再点五下。
              </p>
            ) : (
              <ul className="preset-list">
                {presets.map((preset) => (
                  <li key={preset.name}>
                    <div>
                      <b>{preset.name}</b>
                      <span className="sub">{describePreset(preset.settings)}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        set(preset.settings);
                        setOffsetText({
                          x: String(preset.settings.offsetXMm),
                          y: String(preset.settings.offsetYMm),
                        });
                      }}
                    >
                      应用
                    </button>
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => setPresets(deletePreset(preset.name))}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
            onClick={() => {
              dispatch({ type: 'settings/reset' });
              setOffsetText({ x: '0', y: '0' });
            }}
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
