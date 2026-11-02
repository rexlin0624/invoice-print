/**
 * CSP 的单元测试。
 *
 * 为什么值得单独测：CSP 是「隐私承诺」唯一的机器可执行部分 —— README 说「不上传任何数据」，
 * 而真正拦住数据外发的是这条 meta。它由构建期插件注入，产物里看不见，写错了也不会有人发现，
 * 直到某天真的需要它挡一次攻击。
 *
 * 这里钉三类事：
 * 1. 策略本身没有放水（通配符 / `unsafe-eval` / 外部 connect）；
 * 2. 插件确实会在网页版构建里注入；
 * 3. Tauri 构建里**不**注入（否则两份 CSP 叠加会把 Tauri 的 nonce 规则挤掉）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { WEB_CSP, cspMeta } from '../../vite.config';

/** 取出插件注入的 html 结果（`transformIndexHtml` 在这个插件里是函数式钩子） */
function runPlugin(html = '<html><head></head><body></body></html>'): unknown {
  const hook = cspMeta().transformIndexHtml;
  if (typeof hook !== 'function') throw new Error('transformIndexHtml 应该是函数');
  return (hook as unknown as (h: string) => unknown).call({}, html);
}

describe('网页版 CSP 策略', () => {
  /**
   * 期望的**完整**策略。
   *
   * 为什么不用「不含 `*` / 不含 `'unsafe-eval'`」这种黑名单：那种断言挡不住
   * `script-src 'self' 'unsafe-inline'`、`worker-src 'self' blob: https://x` 这类
   * 「加一个源」的放松。策略是安全边界，应该逐 token 精确匹配。
   */
  const EXPECTED: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'form-action': ["'none'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': ["'self'", 'blob:'],
  };

  /**
   * 解析成「指令 → token[]」，并返回重复出现的指令。
   *
   * 必须与浏览器（CSP3 §2.2）一致：**同名指令只取第一条**，后面的整条丢弃。
   * 用 `out[name] = …` 那种「后者覆盖前者」的写法会留一个洞 ——
   * 在 `WEB_CSP` 里先写一条松的 `script-src`、再写一条紧的，浏览器执行松的那条，
   * 而断言读到紧的那条，全绿。所以这里既取第一条，也把重复本身暴露出来。
   */
  function parse(csp: string): { map: Record<string, string[]>; duplicates: string[] } {
    const map: Record<string, string[]> = {};
    const duplicates: string[] = [];
    for (const part of csp.split(';')) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const name = tokens[0]!.toLowerCase();
      if (name in map) {
        duplicates.push(name);
        continue;
      }
      map[name] = tokens.slice(1);
    }
    return { map, duplicates };
  }

  it('没有重复指令（重复即放松：浏览器只认第一条）', () => {
    expect(parse(WEB_CSP).duplicates).toEqual([]);
  });

  it('重复指令会被识别成问题，且取值按第一条（与浏览器一致）', () => {
    // 这是检查自身的自测：证明「先松后紧」的双写不会让断言变绿。
    const sneaky =
      "script-src 'self' https://cdn.example; " +
      "script-src 'self' 'wasm-unsafe-eval'; " +
      WEB_CSP;
    const { map, duplicates } = parse(sneaky);
    expect(duplicates).toContain('script-src');
    expect(map['script-src']).toEqual(["'self'", 'https://cdn.example']);
    expect([...map['script-src']!].sort()).not.toEqual(
      [...EXPECTED['script-src']!].sort(),
    );
  });

  it('逐条指令与期望完全一致（多一个源也算放松）', () => {
    const { map: actual } = parse(WEB_CSP);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [directive, tokens] of Object.entries(EXPECTED)) {
      expect([...actual[directive]!].sort(), directive).toEqual([...tokens].sort());
    }
  });

  it('没有通配符源', () => {
    expect(WEB_CSP).not.toMatch(/(^|[\s;])\*($|[\s;])/);
    expect(WEB_CSP).not.toContain('*');
  });

  it('没有 unsafe-eval（wasm-unsafe-eval 是另一回事）', () => {
    // 注意不能简单 includes("unsafe-eval")：'wasm-unsafe-eval' 里包含这个子串
    expect(WEB_CSP).not.toMatch(/'unsafe-eval'/);
    expect(WEB_CSP).toContain("'wasm-unsafe-eval'");
  });

  it('堵住三类高危注入点', () => {
    expect(WEB_CSP).toContain("object-src 'none'");
    expect(WEB_CSP).toContain("base-uri 'self'");
    expect(WEB_CSP).toContain("form-action 'none'");
  });

  it('connect-src 只能回自己', () => {
    const connect = /connect-src([^;]*)/.exec(WEB_CSP)?.[1] ?? '';
    expect(connect.trim()).toBe("'self'");
  });

  it('worker / frame 只放行同源与 blob', () => {
    expect(WEB_CSP).toContain("worker-src 'self' blob:");
    expect(WEB_CSP).toContain("frame-src 'self' blob:");
  });
});

describe('CSP 注入插件', () => {
  afterEach(() => {
    delete process.env.TAURI_ENV_PLATFORM;
  });

  it('只在构建期生效（dev 不注入，否则 HMR 会挂）', () => {
    expect(cspMeta().apply).toBe('build');
  });

  it('网页版构建注入 head-prepend 的 meta', () => {
    const result = runPlugin() as {
      tags?: Array<{ tag?: string; attrs?: Record<string, string>; injectTo?: string }>;
    };
    expect(result.tags).toHaveLength(1);
    const tag = result.tags![0]!;
    expect(tag.tag).toBe('meta');
    expect(tag.injectTo).toBe('head-prepend');
    expect(tag.attrs?.['http-equiv']).toBe('Content-Security-Policy');
    expect(tag.attrs?.content).toBe(WEB_CSP);
  });

  it('Tauri 构建不注入（由 tauri.conf.json 自己注入）', () => {
    process.env.TAURI_ENV_PLATFORM = 'darwin';
    const html = '<html><head></head><body></body></html>';
    expect(runPlugin(html)).toBe(html);
  });
});
