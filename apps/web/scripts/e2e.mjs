#!/usr/bin/env node
/**
 * 在**真实浏览器**里跑渲染回归（e2e）+ 生产 CSP 冒烟。
 *
 * 为什么需要它：内核单测在 Node 里跑，而渲染全在浏览器能力上 ——
 * pdfjs 的 worker、`OffscreenCanvas`、`canvas.getImageData`、zxing 的 wasm。
 * 本仓库吃过一次「单测全绿、网页里全空」（`pdfjsSafe.ts` 记录的那个坑），
 * 所以渲染相关改动一律要有这一层证据。
 *
 * 它做两段：
 * 1. **渲染回归**：起 Vite dev server（默认 5199），打开 `e2e/harness.html`，
 *    跑真实的渲染 / 解码 / 排版代码，末尾断言整页零跨源请求；
 * 2. **生产 CSP 冒烟**：`E2E_CSP=1` 构建到 `dist-e2e/`，用本地静态服务器托管，
 *    打开 `e2e/csp-smoke.html`，断言 fetch / img / script / iframe 的跨源加载
 *    都被 `securitypolicyviolation` 拦下，并用金丝雀服务器确认**一次都没出网**。
 *    这一段跑的是构建产物，所以验证的是 `cspMeta()` 真正注入的那份策略。
 *
 * 用法：`pnpm e2e`（在仓库根）或 `pnpm --filter @invoice-tool/web e2e`。
 * 环境变量：`CHROME` 指定浏览器可执行文件；`E2E_TIMEOUT_MS` 改超时；
 * `E2E_SKIP_CSP=1` 只跑渲染段（本机排查时用）。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

const WEB_DIR = new URL('..', import.meta.url).pathname;
const REPORT_PORT = Number(process.env.E2E_REPORT_PORT ?? 5399);
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 5199);
/** 生产 CSP 冒烟：静态服务器端口（与金丝雀、dev 都错开） */
const CSP_PORT = Number(process.env.E2E_CSP_PORT ?? 5400);
/** 金丝雀服务器：CSP 应当拦掉所有打到这里的请求 */
const CANARY_PORT = Number(process.env.E2E_CANARY_PORT ?? 5401);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 240_000);
const SKIP_CSP = process.env.E2E_SKIP_CSP === '1';

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    return candidate;
  }
  return undefined;
}

/** 只收结果的本地小服务器（dev 段的 harness 用 POST 把结果送回来） */
function startReportServer() {
  let settle;
  const received = new Promise((resolve) => {
    settle = resolve;
  });

  const server = createServer((req, res) => {
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end('{}');
      try {
        settle(JSON.parse(body));
      } catch (err) {
        settle({
          ok: false,
          results: [],
          error: `结果不是合法 JSON：${err.message}`,
        });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(REPORT_PORT, '127.0.0.1', () => resolve({ server, received }));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 生产 CSP 冒烟用的静态服务器。
 *
 * 用**同源**回传结果：产物策略是 `connect-src 'self'`，跨源 POST 会被它自己拦掉
 * （这正是策略在工作的证据，但会让测试永远收不到结果）。所以这里既 serve 文件，
 * 也接 `POST /report`。
 */
function startCspServer(distDir, port) {
  let settle;
  const received = new Promise((resolve) => {
    settle = resolve;
  });
  const root = resolve(distDir);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        try {
          settle(JSON.parse(body));
        } catch (err) {
          settle({
            ok: false,
            results: [],
            error: `结果不是合法 JSON：${err.message}`,
          });
        }
      });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    readFile(file)
      .then((data) => {
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(data);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, received }));
  });
}

/** 金丝雀：CSP 生效时这里应当**一条请求都收不到** */
function startCanaryServer(port) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, hits }));
  });
}

async function waitForServer(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** 起一个无头 Chrome，等页面把结果 POST 回来（或超时），然后杀掉 */
async function openChrome(chrome, url, profile, received, label) {
  console.log(`[e2e] ${label}：${url}`);
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let chromeLog = '';
  proc.stderr.on('data', (chunk) => (chromeLog += chunk));

  try {
    const result = await Promise.race([
      received,
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              results: [],
              error: `超过 ${TIMEOUT_MS} ms 没收到结果（${label}）`,
            }),
          TIMEOUT_MS,
        ),
      ),
    ]);
    if (chromeLog.trim() !== '' && result.error !== undefined) {
      console.error(`[e2e] Chrome 输出（${label}）：\n${chromeLog.trim().split('\n').slice(-10).join('\n')}`);
    }
    return result;
  } finally {
    proc.kill('SIGKILL');
  }
}

/** 用 Vite 的 js 入口跑一次构建（不经 pnpm：node 起 pnpm 的 shell 包装会 EBADEXEC） */
function buildSmoke(viteEntry) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [viteEntry, 'build', '--outDir', 'dist-e2e', '--emptyOutDir'],
      {
        cwd: WEB_DIR,
        env: { ...process.env, E2E_CSP: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let log = '';
    proc.stdout.on('data', (chunk) => (log += chunk));
    proc.stderr.on('data', (chunk) => (log += chunk));
    proc.on('exit', (code) => resolve({ code: code ?? 1, log }));
  });
}

function printResults(label, result) {
  console.log('');
  if (result.engine !== undefined) {
    console.log(
      `[e2e] ${label} 渲染引擎：${result.engine}　标签页可见性：${result.visibility ?? '?'}`,
    );
  }
  for (const item of result.results ?? []) {
    console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}　${item.detail}`);
  }
  if (result.error) console.error(`[e2e] ${label}：${result.error}`);

  const failed = (result.results ?? []).filter((item) => !item.ok);
  const total = (result.results ?? []).length;
  if (!result.ok) {
    console.error(`\n[e2e] ${label} 失败 ${failed.length} 项（共 ${total} 项）`);
    return false;
  }
  console.log(`\n[e2e] ${label} 全部通过（${total} 项）`);
  return true;
}

/** 第一段：Vite dev server 上的渲染回归 */
async function runRenderPhase(chrome, viteEntry) {
  const { server, received } = await startReportServer();
  const vite = spawn(process.execPath, [viteEntry, '--port', String(DEV_PORT), '--strictPort'], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  vite.stdout.on('data', (chunk) => (viteLog += chunk));
  vite.stderr.on('data', (chunk) => (viteLog += chunk));

  const profile = await mkdtemp(join(tmpdir(), 'invoice-e2e-'));
  const url = `http://127.0.0.1:${DEV_PORT}/e2e/harness.html?report=http://127.0.0.1:${REPORT_PORT}/`;

  try {
    if (!(await waitForServer(`http://127.0.0.1:${DEV_PORT}/e2e/harness.html`, 60_000))) {
      return {
        ok: false,
        results: [],
        error: `Vite 开发服务器没起来：\n${viteLog}`,
      };
    }
    return await openChrome(chrome, url, profile, received, '渲染回归');
  } finally {
    vite.kill('SIGKILL');
    server.close();
    void rm(profile, { recursive: true, force: true });
  }
}

/** 第二段：构建产物上的 CSP 冒烟 */
async function runCspPhase(chrome, viteEntry) {
  const built = await buildSmoke(viteEntry);
  if (built.code !== 0) {
    console.error('[e2e] 冒烟构建失败：');
    console.error(built.log.trim().split('\n').slice(-30).join('\n'));
    return { ok: false, results: [], error: '构建 dist-e2e 失败' };
  }

  const distDir = join(WEB_DIR, 'dist-e2e');
  const staticServer = await startCspServer(distDir, CSP_PORT);
  const canary = await startCanaryServer(CANARY_PORT);
  const profile = await mkdtemp(join(tmpdir(), 'invoice-e2e-csp-'));
  const page = `http://127.0.0.1:${CSP_PORT}/e2e/csp-smoke.html`;
  const url = `${page}?report=/report&canary=${encodeURIComponent(`http://127.0.0.1:${CANARY_PORT}`)}`;

  try {
    if (!(await waitForServer(page, 30_000))) {
      return { ok: false, results: [], error: 'CSP 冒烟静态服务器没起来（dist-e2e 里没有 e2e/csp-smoke.html？）' };
    }

    const result = await openChrome(chrome, url, profile, staticServer.received, '生产 CSP 冒烟');

    // 页面的 `securitypolicyviolation` 只能证明浏览器「决定拦截」；
    // 「有没有真的出网」只有服务器侧知道 —— 两条证据合起来才算数。
    const hits = canary.hits.slice();
    result.results = [
      ...(result.results ?? []),
      {
        name: 'CSP 拦截后没有真的出网',
        ok: hits.length === 0,
        detail:
          hits.length === 0
            ? '4 次跨源尝试，金丝雀服务器 0 次命中'
            : `金丝雀收到 ${hits.length} 次请求：${hits.join(', ')}`,
      },
    ];
    result.ok = (result.results ?? []).every((item) => item.ok);
    return result;
  } finally {
    staticServer.server.close();
    canary.server.close();
    void rm(profile, { recursive: true, force: true });
    // dist-e2e 留着方便排查；下次构建会 --emptyOutDir
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('找不到 Chrome。装一个，或者用 CHROME=/path/to/chrome 指给我。');
    process.exit(2);
  }

  console.log(`[e2e] ${chrome}`);
  const viteEntry = join(WEB_DIR, 'node_modules/vite/bin/vite.js');

  const render = await runRenderPhase(chrome, viteEntry);
  const renderOk = printResults('渲染回归', render);

  let cspOk = true;
  if (!SKIP_CSP) {
    const csp = await runCspPhase(chrome, viteEntry);
    cspOk = printResults('生产 CSP 冒烟', csp);
  } else {
    console.log('\n[e2e] 跳过生产 CSP 冒烟（E2E_SKIP_CSP=1）');
  }

  if (!renderOk || !cspOk) process.exitCode = 1;
}

await main();
