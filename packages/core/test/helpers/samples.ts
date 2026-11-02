/**
 * 真票样本的发现逻辑（从 `samples.test.ts` 抽出来，好单独测）。
 *
 * 为什么抽：这段代码的价值全在「找不到样本时到底发生了什么」——
 * 静默跳过和「目录指错了」在输出上一模一样，而后者会让一整轮回归变成空跑。
 * 抽成纯函数后可以用临时目录直接测这几种情况，不必依赖 `samples/` 里真的有没有票。
 */

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库自带的位置（`samples/`，内容不入库） */
export const DEFAULT_SAMPLES_DIR = fileURLToPath(
  new URL('../../../../samples', import.meta.url),
);

/** 认的票据扩展名。`.zip` 不在内：压缩包由外壳展开，内核不直接吃 */
export const SAMPLE_EXTS = new Set(['.pdf', '.ofd', '.xml']);

/**
 * 样本目录：`SAMPLES_DIR` 环境变量优先，否则用仓库里的 `samples/`。
 *
 * 环境变量的意义：真票是个人数据，不能进公开仓库。开发者在自己的私有目录里放票，
 * 用 `SAMPLES_DIR=/path/to/private-samples pnpm test:samples` 跑一整轮真票回归，
 * 而不是把仓库复制一份改路径。
 */
export function resolveSamplesDir(override: string | undefined = process.env.SAMPLES_DIR): string {
  const value = override?.trim();
  return value ? resolve(value) : DEFAULT_SAMPLES_DIR;
}

/** 环境变量是否被显式指定（显式指定了却一张都没找到，应该报错而不是跳过） */
export function samplesDirWasExplicit(override: string | undefined = process.env.SAMPLES_DIR): boolean {
  return (override?.trim() ?? '') !== '';
}

export interface SampleFile {
  name: string;
  file: string;
  expected: Record<string, unknown>;
}

export interface SampleScan {
  /** 「票 + 同名 .expected.json」都齐了的 */
  samples: SampleFile[];
  /** 有票但没有期望文件的（下次跑还是会被跳过，列出来好让人补） */
  ignored: string[];
}

/** 扫一个目录（一层子目录）。目录不存在时返回空结果，不抛异常。 */
export async function loadSamples(dir: string): Promise<SampleScan> {
  const samples: SampleFile[] = [];
  const ignored: string[] = [];

  let dirs: string[] = [];
  try {
    dirs = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return { samples, ignored };
  }

  for (const sub of dirs) {
    let entries: string[];
    try {
      entries = await readdir(sub);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!SAMPLE_EXTS.has(extname(entry).toLowerCase())) continue;
      const expectedName = `${entry.replace(/\.[^.]+$/, '')}.expected.json`;
      if (!entries.includes(expectedName)) {
        ignored.push(join(sub, entry));
        continue;
      }
      const expected = JSON.parse(
        await readFile(join(sub, expectedName), 'utf8'),
      ) as Record<string, unknown>;
      samples.push({ name: entry, file: join(sub, entry), expected });
    }
  }

  return { samples, ignored };
}
