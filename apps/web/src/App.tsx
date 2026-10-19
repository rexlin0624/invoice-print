import { useEffect, useRef, useState } from 'react';

import { Drawer } from './components/Drawer';
import { HelpDialog } from './components/HelpDialog';
import { Toast } from './components/Toast';
import { TopNav } from './components/TopNav';
import { Combine } from './pages/Combine';
import { Dedupe } from './pages/Dedupe';
import { Excel } from './pages/Excel';
import { Library } from './pages/Library';
import { MergePrint } from './pages/MergePrint';
import { StoreProvider, useStore } from './state/store';
import { useIntake } from './state/useIntake';
import { useLibrarySync } from './state/useLibrarySync';

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const { state } = useStore();
  const { intake } = useIntake();
  const [dragOver, setDragOver] = useState(false);
  const depth = useRef(0);
  useLibrarySync();

  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragOver(true);
    };
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragOver(false);
    };
    const onDrop = (e: DragEvent): void => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      depth.current = 0;
      setDragOver(false);
      void intake(files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [intake]);

  /**
   * 剪贴板粘贴导入（Ctrl/⌘ + V）。
   *
   * 截图工具与「另存为图片」的发票，最常见的一步就是复制到剪贴板 ——
   * 比先存成文件再拖进来少两步。只在**标签页没有聚焦在输入框里**时才吃粘贴：
   * 否则用户在「公司抬头」输入框里粘贴税号会被当成导入发票。
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      void intake(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [intake]);

  const parsing = state.status === 'working' && state.items.length === 0;

  return (
    <>
      <TopNav />

      {parsing ? (
        <div className="empty">
          <h1>正在解析…</h1>
          <p className="lead">
            {state.progress
              ? `${state.progress.done} / ${state.progress.total} · ${state.progress.name}`
              : '读取文件中'}
          </p>
          {state.progress?.note && <p className="lead working">{state.progress.note}</p>}
          <p className="paste-hint">解析全部在本机进行，不上传任何文件。</p>
        </div>
      ) : state.view === 'merge' ? (
        <MergePrint />
      ) : state.view === 'dedupe' ? (
        <Dedupe />
      ) : state.view === 'excel' ? (
        <Excel />
      ) : state.view === 'combine' ? (
        <Combine />
      ) : (
        <Library />
      )}

      {state.fatal && <div className="banner error fatal">解析失败：{state.fatal}</div>}

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">松手即可添加发票</div>
        </div>
      )}

      <Drawer />
      <HelpDialog />
      <Toast />
    </>
  );
}
