import { useEffect, useRef, useState } from 'react';

import { devSampleNames, loadDevSamples } from '../lib/devSamples';
import type { ViewKey } from '../state/store';
import { useStore } from '../state/store';
import { useIntake } from '../state/useIntake';
import { CheckIcon, UploadIcon } from './icons';

interface Props {
  dragOver: boolean;
  /** 空状态的标题；默认是主流程的「发票合并打印」 */
  title?: string;
  /** 空状态的一句话说明 */
  lead?: string;
  /** 次要入口：主流程之外的能力，按需进入 */
  links?: Array<{ label: string; view: ViewKey }>;
}

const CHECKS = [
  '自动识别金额与销售方',
  '重复发票自动跳过',
  '支持 PDF / OFD / XML / ZIP',
  '文件不上传，只在本机处理',
];

export function EmptyState({ dragOver, title, lead, links }: Props) {
  const { intake, accept } = useIntake();
  const { dispatch } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [devNames, setDevNames] = useState<string[]>([]);

  useEffect(() => {
    void devSampleNames().then(setDevNames);
  }, []);

  return (
    <div className="empty">
      <h1>{title ?? '发票合并打印'}</h1>
      <p className="lead">{lead ?? '拖进来，自动识别、去重、排好版。'}</p>

      <button
        type="button"
        className={dragOver ? 'dropzone over' : 'dropzone'}
        onClick={() => input.current?.click()}
        aria-label="选择发票文件"
      >
        <span className="dropzone-glyph" aria-hidden>
          <UploadIcon size={26} />
        </span>
        <span className="big">
          把发票拖到这里，或 <span className="hot">点击选择文件</span>
        </span>
        <span className="formats">
          支持 PDF · OFD · XML · ZIP 压缩包，可一次拖入多个；也能直接 Ctrl/⌘+V 粘贴截图
        </span>
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

      <ul className="checks">
        {CHECKS.map((c) => (
          <li key={c}>
            <CheckIcon />
            {c}
          </li>
        ))}
      </ul>

      {links && links.length > 0 && (
        <p className="empty-links">
          {links.map((link) => (
            <button
              key={link.view}
              type="button"
              className="link"
              onClick={() => dispatch({ type: 'view', view: link.view })}
            >
              {link.label}
            </button>
          ))}
        </p>
      )}

      <p className="paste-hint">
        扫描件与图片用本机 OCR 识别（离线，不联网）。发票一直在你的电脑上，不上传、不注册。
      </p>

      {devNames.length > 0 && (
        <p className="paste-hint dev-only">
          开发用：
          <button
            type="button"
            className="link"
            onClick={() => {
              void loadDevSamples(devNames).then((files) => intake(files));
            }}
          >
            载入 {devNames.length} 张真实样本发票
          </button>
        </p>
      )}
    </div>
  );
}
