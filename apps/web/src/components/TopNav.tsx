import { AddButton } from './AddButton';
import type { ViewKey } from '../state/store';
import { useStore } from '../state/store';

const TABS: Array<{ key: ViewKey; label: string }> = [
  { key: 'merge', label: '合并打印' },
  { key: 'dedupe', label: '查重' },
  { key: 'excel', label: '转 Excel' },
  { key: 'combine', label: '凑票' },
  { key: 'library', label: '已报销库' },
];

export function TopNav() {
  const { state, dispatch } = useStore();
  const showAdd = state.status === 'ready' && state.items.length > 0;

  return (
    <header className="topnav">
      <div className="brand">
        <span className="brand-logo" aria-hidden>
          票
        </span>
        发票工具
      </div>

      <nav className="tabs" aria-label="主导航">
        {TABS.map((tab) => (
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
