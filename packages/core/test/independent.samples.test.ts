/**
 * 独立验收：真票样本目录的解析（N-03 · 路径部分）。
 *
 * 只钉「默认目录到底指哪儿」和「SAMPLES_DIR 的优先级」——
 * 这两条错了，回归会静默跑在空目录上（或者跑错仓库位置），而输出看起来一样。
 *
 * 目录不存在 / 空的「必须失败」属于**进程级**行为，由 `SAMPLES_DIR=… pnpm test:samples`
 * 验证（见报告），这里只测纯函数。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_SAMPLES_DIR, loadSamples, resolveSamplesDir, samplesDirWasExplicit } from './helpers/samples';

/** 仓库根（本文件在 packages/core/test/ 下） */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

describe('默认样本目录指向仓库根的 samples/', () => {
  it('就是 <repo>/samples，不是 packages/core/samples、也不是 dist 下', () => {
    expect(DEFAULT_SAMPLES_DIR).toBe(resolve(REPO_ROOT, 'samples'));
  });

  it('该路径确实存在（仓库自带，至少有一份 README）', async () => {
    const scan = await loadSamples(DEFAULT_SAMPLES_DIR);
    expect(Array.isArray(scan.samples)).toBe(true);
  });

  it('没有子目录时不会去别的目录捡样本', async () => {
    const dir = await tmp('samples-ind-');
    await writeFile(join(dir, 'stray.pdf'), '%PDF-1.4');
    await writeFile(join(dir, 'stray.expected.json'), '{}');
    const scan = await loadSamples(dir);
    expect(scan.samples).toEqual([]);
  });
});

describe('SAMPLES_DIR 的优先级与形态', () => {
  it('环境变量优先于默认目录', () => {
    expect(resolveSamplesDir('/tmp/x')).toBe('/tmp/x');
    expect(resolveSamplesDir('/tmp/x')).not.toBe(DEFAULT_SAMPLES_DIR);
  });

  it('空白值等于没设置（不能把 cwd 当样本目录）', () => {
    for (const v of ['', '   ', '\t']) {
      expect(resolveSamplesDir(v)).toBe(DEFAULT_SAMPLES_DIR);
      expect(samplesDirWasExplicit(v)).toBe(false);
    }
  });

  it('相对路径解析成绝对路径（避免 cwd 漂移后指到别处）', () => {
    const rel = 'relative/samples';
    expect(resolveSamplesDir(rel)).toBe(resolve(rel));
    expect(resolveSamplesDir(rel).startsWith('/')).toBe(true);
  });

  it('显式指定与默认目录可以被区分（决定「跳过」还是「失败」）', () => {
    expect(samplesDirWasExplicit('/tmp/x')).toBe(true);
    expect(samplesDirWasExplicit(DEFAULT_SAMPLES_DIR)).toBe(true);
    expect(samplesDirWasExplicit(undefined)).toBe(false);
  });
});

describe('扫描规则：样本必须在子目录里成对出现', () => {
  it('一层子目录里成对的才算样本', async () => {
    const dir = await tmp('samples-ind-pair-');
    await mkdir(join(dir, 'vat'));
    await writeFile(join(dir, 'vat', 'a.pdf'), '%PDF-1.4');
    await writeFile(join(dir, 'vat', 'a.expected.json'), '{"total":1}');
    const scan = await loadSamples(dir);
    expect(scan.samples.map((s) => s.name)).toEqual(['a.pdf']);
  });

  it('多层嵌套里的票不算样本（也不会被列进 ignored）', async () => {
    const dir = await tmp('samples-ind-nest-');
    await mkdir(join(dir, 'vat', 'deep'), { recursive: true });
    await writeFile(join(dir, 'vat', 'deep', 'b.pdf'), '%PDF-1.4');
    await writeFile(join(dir, 'vat', 'deep', 'b.expected.json'), '{}');
    const scan = await loadSamples(dir);
    expect(scan.samples).toEqual([]);
    expect(scan.ignored).toEqual([]);
  });

  it('.expected.json 与票同名才算（前缀相同不算）', async () => {
    const dir = await tmp('samples-ind-name-');
    await mkdir(join(dir, 'vat'));
    await writeFile(join(dir, 'vat', 'c.pdf'), '%PDF-1.4');
    await writeFile(join(dir, 'vat', 'c-copy.expected.json'), '{}');
    const scan = await loadSamples(dir);
    expect(scan.samples).toEqual([]);
    expect(scan.ignored).toHaveLength(1);
  });
});
