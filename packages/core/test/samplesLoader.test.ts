/**
 * 样本发现逻辑的测试。
 *
 * 这段代码本身很简单，但它决定「真票回归到底跑没跑」——
 * 目录指错、期望文件漏写、JSON 写坏，三种情况都必须**看得见**，
 * 而不是变成一句「没有样本，跳过」。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SAMPLES_DIR,
  loadSamples,
  resolveSamplesDir,
  samplesDirWasExplicit,
} from './helpers/samples';

const made: string[] = [];

async function makeTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'invoice-samples-'));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('样本发现', () => {
  it('目录不存在时返回空结果，不抛异常', async () => {
    const scan = await loadSamples(join(tmpdir(), 'definitely-not-here-123456'));
    expect(scan.samples).toEqual([]);
    expect(scan.ignored).toEqual([]);
  });

  it('「票 + 同名 .expected.json」成对时才算一个样本', async () => {
    const root = await makeTree();
    const dir = join(root, 'public');
    await mkdir(dir);
    await writeFile(join(dir, 'a.pdf'), '%PDF-1.4');
    await writeFile(join(dir, 'a.expected.json'), JSON.stringify({ invoiceNo: '0001' }));

    const scan = await loadSamples(root);
    expect(scan.samples).toHaveLength(1);
    expect(scan.samples[0]!.name).toBe('a.pdf');
    expect(scan.samples[0]!.expected).toEqual({ invoiceNo: '0001' });
    expect(scan.ignored).toEqual([]);
  });

  it('只有票、没有期望文件 → 进 ignored（列出来，别静默跳过）', async () => {
    const root = await makeTree();
    const dir = join(root, 'private');
    await mkdir(dir);
    await writeFile(join(dir, 'b.ofd'), 'PK');
    await writeFile(join(dir, 'c.xml'), '<Invoice/>');

    const scan = await loadSamples(root);
    expect(scan.samples).toEqual([]);
    expect(scan.ignored.map((p) => p.endsWith('b.ofd') || p.endsWith('c.xml'))).toEqual([true, true]);
  });

  it('不认识的后缀不参与（.zip 由外壳展开，内核不直接吃）', async () => {
    const root = await makeTree();
    const dir = join(root, 'public');
    await mkdir(dir);
    await writeFile(join(dir, 'd.zip'), 'PK');
    await writeFile(join(dir, 'd.expected.json'), '{}');

    const scan = await loadSamples(root);
    expect(scan.samples).toEqual([]);
    expect(scan.ignored).toEqual([]);
  });

  it('期望文件是坏 JSON —— 必须抛，不能当成没样本', async () => {
    const root = await makeTree();
    const dir = join(root, 'public');
    await mkdir(dir);
    await writeFile(join(dir, 'e.pdf'), '%PDF-1.4');
    await writeFile(join(dir, 'e.expected.json'), '{ 这不是 JSON');

    await expect(loadSamples(root)).rejects.toThrow();
  });

  it('只看一层子目录，根目录下散放的文件不算', async () => {
    const root = await makeTree();
    await writeFile(join(root, 'f.pdf'), '%PDF-1.4');
    await writeFile(join(root, 'f.expected.json'), '{}');

    const scan = await loadSamples(root);
    expect(scan.samples).toEqual([]);
  });
});

describe('SAMPLES_DIR 解析', () => {
  it('没设置时用仓库自带的 samples/', () => {
    expect(resolveSamplesDir(undefined)).toBe(DEFAULT_SAMPLES_DIR);
    expect(resolveSamplesDir('')).toBe(DEFAULT_SAMPLES_DIR);
    expect(resolveSamplesDir('   ')).toBe(DEFAULT_SAMPLES_DIR);
  });

  it('设置了就用它（相对路径按 cwd 解析成绝对路径）', () => {
    expect(resolveSamplesDir('/tmp/private-samples')).toBe('/tmp/private-samples');
    expect(resolveSamplesDir('relative/dir')).toBe(resolve('relative/dir'));
  });

  it('能区分「没指定」与「指定了空值」', () => {
    expect(samplesDirWasExplicit(undefined)).toBe(false);
    expect(samplesDirWasExplicit('')).toBe(false);
    expect(samplesDirWasExplicit('  ')).toBe(false);
    expect(samplesDirWasExplicit('/tmp/x')).toBe(true);
  });
});
