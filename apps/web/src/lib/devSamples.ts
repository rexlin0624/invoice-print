/**
 * 开发用样本加载器。
 *
 * 只在 Vite dev 下存在。真票放在 `<repo>/samples/private/`，由 `vite.config.ts` 里的
 * `devSamples()` 中间件按 `/__samples__/*` 提供 —— **刻意不放 `public/`**，
 * 否则 Vite 会把真实发票拷进 `dist/`，一旦 `dist/` 被上传就等于公开了发票。
 *
 * 生产构建里 `import.meta.env.DEV` 为 false，函数直接返回空，代码被 tree-shake 掉。
 */

const MOUNT = '/__samples__/';

interface SampleIndex {
  files?: string[];
}

export async function devSampleNames(): Promise<string[]> {
  if (!import.meta.env.DEV) return [];
  try {
    const res = await fetch(`${MOUNT}index.json`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as SampleIndex;
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    return [];
  }
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  ofd: 'application/octet-stream',
  xml: 'application/xml',
  zip: 'application/zip',
};

export async function loadDevSamples(names: readonly string[]): Promise<File[]> {
  const out: File[] = [];
  for (const name of names) {
    const res = await fetch(`${MOUNT}${encodeURIComponent(name)}`);
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    out.push(new File([buf], name, { type: MIME[ext] ?? 'application/octet-stream' }));
  }
  return out;
}
