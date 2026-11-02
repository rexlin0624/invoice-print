#!/usr/bin/env node
/**
 * 构建产物检查。
 *
 * 为什么需要它：CSP 由 `vite.config.ts` 的插件在**构建期**注入，开发服务器里根本不存在，
 * 所以 `pnpm dev` 跑一辈子也发现不了「插件没生效」或「策略被改松了」。
 * 单测（`src/lib/csp.test.ts`）能证明插件逻辑对，但证明不了**产物里真的有**；
 * 中间隔着 Vite 的 transformIndexHtml 管线，这一层只有真跑一次构建才看得见。
 *
 * 检查四件事：
 * 1. 网页版产物里的 CSP meta **逐条指令精确匹配**（不是子串包含 ——
 *    `script-src 'self' 'unsafe-inline'` 也能通过 `includes("script-src 'self'")`）；
 *    重复指令直接判失败：浏览器只执行第一条，而「先松后紧」的双写能骗过任何
 *    只读最后一条的检查；
 * 2. `tauri.conf.json` 的 `csp` / `devCsp` 逐条核对，**任何构建都跑**（纯文件读取）；
 *    Tauri 构建里还额外要求产物**不注入**网页版 meta；
 * 3. `index.html` 没有外部（http/https/协议相对）资源引用，也没有内联 `<script>`；
 * 4. `dist` 里没有发票/压缩包文件（真票是个人数据，绝不能随产物发出去）。
 *
 * 边界（不要把它当成「零外联」的完整证明）：这里只看**静态产物**。
 * JS chunk 运行时 `fetch('https://…')`、Worker 内部请求、顶层导航、WebSocket
 * 都不在静态检查范围内 —— 那几条靠生产 CSP + `pnpm e2e` 的运行时断言。
 *
 * 用法：`node scripts/check-build.mjs`（已串在 `pnpm build` 末尾）。
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TAURI_CONF = fileURLToPath(
  new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url),
);
const IN_TAURI = process.env.TAURI_ENV_PLATFORM !== undefined;

/**
 * 网页版生产策略的**精确**指令表。
 *
 * 顺序无关，但 token 集合必须一字不差：多一个源、少一个 `object-src 'none'` 都算失败。
 * 改 `vite.config.ts` 的 `WEB_CSP` 时，这里必须同步改 —— 这正是让「悄悄放松」变红的手段。
 */
const WEB_CSP = {
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

/** 桌面端比网页版多的源：Tauri IPC（不是远程地址） */
const TAURI_CONNECT_EXTRA = ['ipc:', 'http://ipc.localhost'];
/** 只在 `devCsp` 里允许的：HMR 的 eval 与本地 WebSocket */
const DEV_SCRIPT_EXTRA = ["'unsafe-eval'"];
const DEV_CONNECT_EXTRA = ['ws://127.0.0.1:5180'];

const problems = [];
const passes = [];

const fail = (message) => problems.push(message);
const pass = (message) => passes.push(message);

/**
 * 策略文本 → { map: Map<指令, token[]>, duplicates: string[] }
 *
 * 两个细节都必须和浏览器的解析算法（CSP3 §2.2）一致，否则检查本身能被绕过：
 * 1. **首条生效**。指令集里已有同名指令时，后面的整条被丢弃；以前这里用 `map.set`
 *    是「后者覆盖前者」，和浏览器正好相反 —— 于是「先写一条松的、再写一条紧的」
 *    可以同时骗过产物检查与单测，而 Chrome 执行的是松的那条。
 * 2. 指令名大小写不敏感（`Script-Src` 与 `script-src` 是同一条），统一转小写。
 *
 * 重复指令一律记为问题：正常写法没有理由出现两次，出现即视为「试图骗过检查」。
 */
function parseCsp(text) {
  const map = new Map();
  const duplicates = [];
  for (const part of text.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (map.has(name)) {
      duplicates.push(name);
      continue; // 浏览器会丢掉这一条，这里也丢掉 —— 比较的必须是「真正生效」的那份
    }
    map.set(name, tokens.slice(1));
  }
  return { map, duplicates };
}

/** 把「基础表 + 额外 token」拼成期望表 */
function expectedCsp(extra = {}) {
  const map = new Map();
  for (const [directive, tokens] of Object.entries(WEB_CSP)) {
    map.set(directive, [...tokens, ...(extra[directive] ?? [])]);
  }
  return map;
}

/** 逐指令精确比较，返回是否全部通过 */
function compareCsp(text, expected, label) {
  const { map: actual, duplicates } = parseCsp(text);
  let ok = true;

  for (const name of duplicates) {
    ok = false;
    fail(
      `${label}：指令「${name}」重复出现 —— 浏览器只执行第一条、忽略后面的，` +
        '所以「先写一条松的再写一条紧的」能骗过所有只看最后一条的检查',
    );
  }

  for (const [directive, tokens] of expected) {
    const got = actual.get(directive);
    if (got === undefined) {
      ok = false;
      fail(`${label}：缺少指令「${directive}」`);
      continue;
    }
    const want = [...tokens].sort().join(' ');
    const have = [...got].sort().join(' ');
    if (want !== have) {
      ok = false;
      fail(`${label}：${directive} = "${got.join(' ')}"，期望 "${tokens.join(' ')}"`);
    }
  }
  for (const directive of actual.keys()) {
    if (!expected.has(directive)) {
      ok = false;
      fail(`${label}：多出未批准的指令「${directive}」`);
    }
  }
  return ok;
}

const indexPath = join(DIST, 'index.html');
let index;
try {
  index = await readFile(indexPath, 'utf8');
} catch {
  console.error(`✗ 找不到 ${indexPath}\n  先跑 \`vite build\`（本脚本是构建的收尾步骤）`);
  process.exit(1);
}

// ---- 1. CSP ----

/**
 * 桌面端策略的核对**无条件**执行。
 *
 * 它是纯文件读取，不需要 `tauri build`，所以没有理由挂在 `IN_TAURI` 上。
 * 以前这段被 `if (IN_TAURI)` 包住，而 CI 的 desktop 作业跑的是不带
 * `TAURI_ENV_PLATFORM` 的 `pnpm build` —— 结果是 `tauri.conf.json` 在 CI 上一次
 * 都没被读过，「删掉 CSP 也能全绿」的窗口只是从本地搬到了发版那天。
 */
async function checkTauriConf() {
  let conf;
  try {
    conf = JSON.parse(await readFile(TAURI_CONF, 'utf8'));
  } catch (err) {
    fail(`读不了 ${TAURI_CONF}：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const security = conf?.app?.security ?? {};

  // 网页版不注入 meta，就必须由 tauri.conf.json 自己带足策略。
  // 否则「删掉配置 → 打包不带 CSP」也能全绿（这正是以前发生过的事）。
  if (typeof security.csp !== 'string' || security.csp.trim() === '') {
    fail('tauri.conf.json 的 app.security.csp 缺失或为空 —— 桌面端会没有 CSP');
  } else if (
    compareCsp(
      security.csp,
      expectedCsp({ 'connect-src': TAURI_CONNECT_EXTRA }),
      'tauri.conf.json 的 csp',
    )
  ) {
    pass('tauri.conf.json 的 csp 与网页版策略一致（仅多 Tauri IPC 源）');
  }

  // `devCsp` 缺失时 Tauri 会静默回落到 `csp`：安全上不放松（那份更严），但
  // `desktop:dev` 的 HMR 会连不上，而输出里一个字都没有。静默本身就是问题。
  if (typeof security.devCsp !== 'string' || security.devCsp.trim() === '') {
    fail(
      'tauri.conf.json 的 app.security.devCsp 缺失 —— 缺了会静默回落到 csp，' +
        '桌面端 dev 的 HMR 连不上且没有任何提示',
    );
  } else if (
    compareCsp(
      security.devCsp,
      expectedCsp({
        'script-src': DEV_SCRIPT_EXTRA,
        'connect-src': [...TAURI_CONNECT_EXTRA, ...DEV_CONNECT_EXTRA],
      }),
      'tauri.conf.json 的 devCsp',
    )
  ) {
    pass('tauri.conf.json 的 devCsp 仅多 HMR 所需的 eval 与本地 ws');
  }

  for (const key of [
    'dangerousDisableAssetCspModification',
    'dangerousRemoteDomainIpcAccess',
    'assetProtocol',
  ]) {
    if (key in security) fail(`tauri.conf.json 开启了 ${key}，超出本项目的安全基线`);
  }
}

await checkTauriConf();

const metaMatch = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(index);

if (IN_TAURI) {
  // Tauri 构建里不该有网页版 meta：两份策略叠加会把 Tauri 注入的 nonce 规则挤掉。
  if (metaMatch) {
    fail(
      'Tauri 构建里不该有网页版的 CSP meta：它和 tauri.conf.json 的策略会叠加，' +
        '把 Tauri 自己注入的 nonce 规则挤掉',
    );
  } else {
    pass('Tauri 构建：未注入网页版 CSP meta（符合预期）');
  }
} else if (!metaMatch) {
  fail('产物 index.html 里没有 Content-Security-Policy meta —— cspMeta() 插件没生效');
} else {
  pass('CSP meta 已注入');
  // 注意：策略值里本身就有单引号（`'self'`），所以不能写 `["']([^"']*)["']` ——
  // 那样会在第一个 `'self'` 的单引号处截断，检查全部误报「缺少指令」。
  const content =
    /\bcontent="([^"]*)"/i.exec(metaMatch[0])?.[1] ??
    /\bcontent='([^']*)'/i.exec(metaMatch[0])?.[1] ??
    '';

  if (content.trim() === '') {
    fail('CSP meta 的 content 是空的');
  } else if (compareCsp(content, expectedCsp(), '网页版 CSP')) {
    pass('CSP 逐条指令与期望一致');
  }
}

// ---- 2. 外部资源引用 ----
const refs = [...index.matchAll(/\b(?:src|href|srcset|poster)=["']([^"']+)["']/gi)].map(
  (m) => m[1],
);
const external = refs.filter((url) => /^(?:https?:)?\/\//i.test(url));
if (external.length > 0) {
  fail(`index.html 引用了外部资源（离线 / 隐私承诺会被打破）：${external.join(', ')}`);
} else {
  pass(`index.html 的 ${refs.length} 个静态引用全部是相对路径`);
}

// 引用的脚本/样式必须真的在 dist 里 —— 否则「检查全绿但页面白屏」
const missing = refs
  .filter((ref) => !/^(?:https?:)?\/\//i.test(ref) && !ref.startsWith('data:') && !ref.startsWith('#'))
  .filter((ref) => {
    const clean = ref.split('?')[0].split('#')[0];
    return !existsSync(join(DIST, clean.replace(/^\.?\//, '')));
  });
if (missing.length > 0) {
  fail(`index.html 引用了不存在的文件：${missing.join(', ')}`);
} else {
  pass('index.html 引用的脚本/样式都在 dist 里');
}

// ---- 3. 内联脚本 ----
const inlineScripts = [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
  ([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && body.trim() !== '',
);
if (inlineScripts.length > 0) {
  fail(
    `产物里有 ${inlineScripts.length} 段内联 <script>：CSP 没有 nonce/hash，浏览器会拦掉，` +
      '表现为「dev 正常、部署后白屏」',
  );
} else {
  pass('没有内联 <script>');
}

// ---- 4. dist 里不许有发票 / 压缩包 ----
const BANNED = new Set(['.pdf', '.ofd', '.xml', '.zip']);
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const leaked = (await walk(DIST))
  .filter((file) => BANNED.has(extname(file).toLowerCase()))
  .map((file) => relative(DIST, file));
if (leaked.length > 0) {
  fail(
    `dist 里有 ${leaked.length} 个发票/压缩包文件（真票是个人数据，不能随产物发布）：` +
      leaked.join(', '),
  );
} else {
  pass('dist 里没有发票/压缩包文件');
}

// ---- 输出 ----
for (const message of passes) console.log(`✓ ${message}`);
for (const message of problems) console.error(`✗ ${message}`);

if (problems.length > 0) {
  console.error(`\n构建产物检查未通过（${problems.length} 项）。`);
  process.exit(1);
}
console.log('\n构建产物检查通过。');
