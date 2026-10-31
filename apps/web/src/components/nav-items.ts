import type { ViewKey } from '../state/store';

export interface NavItem {
  key: ViewKey;
  label: string;
}

/** 一级入口：首次使用与高频任务。查重排第一。 */
export const PRIMARY_NAV: NavItem[] = [
  { key: 'dedupe', label: '查重' },
  { key: 'excel', label: '转 Excel' },
  { key: 'library', label: '已报销库' },
];

/** 二级入口：需要时再从「更多」进入。 */
export const MORE_NAV: NavItem[] = [
  { key: 'merge', label: '排版打印' },
  { key: 'combine', label: '凑票' },
];
