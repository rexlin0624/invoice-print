import { useEffect, useRef, useState } from 'react';

import { devSampleNames, loadDevSamples } from '../lib/devSamples';
import { useIntake } from '../state/useIntake';
import { CheckIcon, UploadIcon } from './icons';

interface Props {
  dragOver: boolean;
}

const CHECKS = ['全电 / 数电发票', '自动识别金额与销售方', '重复发票自动跳过', '一页 2 / 4 张'];

export function EmptyState({ dragOver }: Props) {
  const { intake, accept } = useIntake();
  const input = useRef<HTMLInputElement>(null);
  const [devNames, setDevNames] = useState<string[]>([]);

  useEffect(() => {
    void devSampleNames().then(setDevNames);
  }, []);

  return (
    <div className="empty">
      <h1>发票合并打印</h1>
      <p className="lead">拖进来，自动识别、去重、排好版。</p>

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
