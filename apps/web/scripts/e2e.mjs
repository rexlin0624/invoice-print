#!/usr/bin/env node
/**
 * 在**真实浏览器**里跑渲染回归（e2e）。
 *
 * 为什么需要它：内核单测在 Node 里跑，而渲染全在浏览器能力上 ——
 * pdfjs 的 worker、`OffscreenCanvas`、`canvas.getImageData`、zxing 的 wasm。
 * 本仓库吃过一次「单测全绿、网页里全空」（`pdfjsSafe.ts` 记录的那个坑），
 * 所以渲染相关改动一律要有这一层证据。
 *
 * 它做什么：
 * 1. 起一个只收结果的本地小服务器（harness 用 POST 把结果送回来）；
 * 2. 起 Vite 开发服务器（默认 5199，避开你正在用的 5180）；
 * 3. 用无头 Chrome 打开 `e2e/harness.html`（页面里跑真实的渲染代码）；
 * 4. 等结果，打成表格，任一失败就以非 0 退出。
 *
 * 用法：`pnpm e2e`（在仓库根）或 `pnpm --filter @invoice-tool/web e2e`。
 * 环境变量：`CHROME` 指定浏览器可执行文件；`E2E_TIMEOUT_MS` 改超时。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WEB_DIR = new URL('..', import.meta.url).pathname;
const REPORT_PORT = Number(process.env.E2E_REPORT_PORT ?? 5399);
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 5199);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 240_000);

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

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('找不到 Chrome。装一个，或者用 CHROME=/path/to/chrome 指给我。');
    process.exit(2);
  }

  const { server, received } = await startReportServer();

  // 直接跑 vite 的 js 入口，不经过 pnpm：这台机器上 node 起 pnpm 的 shell 包装会 EBADEXEC
  const viteEntry = join(WEB_DIR, 'node_modules/vite/bin/vite.js');
  const vite = spawn(process.execPath, [viteEntry, '--port', String(DEV_PORT), '--strictPort'], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  vite.stdout.on('data', (chunk) => (viteLog += chunk));
  vite.stderr.on('data', (chunk) => (viteLog += chunk));

  const profile = await mkdtemp(join(tmpdir(), 'invoice-e2e-'));
  const url = `http://127.0.0.1:${DEV_PORT}/e2e/harness.html?report=http://127.0.0.1:${REPORT_PORT}/`;
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    url,
  ];

  console.log(`[e2e] ${chrome}`);
  console.log(`[e2e] ${url}`);

  let chromeProc;
  const cleanup = () => {
    chromeProc?.kill('SIGKILL');
    vite.kill('SIGKILL');
    server.close();
    void rm(profile, { recursive: true, force: true });
  };

  try {
    if (!(await waitForServer(`http://127.0.0.1:${DEV_PORT}/e2e/harness.html`, 60_000))) {
      console.error('[e2e] Vite 开发服务器没起来：');
      console.error(viteLog);
      process.exit(3);
    }

    chromeProc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const result = await Promise.race([
      received,
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              results: [],
              error: `超过 ${TIMEOUT_MS} ms 没收到结果`,
            }),
          TIMEOUT_MS,
        ),
      ),
    ]);

    console.log('');
    console.log(`[e2e] 渲染引擎：${result.engine ?? '?'}　标签页可见性：${result.visibility ?? '?'}`);
    for (const item of result.results ?? []) {
      console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}　${item.detail}`);
    }
    if (result.error) console.error(`[e2e] ${result.error}`);

    const failed = (result.results ?? []).filter((r) => !r.ok);
    if (!result.ok) {
      console.error(`\n[e2e] 失败 ${failed.length} 项（共 ${(result.results ?? []).length} 项）`);
      process.exitCode = 1;
    } else {
      console.log(`\n[e2e] 全部通过（${(result.results ?? []).length} 项）`);
    }
  } finally {
    cleanup();
  }
}

await main();
