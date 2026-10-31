import { useEffect, useRef, useState } from 'react';

import { AddButton } from './AddButton';
import { MORE_NAV, PRIMARY_NAV } from './nav-items';
import { useStore } from '../state/store';

export function TopNav() {
  const { state, dispatch } = useStore();
  const showAdd = state.status === 'ready' && state.items.length > 0;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const moreActive = MORE_NAV.some((item) => item.key === state.view);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [moreOpen]);

  useEffect(() => {
    if (!moreActive) setMoreOpen(false);
  }, [moreActive]);

  /** 菜单键盘交互：Esc 关闭并把焦点还给「更多」；上下方向键在菜单项间移动 */
  const onMenuKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (!moreOpen) return;
      e.preventDefault();
      setMoreOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(
      moreRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    if (!moreOpen) {
      setMoreOpen(true);
      queueMicrotask(() => items[0]?.focus());
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <header className="topnav">
      <div className="brand">
        <span className="brand-logo" aria-hidden>
          票
        </span>
        发票工具
      </div>

      <nav className="tabs" aria-label="主导航">
        {PRIMARY_NAV.map((tab) => (
          <button
            key={tab.key}
            type="button"
            aria-current={state.view === tab.key ? 'page' : undefined}
            onClick={() => dispatch({ type: 'view', view: tab.key })}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* 不能放进 .tabs：它有 overflow-x:auto，绝对定位的弹层会被裁掉（overflow 一轴非 visible 时另一轴按 auto 算） */}
      <div className="more-menu" ref={moreRef} onKeyDown={onMenuKeyDown}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-current={moreActive ? 'page' : undefined}
          onClick={() => setMoreOpen((open) => !open)}
        >
          更多
        </button>
        {moreOpen && (
          <div className="more-menu-pop" role="menu">
            {MORE_NAV.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="menuitem"
                aria-current={state.view === tab.key ? 'page' : undefined}
                onClick={() => {
                  dispatch({ type: 'view', view: tab.key });
                  setMoreOpen(false);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="nav-right">
        <span className="privacy-badge" title="解析、排版、打印文件全部在你的浏览器里生成，文件不会上传">
          <span aria-hidden>🔒</span> 文件不上传，仅在本机处理
        </span>
        <button
          type="button"
          className="link"
          onClick={() => dispatch({ type: 'help', open: true })}
        >
          帮助
        </button>
        {showAdd && <AddButton />}
      </div>
    </header>
  );
}
