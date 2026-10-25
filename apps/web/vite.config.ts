import { createReadStream, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * 开发期才有的「真票样本」服务。
 *
 * ⚠️ 刻意**不用** `public/samples/`：Vite 会把 `public/` 原样拷进 `dist/`，
 * 于是真实发票（属个人数据）会跟着产物一起被打包 —— 一旦有人把 `dist/` 传上静态托管，
 * 就等于把发票公开了。这个中间件只在 `pnpm dev` 里存在，生产构建里连代码都进不去。
 *
 * 目录：`<repo>/samples/private/`（内容已 gitignore）
 * 路径：`/__samples__/index.json`、`/__samples__/<文件名>`
 */
const SAMPLES_DIR = resolve(fileURLToPath(new URL('../../samples/private', import.meta.url)));
const MOUNT = '/__samples__/';

/**
 * 网页版的生产 CSP。桌面版在 `tauri.conf.json` 的 `app.security.csp` 里有一份
 * 同样的策略；改这里时两边要一起改。
 *
 * 为什么需要这些：
 * - `wasm-unsafe-eval`：zxing 与 tesseract 都要编译 wasm
 * - `worker-src/child-src blob:`：pdfjs / tesseract / 渲染 Worker
 * - `frame-src blob:`：网页版打印走隐藏 iframe + blob PDF
 * - `img-src data: blob:`：缩略图与 canvas 导出
 * - `style-src 'unsafe-inline'`：React 的 style 属性
 */
const WEB_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'none'; " +
  "script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; worker-src 'self' blob:; child-src 'self' blob:; " +
  "frame-src 'self' blob:";

/**
 * 只给**网页版生产包**注入 CSP meta。
 *
 * Tauri 构建时 `beforeBuildCommand` 也会跑这个 vite build，但 Tauri 会按
 * `tauri.conf.json` 自己注入 header/meta。用 `TAURI_ENV_PLATFORM` 区分，
 * 避免两个 CSP meta 叠加后把 Tauri 的 nonce 规则挤掉。
 */
function cspMeta(): Plugin {
  return {
    name: 'invoice-tool:csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      if (process.env.TAURI_ENV_PLATFORM) return html;
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: WEB_CSP },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

function devSamples(): Plugin {
  return {
    name: 'invoice-tool:dev-samples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        if (!pathname.startsWith(MOUNT)) return next();

        let rest: string;
        try {
          rest = decodeURIComponent(pathname.slice(MOUNT.length));
        } catch {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }

        if (rest === 'index.json') {
          let files: string[] = [];
          try {
            files = readdirSync(SAMPLES_DIR, { withFileTypes: true })
              .filter((e) => e.isFile() && /\.(pdf|ofd|xml|zip)$/i.test(e.name))
              .map((e) => e.name)
              .sort();
          } catch {
            files = [];
          }
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify({ files }));
          return;
        }

        // 防目录穿越：用 relative 判断，而不是 startsWith ——
        // `samples/private-evil` 也会通过 `startsWith('samples/private')`。
        const target = normalize(join(SAMPLES_DIR, rest));
        const inside = relative(SAMPLES_DIR, target);
        if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        try {
          if (!statSync(target).isFile()) throw new Error('not a file');
        } catch {
          res.statusCode = 404;
          res.end('not found');
          return;
        }

        const type =
          extname(target).toLowerCase() === '.pdf'
            ? 'application/pdf'
            : 'application/octet-stream';
        res.setHeader('content-type', type);
        res.setHeader('cache-control', 'no-store');
        createReadStream(target).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), cspMeta(), devSamples()],
  // host / port 写死：桌面端 `tauri.conf.json` 的 devUrl 就是 http://127.0.0.1:5180。
  // 端口漂了 Tauri 只会给你一个白屏，所以用 strictPort 让冲突当场报错，而不是悄悄换端口。
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  // 桌面端（M4）会以 file:// 或自定义协议加载，用相对路径最稳
  base: './',
  build: { target: 'safari15', sourcemap: true },
  // pdfjs 的 worker 体积大，不要 inline
  worker: { format: 'es' },
});
