/**
 * 生产 CSP 冒烟：在**构建产物**上验证策略真的被浏览器执行。
 *
 * 为什么需要它：`check-build.mjs` 只能证明 meta 在产物里、指令文字没被改松；
 * 但「浏览器到底认不认这条策略」只有真跑一次才知道（指令拼错、被别的 meta 覆盖、
 * 插件在 build 阶段没生效，静态检查都看不出来）。而 `pnpm e2e` 的主 harness
 * 跑在 Vite dev server 上 —— dev 不注入 CSP，所以那条链路**从来没验证过策略本身**。
 *
 * 这个页面由 `scripts/e2e.mjs` 的第二段加载：
 * 1. `E2E_CSP=1` 构建出 `dist-e2e/`（多一个 HTML 入口，正常产物不受影响）；
 * 2. 用同源静态服务器托管，页面用 `?report=&canary=` 拿到两个地址；
 * 3. 依次触发 fetch / img / script / iframe 的**跨源**加载，断言每条都被对应的
 *    指令拦下（`securitypolicyviolation`），且同源 fetch 不被误伤；
 * 4. 真正「有没有出网」由外部的金丝雀服务器统计 —— 页面自己看不到网络层。
 *
 * 只做冒烟，不复刻整套 e2e：这里不 import 任何业务代码，避免把渲染回归也拖进来。
 */

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

interface Violation {
  /** `effectiveDirective`（CSP3）优先，退回 `violatedDirective` */
  directive: string;
  blocked: string;
}

const results: Result[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

const params = new URLSearchParams(location.search);
/** 金丝雀服务器：所有「应该被拦掉」的跨源请求都打到这里 */
const canary = (params.get('canary') ?? 'http://127.0.0.1:5401').replace(/\/+$/, '');
/** 结果回传路径：必须同源，否则会被自己的 connect-src 拦掉 */
const reportPath = params.get('report') ?? '/report';

const violations: Violation[] = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push({
    directive: event.effectiveDirective || event.violatedDirective,
    blocked: event.blockedURI,
  });
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const violationsFor = (directive: string): Violation[] =>
  violations.filter((v) => v.directive === directive);

/** 只保留最后一段，避免把整条策略打满日志 */
const shorten = (text: string): string => (text.length > 80 ? `${text.slice(0, 77)}…` : text);

async function run(): Promise<void> {
  // ---- 1. 策略真的在产物里 ----
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[http-equiv="Content-Security-Policy"]',
  );
  const csp = meta?.content ?? '';
  check(
    '产物带 CSP meta',
    meta !== null && csp.trim() !== '',
    meta === null ? '没找到 meta' : shorten(csp),
  );
  check(
    'CSP 的关键指令在（connect-src self / object-src none）',
    csp.includes("connect-src 'self'") && csp.includes("object-src 'none'"),
    csp.includes("connect-src 'self'") ? 'connect-src 与 object-src 都在' : '缺少关键指令',
  );

  // ---- 2. 同源请求不能被误伤 ----
  // 这条必须放在跨源尝试**之前**：否则计数里会混进后面的违规事件。
  let sameOriginOk = false;
  let sameOriginError = '';
  try {
    const response = await fetch(location.pathname, { cache: 'no-store' });
    sameOriginOk = response.ok;
    if (!response.ok) sameOriginError = `HTTP ${response.status}`;
  } catch (err) {
    sameOriginError = err instanceof Error ? err.message : String(err);
  }
  check(
    '同源 fetch 未被误伤',
    sameOriginOk && violationsFor('connect-src').length === 0,
    sameOriginOk
      ? '同源 GET 成功，且没有 connect-src 违规'
      : `同源 GET 失败：${sameOriginError}`,
  );

  // ---- 3. 四类跨源加载都必须被拦 ----
  const before = violations.length;

  // fetch → connect-src 'self'
  try {
    await fetch(`${canary}/fetch`, { cache: 'no-store' });
  } catch {
    // 被 CSP 拦掉时 fetch 会 reject；这里只关心下面的事件
  }

  // img → img-src 'self' data: blob:
  const image = new Image();
  image.src = `${canary}/pixel.png`;
  document.body.appendChild(image);

  // script → script-src 'self' 'wasm-unsafe-eval'
  const script = document.createElement('script');
  script.src = `${canary}/evil.js`;
  document.head.appendChild(script);

  // iframe → frame-src 'self' blob:
  const frame = document.createElement('iframe');
  frame.src = `${canary}/frame`;
  document.body.appendChild(frame);

  // 事件是异步派发的，等一小段让四条都落下来
  await wait(600);

  const seen = violations.slice(before);
  const hit = (...directives: string[]): boolean =>
    seen.some((violation) => directives.includes(violation.directive));
  const seenText = seen.map((v) => v.directive).join(', ') || '无';

  check(
    'connect-src 拦住跨源 fetch',
    hit('connect-src'),
    hit('connect-src') ? '收到 connect-src 违规事件' : `只收到：${seenText}`,
  );
  check(
    'img-src 拦住跨源图片',
    hit('img-src'),
    hit('img-src') ? '收到 img-src 违规事件' : `只收到：${seenText}`,
  );
  check(
    'script-src 拦住跨源脚本',
    // `<script src>` 在 CSP3 里的 effective directive 是 `script-src-elem`
    hit('script-src', 'script-src-elem'),
    hit('script-src', 'script-src-elem') ? '收到 script-src 违规事件' : `只收到：${seenText}`,
  );
  check(
    'frame-src 拦住跨源 iframe',
    hit('frame-src'),
    hit('frame-src') ? '收到 frame-src 违规事件' : `只收到：${seenText}`,
  );

  // ---- 4. 回传（同源） ----
  const payload = {
    ok: results.every((result) => result.ok),
    results,
    violations: seen.map((violation) => violation.directive),
  };

  const log = document.getElementById('log');
  if (log) log.textContent = JSON.stringify(payload, null, 2);

  try {
    await fetch(reportPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // 连回传都被拦说明 connect-src 配错了；外层会因收不到结果超时失败
  }
}

void run();
