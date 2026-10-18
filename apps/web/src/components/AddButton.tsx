import { useRef } from 'react';

import { isDesktop, logLine, pickDocuments, readDocument } from '../lib/shell';
import { useStore } from '../state/store';
import { useIntake } from '../state/useIntake';

interface Props {
  className?: string;
  label?: string;
  variant?: 'primary' | 'ghost';
}

/**
 * 「添加发票」按钮 + 隐藏的 file input。
 * 拖放入口在 App 里统一处理，这里只负责「点」。
 *
 * 桌面版走**原生对话框**：拿到的是一串路径，按路径直接读字节，
 * 几 MB 的扫描件 / ZIP 不会先被复制进渲染进程再算哈希（网页版只能走 file input）。
 * 两条路最后都汇到 `intakeFromBytes`，解析链路一条。
 */
export function AddButton({ className = '', label = '添加发票', variant = 'primary' }: Props) {
  const { intake, intakeFromBytes, accept } = useIntake();
  const { dispatch } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const cls = (variant === 'primary' ? `btn btn-primary ${className}` : `btn ${className}`).trim();

  const choose = async (): Promise<void> => {
    if (!isDesktop()) {
      input.current?.click();
      return;
    }

    try {
      const picked = await pickDocuments();
      if (picked.length === 0) return;

      const entries: Array<{ name: string; data: Uint8Array }> = [];
      const failed: string[] = [];
      for (const file of picked) {
        try {
          entries.push({ name: file.name, data: await readDocument(file.path) });
        } catch (err) {
          failed.push(file.name);
          logLine(`read failed: ${file.path} ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (failed.length > 0) {
        dispatch({
          type: 'toast',
          toast: {
            text:
              entries.length === 0
                ? `这些文件都读不出来：${failed.slice(0, 3).join('、')}`
                : `有 ${failed.length} 个文件读不出来，已跳过：${failed.slice(0, 3).join('、')}`,
            actions: [{ label: '好', run: () => undefined }],
          },
        });
      }
      if (entries.length > 0) await intakeFromBytes(entries);
    } catch (err) {
      logLine(`pick failed: ${err instanceof Error ? err.message : String(err)}`);
      dispatch({
        type: 'toast',
        toast: {
          text: `打不开文件选择框：${err instanceof Error ? err.message : String(err)}`,
          actions: [{ label: '好', run: () => undefined }],
        },
      });
    }
  };

  return (
    <>
      <button type="button" className={cls} onClick={() => void choose()}>
        ＋ {label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        className="visually-hidden"
        onChange={(e) => {
          void intake(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}
