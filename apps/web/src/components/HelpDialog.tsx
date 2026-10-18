import { useCallback, useEffect, useState } from 'react';

import { formatBytes } from '../lib/format';
import { BACKUP_NAME } from '../lib/libraryBackup';
import type { AppInfo, StoreEntry } from '../lib/shell';
import { LOG_NAME, appInfo, isDesktop, revealPath, storeList, storeRemove } from '../lib/shell';
import { useStore } from '../state/store';
import { CloseIcon } from './icons';

const STEPS = [
  ['把发票拖进来', 'PDF、OFD、XML 或 ZIP 压缩包都行，可以一次拖很多张。'],
  ['看一眼预览', '自动识别金额与销售方；重复的发票会自动跳过，但不会动你的文件。'],
  ['点「打印」或「下载 PDF」', '按 A4 排好版，一张最多放 4 张票，带裁切线。'],
];

export function HelpDialog() {
  const { state, dispatch } = useStore();
  const open = state.helpOpen;
  const close = (): void => dispatch({ type: 'help', open: false });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="modal" role="dialog" aria-label="帮助" aria-modal>
        <div className="drawer-head">
          怎么用
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          <ol className="steps">
            {STEPS.map(([title, body]) => (
              <li key={title}>
                <b>{title}</b>
                <span>{body}</span>
              </li>
            ))}
          </ol>

          <section className="group">
            <h3>功能放哪儿了</h3>
            <ul className="layers">
              <li>
                <b>主流程</b>：拖进来 → 打印。首屏只有这一个动作。
              </li>
              <li>
                <b>列表上方</b>：添加、按日期排序、清空、导出 Excel —— 用得到才出现。
              </li>
              <li>
                <b>更多设置</b>：纸张方向、每页张数、裁切线、报销设置。默认值就能用，不用管。
              </li>
              <li>
                <b>独立页面</b>：查重、转 Excel、凑票、已报销库（M2–M3 逐步补齐）。
              </li>
            </ul>
          </section>

          <section className="group">
            <h3>隐私</h3>
            <p className="help-note">
              解析、排版、打印文件全部在你的浏览器里生成，发票不会上传到任何服务器，
              断网也能用。本项目没有账号系统。
            </p>
          </section>

          {/* 桌面版才有：版本 / 数据在哪 / 一键打开。网页版没有「数据目录」这个概念 */}
          {isDesktop() && <DesktopSection />}
        </div>

        <div className="drawer-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-primary" onClick={close}>
            知道了
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 帮助里的「桌面版」一栏。
 *
 * 回答三个只有桌面版才有的问题：这是哪个版本、我的数据存在哪、怎么备份。
 * 数据目录里放两样东西：**本机库的清单备份**（清浏览数据后还能恢复报销记录）
 * 和**本地日志**（出问题时发给开发者）。
 */
function DesktopSection() {
  const [info, setInfo] = useState<AppInfo | undefined>(undefined);
  const [files, setFiles] = useState<StoreEntry[]>([]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setInfo(await appInfo());
      setFiles(await storeList());
    } catch {
      // 外壳出问题也不该让帮助页崩 —— 拿不到就不显示这一段
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!info) return null;

  const log = files.find((file) => file.name === LOG_NAME);
  const backup = files.find((file) => file.name === BACKUP_NAME);

  return (
    <section className="group">
      <h3>桌面版</h3>
      <p className="help-note">
        {info.name} {info.version} · {info.os}/{info.arch}
        {info.debug ? ' · 开发构建' : ''}
      </p>
      <p className="help-note">
        数据目录：<code>{info.dataDir}</code>
      </p>
      <div className="row-inline">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void revealPath(info.dataDir).catch(() => undefined);
          }}
        >
          在文件管理器里显示
        </button>
        {log && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void storeRemove(LOG_NAME)
                .then(reload)
                .catch(() => undefined);
            }}
          >
            清空日志（{formatBytes(log.size)}）
          </button>
        )}
      </div>
      <p className="muted">
        {backup
          ? `本机库备份：${new Date(backup.modified).toLocaleString('zh-CN')} 写入，${formatBytes(backup.size)}。`
          : '还没有本机库备份 —— 打印并「标记已报销」之后会自动生成一份。'}
        备份与日志都在数据目录里，清浏览数据不会带走它们。
      </p>
    </section>
  );
}
