import { createReadStream, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, resolve } from 'node:path';

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

function devSamples(): Plugin {
  return {
    name: 'invoice-tool:dev-samples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const at = url.indexOf(MOUNT);
        if (at === -1) return next();

        const rest = decodeURIComponent(url.slice(at + MOUNT.length).split('?')[0] ?? '');

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

        // 防目录穿越：解析后必须仍在 SAMPLES_DIR 里
        const target = normalize(join(SAMPLES_DIR, rest));
        if (!target.startsWith(SAMPLES_DIR) || target === SAMPLES_DIR) {
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
  plugins: [react(), devSamples()],
  // host / port 写死：桌面端 `tauri.conf.json` 的 devUrl 就是 http://127.0.0.1:5180。
  // 端口漂了 Tauri 只会给你一个白屏，所以用 strictPort 让冲突当场报错，而不是悄悄换端口。
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  // 桌面端（M4）会以 file:// 或自定义协议加载，用相对路径最稳
  base: './',
  build: { target: 'safari15', sourcemap: true },
  // pdfjs 的 worker 体积大，不要 inline
  worker: { format: 'es' },
});
