import type {
  CorrectPatch,
  DuplicateGroup,
  Issue,
  LayoutSettings,
  Orientation,
  PerPage,
} from '@invoice-tool/core';
import {
  DEFAULT_LAYOUT_SETTINGS,
  applyCorrection,
  findDuplicates,
  isAutoDropLevel,
  normalizeLayoutSettings,
  validateInvoice,
} from '@invoice-tool/core';
import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useReducer } from 'react';

import type { Box } from '../lib/box';
import type { IntakeItem, IntakeProgress } from '../lib/intake';

export type ViewKey = 'merge' | 'dedupe' | 'excel' | 'combine' | 'library';

/** 一张票在本机被处理到了哪一步。M1 只活在内存里；M2 落到已报销库。 */
export type Mark = 'printed' | 'reimbursed';

export interface Prefs {
  companyName: string;
  companyTaxId: string;
  /** 导入时自动跳过重复 */
  autoDedupe: boolean;
  /** 打印后提示标记已报销 */
  remindReimburse: boolean;
  /** 标记后把票（字段 + 原文件）存进本机已报销库 */
  saveLibrary: boolean;
  /** 扫描件/图片用本机离线 OCR 识别（慢，但只在本机跑） */
  ocr: boolean;
}

export interface ToastState {
  text: string;
  actions: Array<{ label: string; primary?: boolean; run: () => void }>;
}

export interface AppState {
  view: ViewKey;
  items: IntakeItem[];
  status: 'empty' | 'working' | 'ready';
  progress: IntakeProgress | null;
  /** 被自动跳过（重复）的 item id */
  skipped: string[];
  dedupeGroups: DuplicateGroup[];
  /** 用户在横幅上点了「撤销跳过」 */
  dedupeUndone: boolean;
  settings: LayoutSettings;
  prefs: Prefs;
  drawerOpen: boolean;
  helpOpen: boolean;
  selectedId: string | null;
  /** 正在校正哪一张票（弹窗开着的时候非空）。放 state 里是为了让列表、预览都能发起校正 */
  correctingId: string | null;
  marks: Record<string, Mark>;
  toast: ToastState | null;
  fatal: string | null;
}

const PREFS_KEY = 'invoice-tool.prefs.v1';
const SETTINGS_KEY = 'invoice-tool.layout.v1';

function loadJson<T extends object>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as object) } as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

const DEFAULT_PREFS: Prefs = {
  companyName: '',
  companyTaxId: '',
  autoDedupe: true,
  remindReimburse: true,
  saveLibrary: true,
  ocr: true,
};

/**
 * localStorage 里的 `prefs` 也是**外部输入**（同机其他程序、旧版本、手改都能写）。
 * 只取认识的键、类型不对就回默认值，别把任意对象当设置用：
 * `companyTaxId` 会进校验与导出，布尔值走 `if (prefs.autoDedupe)` 这类判断，
 * 一个字符串 `"false"` 反而为真。
 */
function normalizePrefs(value: unknown): Prefs {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof Prefs, unknown>
  >;
  const text = (v: unknown, fallback: string, maxLength: number): string =>
    typeof v === 'string' ? v.slice(0, maxLength) : fallback;
  const flag = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;

  return {
    companyName: text(source.companyName, DEFAULT_PREFS.companyName, 200),
    companyTaxId: text(source.companyTaxId, DEFAULT_PREFS.companyTaxId, 64),
    autoDedupe: flag(source.autoDedupe, DEFAULT_PREFS.autoDedupe),
    remindReimburse: flag(source.remindReimburse, DEFAULT_PREFS.remindReimburse),
    saveLibrary: flag(source.saveLibrary, DEFAULT_PREFS.saveLibrary),
    ocr: flag(source.ocr, DEFAULT_PREFS.ocr),
  };
}

export function initialState(): AppState {
  return {
    view: 'dedupe',
    items: [],
    status: 'empty',
    progress: null,
    skipped: [],
    dedupeGroups: [],
    dedupeUndone: false,
    settings: normalizeLayoutSettings(loadJson<LayoutSettings>(SETTINGS_KEY, DEFAULT_LAYOUT_SETTINGS)),
    prefs: normalizePrefs(loadJson<Prefs>(PREFS_KEY, DEFAULT_PREFS)),
    drawerOpen: false,
    helpOpen: false,
    selectedId: null,
    correctingId: null,
    marks: {},
    toast: null,
    fatal: null,
  };
}

export type Action =
  | { type: 'view'; view: ViewKey }
  | { type: 'intake/start' }
  | { type: 'intake/progress'; progress: IntakeProgress }
  | { type: 'intake/done'; items: IntakeItem[] }
  | { type: 'intake/fatal'; message: string }
  | { type: 'clear' }
  | { type: 'remove'; id: string }
  | { type: 'sort'; by: 'date' | 'amount' | 'seller' }
  | { type: 'skip'; id: string; skip: boolean }
  | { type: 'skip/many'; ids: string[]; skip: boolean }
  | { type: 'dedupe/undo' }
  | { type: 'settings'; patch: Partial<LayoutSettings> }
  | { type: 'settings/reset' }
  | { type: 'perPage'; perPage: PerPage }
  | { type: 'orientation'; orientation: Orientation }
  | { type: 'prefs'; patch: Partial<Prefs> }
  | { type: 'drawer'; open: boolean }
  | { type: 'help'; open: boolean }
  | { type: 'select'; id: string | null }
  | { type: 'correcting'; id: string | null }
  | { type: 'correct'; id: string; patch: CorrectPatch }
  | { type: 'printed'; ids: string[] }
  | { type: 'reimbursed'; ids: string[] }
  | { type: 'crop/set'; crops: Record<string, Box | null | undefined> }
  | { type: 'crop/clear' }
  | { type: 'toast'; toast: ToastState | null };

/** 新建/删除票之后，重新算哪些该被跳过 */
function applyAutoDedupe(
  items: IntakeItem[],
  prefs: Prefs,
): Pick<AppState, 'skipped' | 'dedupeGroups'> {
  if (!prefs.autoDedupe) return { skipped: [], dedupeGroups: [] };
  const result = findDuplicates(items.map((it) => it.invoice));
  const skipped: string[] = [];
  for (const group of result.groups) {
    // 只有文件级与「代码 + 号码」级能自动跳过；OCR 撞号、疑似重复只标记。
    if (!isAutoDropLevel(group.level)) continue;
    skipped.push(...group.drop);
  }
  return { skipped, dedupeGroups: result.groups };
}

/** 只把状态往上推，不往回退：已报销的票不会退回「已打印」 */
function raise(marks: Record<string, Mark>, ids: readonly string[], to: Mark): Record<string, Mark> {
  const next = { ...marks };
  for (const id of ids) {
    if (next[id] === 'reimbursed') continue;
    next[id] = to;
  }
  return next;
}

/**
 * 字段被人工改过之后，把「自动跳过」的名单对齐一遍。
 *
 * 为什么不能整份重算：`skipped` 里混着两种东西 —— 系统判出来的重复（自动）与
 * 用户在「不打印这张」上做的选择（手工）。整份重算会把手工选择抹掉，
 * 而用户改一个字段并不等于他改变了对其它票的主意。
 * 所以只做两件事：不再重复的自动项放出来、新重复的自动项收进去。
 */
function reconcileSkips(
  state: AppState,
  items: IntakeItem[],
): Pick<AppState, 'skipped' | 'dedupeGroups'> {
  const next = applyAutoDedupe(items, state.prefs);
  // 关掉自动去重、或用户点过「撤销，全部打印」时，**不动 skipped** ——
  // 后者的意思是「这些重复我都要打」，改一个字段不该把这个决定撤销掉。
  // （查重分组仍然刷新，否则「查重」页会拿着改之前的旧分组。）
  if (!state.prefs.autoDedupe || state.dedupeUndone) {
    return { skipped: state.skipped, dedupeGroups: next.dedupeGroups };
  }

  const wasAuto = new Set(
    state.dedupeGroups.filter((g) => isAutoDropLevel(g.level)).flatMap((g) => g.drop),
  );
  const isAuto = new Set(next.skipped);
  const skipped = new Set(state.skipped);
  for (const id of wasAuto) if (!isAuto.has(id)) skipped.delete(id);
  for (const id of isAuto) skipped.add(id);
  return { skipped: [...skipped], dedupeGroups: next.dedupeGroups };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'view':
      return { ...state, view: action.view, toast: null };

    case 'intake/start':
      return { ...state, status: 'working', progress: null, fatal: null, toast: null };

    case 'intake/progress':
      return { ...state, progress: action.progress };

    case 'intake/done': {
      if (action.items.length === 0) {
        return { ...state, status: state.items.length > 0 ? 'ready' : 'empty', progress: null };
      }
      const merged = [...state.items, ...action.items];
      return {
        ...state,
        items: merged,
        status: 'ready',
        progress: null,
        selectedId: state.selectedId ?? action.items[0]!.id,
        ...applyAutoDedupe(merged, state.prefs),
      };
    }

    case 'intake/fatal':
      return {
        ...state,
        status: state.items.length > 0 ? 'ready' : 'empty',
        progress: null,
        fatal: action.message,
      };

    case 'clear':
      return {
        ...state,
        items: [],
        status: 'empty',
        skipped: [],
        dedupeGroups: [],
        selectedId: null,
        correctingId: null,
        progress: null,
        fatal: null,
        marks: {},
      };

    case 'remove': {
      const items = state.items.filter((it) => it.id !== action.id);
      const marks = { ...state.marks };
      delete marks[action.id];
      if (items.length === 0) return reducer(state, { type: 'clear' });
      return {
        ...state,
        items,
        marks,
        selectedId: state.selectedId === action.id ? (items[0]?.id ?? null) : state.selectedId,
        correctingId: state.correctingId === action.id ? null : state.correctingId,
        ...applyAutoDedupe(items, state.prefs),
      };
    }

    case 'sort': {
      const rank = (it: IntakeItem): number | string => {
        const inv = it.invoice;
        if (action.by === 'date') return inv.issueDate ?? '9999-99-99';
        if (action.by === 'amount') return -(inv.total ?? inv.amount ?? 0);
        return inv.sellerName ?? 'zzz';
      };
      const items = [...state.items].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (typeof ra === 'number' && typeof rb === 'number') return ra - rb;
        return String(ra).localeCompare(String(rb), 'zh-Hans-CN');
      });
      return { ...state, items };
    }

    case 'skip': {
      const set = new Set(state.skipped);
      if (action.skip) set.add(action.id);
      else set.delete(action.id);
      return { ...state, skipped: [...set] };
    }

    case 'skip/many': {
      const set = new Set(state.skipped);
      for (const id of action.ids) {
        if (action.skip) set.add(id);
        else set.delete(id);
      }
      return { ...state, skipped: [...set], dedupeUndone: false };
    }

    case 'dedupe/undo':
      return { ...state, skipped: [], dedupeUndone: true };

    case 'settings': {
      // 收敛之后再存：界面上来的值也要过一遍白名单，否则脏值会被写进 localStorage
      const settings = normalizeLayoutSettings({ ...state.settings, ...action.patch });
      saveJson(SETTINGS_KEY, settings);
      return { ...state, settings };
    }

    case 'settings/reset':
      saveJson(SETTINGS_KEY, DEFAULT_LAYOUT_SETTINGS);
      return { ...state, settings: DEFAULT_LAYOUT_SETTINGS };

    case 'perPage':
      return reducer(state, { type: 'settings', patch: { perPage: action.perPage } });

    case 'orientation':
      return reducer(state, { type: 'settings', patch: { orientation: action.orientation } });

    case 'prefs': {
      const prefs = normalizePrefs({ ...state.prefs, ...action.patch });
      saveJson(PREFS_KEY, prefs);
      const toggled =
        action.patch.autoDedupe !== undefined && action.patch.autoDedupe !== state.prefs.autoDedupe;
      if (!toggled) return { ...state, prefs };
      return { ...state, prefs, ...applyAutoDedupe(state.items, prefs) };
    }

    case 'drawer':
      return { ...state, drawerOpen: action.open };

    case 'help':
      return { ...state, helpOpen: action.open };

    case 'select':
      return { ...state, selectedId: action.id };

    case 'correcting':
      return { ...state, correctingId: action.id };

    case 'correct': {
      const at = state.items.findIndex((it) => it.id === action.id);
      if (at < 0) return state;
      const item = state.items[at]!;
      const invoice = applyCorrection(item.invoice, action.patch);
      const items = [...state.items];
      items[at] = { ...item, invoice };
      // 号码/金额是去重的依据，改完必须重算一次（见 reconcileSkips）
      return { ...state, items, ...reconcileSkips(state, items) };
    }

    case 'printed':
      return { ...state, marks: raise(state.marks, action.ids, 'printed') };

    case 'reimbursed':
      return { ...state, marks: raise(state.marks, action.ids, 'reimbursed') };

    case 'crop/set': {
      // 一张票的裁剪框只算一次；已经有的不覆盖（重复探测没意义，还会让预览闪）
      let changed = false;
      const items = state.items.map((it) => {
        if (!(it.id in action.crops)) return it;
        if (it.crop !== undefined) return it;
        const box = action.crops[it.id];
        // `box === undefined` 表示「探测过、不需要裁」→ 记成 `null`，
        // 否则和「还没探测」无法区分，探测 effect 会无限重跑（见 IntakeItem.crop）
        changed = true;
        return { ...it, crop: box ?? null };
      });
      return changed ? { ...state, items } : state;
    }

    case 'crop/clear': {
      const items = state.items.map((it) =>
        it.crop === undefined ? it : { ...it, crop: undefined },
      );
      return { ...state, items };
    }

    case 'toast':
      return { ...state, toast: action.toast };

    default:
      return state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: (action: Action) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore 必须在 StoreProvider 内使用');
  return value;
}

/** 当前要打印的票（排除被跳过的） */
export function toPrint(state: AppState): IntakeItem[] {
  const skipped = new Set(state.skipped);
  return state.items.filter((it) => !skipped.has(it.id));
}

/** 各票的校验问题。纯函数派生，不进 state（改了字段立刻重算）。 */
export function useProblems(): Map<string, Issue[]> {
  const { state } = useStore();
  const { items, prefs } = state;
  return useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const options = {
      companyName: prefs.companyName,
      companyTaxId: prefs.companyTaxId,
      today,
    };
    const map = new Map<string, Issue[]>();
    for (const item of items) map.set(item.id, validateInvoice(item.invoice, options));
    return map;
  }, [items, prefs.companyName, prefs.companyTaxId]);
}

/** 各状态的票数，给列表顶部和底部汇总用 */
export function tally(marks: Record<string, Mark>, items: readonly IntakeItem[]): {
  printed: number;
  reimbursed: number;
} {
  let printed = 0;
  let reimbursed = 0;
  for (const item of items) {
    const mark = marks[item.id];
    if (mark === 'reimbursed') reimbursed += 1;
    else if (mark === 'printed') printed += 1;
  }
  return { printed, reimbursed };
}
