import './polyfills';
// 必须在 polyfills 之后：pdfjs 4 依赖 Promise.withResolvers
import './lib/pdfjs';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyTheme, watchSystemTheme } from './lib/theme';

// 主题在首帧之前定好，避免闪一下白/黑
applyTheme();
watchSystemTheme();

// 开发期把内核挂到 window.__invoiceDebug，便于在控制台直接排查
if (import.meta.env.DEV) {
  void import('./lib/debug').then((m) => m.installDebug());
}

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
