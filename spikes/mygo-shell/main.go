// MyGo × 发票工具：六项能力 spike 的宿主。
//
// 目标不是做产品，而是回答「换到 MyGo 之后，这六件事还能不能跑」：
//   1. pdfjs 的 module worker
//   2. zxing 的 wasm（二维码解码）
//   3. tesseract 的 wasm + worker + 23 MB 中文模型
//   4. IndexedDB
//   5. 拖放拿到 File 对象
//   6. lp 打印（字节从 JS 到 Go 原样到达）
//
// 做法：把**真实的** apps/web/dist 当 MyGo 的前端，用 Go 侧 `Page.Eval` 驱动页面，
// 每一步的结果打印到 stdout。页面里的 Worker / WebAssembly / fetch / 错误都在
// preload 里包了一层，所以「有没有真的跑到 Worker 与 wasm」是观测到的，不是猜的。
//
// 素材（PDF / XML / 图片）不入库：见 README 的「素材」一节。
package main

import (
	"crypto/sha256"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

var (
	distFlag   = flag.String("dist", "../../apps/web/dist", "前端构建产物目录（pnpm --filter @invoice-tool/web build）")
	assetsFlag = flag.String("assets", "assets", "本地素材目录，通过 samples:// 提供给页面；不入库")
)

// Shell 是绑定给页面的 Go 侧能力，这里只放打印这一件（本次 spike 需要的那件）。
type Shell struct{}

// PrintDocument 把页面递来的字节写成临时 PDF，再交给系统打印命令 lp。
// 🔑 关键不是「打没打出来」（没有打印机的机器上打不出来是常态），而是：
//  1. JS → Go 的裸字节是否完好（harness 会比对 sha256）；
//  2. Go 调 lp 的路径是否走得通（不依赖 cgo、不依赖任何原生 API）。
func (s *Shell) PrintDocument(name string, data []byte) (map[string]any, error) {
	dir, err := mygo.App.Path(mygo.PathCache)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "spike-"+name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)

	started := time.Now()
	out, lpErr := exec.Command("lp", path).CombinedOutput()
	elapsed := time.Since(started).Round(time.Millisecond)

	message := "lp 已接受：" + strings.TrimSpace(string(out))
	if lpErr != nil {
		message = "lp 失败（本机没配打印机则属预期）：" + lpErr.Error() + " / " + strings.TrimSpace(string(out))
	}
	return map[string]any{
		"path":    path,
		"size":    len(data),
		"sha256":  fmt.Sprintf("%x", sum),
		"message": message,
		"tookMs":  elapsed.Milliseconds(),
	}, nil
}

// preload 在页面自己的脚本之前跑：把 Worker / WebAssembly / fetch / 错误都记下来。
const preload = `(() => {
  const P = window.__probe = { workers: [], wasm: [], fetches: [], errors: [], console: [] };

  const W = window.Worker;
  if (W) {
    window.Worker = class extends W {
      constructor(url, opts) {
        super(url, opts);
        const info = { url: String(url).slice(-80), type: (opts && opts.type) || 'classic' };
        P.workers.push(info);
        this.addEventListener('error', (e) => P.errors.push('worker error: ' + (e.message || info.url)));
      }
    };
  }

  for (const k of ['instantiateStreaming', 'instantiate', 'compileStreaming', 'compile']) {
    const orig = WebAssembly[k];
    if (typeof orig !== 'function') continue;
    WebAssembly[k] = function (...args) {
      const first = args[0];
      const label = typeof first === 'string' ? first : (first && first.url) || 'buffer';
      P.wasm.push(String(label).slice(-70));
      const p = orig.apply(WebAssembly, args);
      if (p && typeof p.catch === 'function') p.catch((e) => P.errors.push('wasm ' + k + ': ' + e));
      return p;
    };
  }

  const f = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const rec = { url: String(url).slice(0, 160) };
    P.fetches.push(rec);
    return f.call(window, input, init).then(
      (r) => { rec.status = r.status; if (!r.ok) P.errors.push('fetch ' + r.status + ' ' + rec.url); return r; },
      (e) => { rec.error = String(e); P.errors.push('fetch failed: ' + rec.url + ' ' + e); throw e; },
    );
  };

  window.addEventListener('error', (e) => {
    if (e.message) P.errors.push('error: ' + e.message + ' @ ' + (e.filename || '') + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    P.errors.push('rejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  });

  const ce = console.error, cw = console.warn;
  console.error = function (...a) { P.console.push('error: ' + a.map(String).join(' ').slice(0, 400)); ce.apply(console, a); };
  console.warn = function (...a) { P.console.push('warn: ' + a.map(String).join(' ').slice(0, 400)); cw.apply(console, a); };
})();`

func main() {
	flag.Parse()
	log.SetFlags(0)

	dist, err := filepath.Abs(*distFlag)
	if err != nil || !fileExists(filepath.Join(dist, "index.html")) {
		log.Fatalf("找不到前端构建产物：%s（先跑 pnpm --filter @invoice-tool/web build）", *distFlag)
	}
	assets, err := filepath.Abs(*assetsFlag)
	if err != nil || !dirExists(assets) {
		log.Fatalf("找不到素材目录：%s（见 README 的「素材」）", *assetsFlag)
	}

	mygo.Bind(&Shell{})
	mygo.SetFrontend(os.DirFS(dist))
	// 素材通过自定义协议交给页面：顺带验证 mygo.Protocol + FileServer 这一层。
	if err := mygo.Protocol.Handle("samples", mygo.FileServer(os.DirFS(assets))); err != nil {
		log.Println("注册 samples:// 失败：", err)
	}

	mygo.App.WhenReady(func() {
		w := mygo.NewWindow(mygo.WindowOptions{
			Title:  fmt.Sprintf("MyGo spike · %s", filepath.Base(dist)),
			URL:    "/",
			Width:  1280,
			Height: 940,
			Page:   mygo.PageOptions{PreloadScript: preload},
		})
		go drive(w)
	})
	mygo.App.Run()
}

func drive(w *mygo.Window) {
	page := w.Page()

	// 等页面真的加载完。⚠️ 只等 readyState 会踩坑：窗口还没导航时是 about:blank，
	// readyState 已经是 complete，页面却是**空的、origin 为 null** —— 在这种页面上量
	// IndexedDB / localStorage 会得到假的「安全上下文不合法」。所以还要确认已经落到
	// mygo:// 且应用挂了首屏。
	for i := 0; i < 200; i++ {
		out, err := page.Eval(`location.protocol === 'mygo:' && !!document.querySelector('#root') && document.querySelector('#root').children.length > 0`)
		if err == nil {
			if ready, ok := out.(bool); ok && ready {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	time.Sleep(800) // 留给首屏动画与异步 effect

	step := func(name, code string, wait time.Duration) {
		started := time.Now()
		out, err := page.Eval(code)
		if err != nil {
			fmt.Printf("\n### %s\nEVAL 失败：%v\n", name, err)
			return
		}
		fmt.Printf("\n### %s (%s)\n%s\n", name, time.Since(started).Round(time.Millisecond), pretty(out))
		time.Sleep(wait)
	}

	step("0. 环境：origin / 安全上下文 / 三种存储", `
const out = {
  href: location.href,
  origin: location.origin,
  protocol: location.protocol,
  secure: isSecureContext,
  isolated: crossOriginIsolated,
  ua: navigator.userAgent,
  hasWorker: typeof Worker === 'function',
  hasWasm: typeof WebAssembly === 'object',
  hasSubtle: !!(window.crypto && crypto.subtle),
  hasClipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
  print: typeof window.print,
  idbType: typeof indexedDB,
};

try { localStorage.setItem('probe', 'ok'); out.localStorage = localStorage.getItem('probe'); }
catch (e) { out.localStorage = 'ERR ' + e.name + ': ' + e.message; }

try {
  out.idb = await new Promise((resolve) => {
    const req = indexedDB.open('spike-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve({ ok: true, db: req.result.name });
    req.onerror = () => resolve({ ok: false, err: String(req.error) });
    setTimeout(() => resolve({ ok: false, err: 'timeout' }), 5000);
  });
} catch (e) { out.idb = 'THROW ' + e.name + ': ' + e.message; }

try { out.quota = await navigator.storage.estimate(); } catch (e) { out.quota = 'ERR ' + e.name + ': ' + e.message; }
return out;`, 300*time.Millisecond)

	step("1. 拖放导入（PDF + XML，缺哪个就跳过哪个）", `
const files = [];
const missing = [];
for (const n of ['invoice-a.pdf', 'smoke-a.xml', 'smoke-b.xml']) {
  const r = await fetch('samples://localhost/' + encodeURIComponent(n));
  if (!r.ok) { missing.push(n); continue; }
  const blob = await r.blob();
  files.push(new File([blob], n, { type: blob.type || 'application/octet-stream' }));
}
if (files.length === 0) return { skipped: '没有素材，见 README', missing };

const dt = new DataTransfer();
for (const f of files) dt.items.add(f);
window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));

const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  const n = document.querySelectorAll('.item').length;
  const working = /解析中|识别中|工作中/.test(document.body.innerText);
  if (n >= files.length && !working) break;
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 5000)); // 等缩略图与二维码解码收尾
return {
  ms: Date.now() - t0,
  missing,
  items: [...document.querySelectorAll('.item')].map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 150)),
};`, 500*time.Millisecond)

	step("1.5 应用自己的设置持久化（localStorage）", `
const btn = [...document.querySelectorAll('.toolbar .seg button')].find((b) => b.textContent.includes('4'));
const before = Object.keys(localStorage);
if (btn) btn.click();
await new Promise((r) => setTimeout(r, 400));
const keys = {};
for (const k of Object.keys(localStorage)) keys[k] = String(localStorage.getItem(k)).slice(0, 140);
return { clicked: !!btn, before, after: keys };`, 300*time.Millisecond)

	step("2. pdfjs：Worker / 缩略图 / 预览", `
const thumbs = [...document.querySelectorAll('.item-thumb img')];
const slots = [...document.querySelectorAll('.slot img')];
return {
  workers: window.__probe.workers,
  wasm: window.__probe.wasm,
  thumbs: thumbs.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })),
  slots: slots.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })),
  renders: [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height })),
  fetches: window.__probe.fetches.map((f) => (f.status || '?') + ' ' + f.url),
  errors: window.__probe.errors,
  console: window.__probe.console.slice(-12),
};`, 600*time.Millisecond)

	step("3. 原图查看（按需渲染 1400 px）", `
const first = document.querySelector('.item button.icon-btn');
if (!first) return { skipped: '没有导入任何票' };
first.click();
await new Promise((r) => setTimeout(r, 400));
const viewBtn = [...document.querySelectorAll('.item button')].find((b) => b.textContent.includes('看原图'));
if (!viewBtn) return { skipped: '找不到「看原图」（XML 没有原图，属正常）' };
viewBtn.click();
const t0 = Date.now();
let img = null;
while (Date.now() - t0 < 20000) {
  img = document.querySelector('.viewer-stage img');
  if (img && img.naturalWidth > 200) break;
  await new Promise((r) => setTimeout(r, 250));
}
const result = {
  ms: Date.now() - t0,
  found: !!img,
  w: img ? img.naturalWidth : 0,
  h: img ? img.naturalHeight : 0,
  newWorkers: window.__probe.workers.length,
  errors: window.__probe.errors.slice(-3),
};
document.querySelector('.modal')?.querySelector('button')?.click();
await new Promise((r) => setTimeout(r, 300));
return result;`, 400*time.Millisecond)

	step("4. tesseract：无二维码的图走 OCR（wasm + worker + 中文模型）", `
// 这张图应该是「只有中文文字、没有二维码」的截图，这样字段只可能来自 OCR。
const r = await fetch('samples://localhost/ocr-text.png');
if (!r.ok) return { skipped: '没有 ocr-text.png，见 README' };
const blob = await r.blob();
const dt = new DataTransfer();
dt.items.add(new File([blob], 'ocr-text.png', { type: 'image/png' }));
const before = document.querySelectorAll('.item').length;
window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));

const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  const n = document.querySelectorAll('.item').length;
  const working = /解析中|识别中|工作中/.test(document.body.innerText);
  if (n > before && !working) break;
  await new Promise((res) => setTimeout(res, 500));
}
await new Promise((res) => setTimeout(res, 1500));
const ocrHits = window.__probe.fetches.filter((f) => f.url.includes('/ocr/') || f.url.includes('traineddata') || f.url.includes('worker.min'));
return {
  ms: Date.now() - t0,
  items: [...document.querySelectorAll('.item')].map((x) => x.innerText.replace(/\s+/g, ' ').trim().slice(0, 130)),
  ocrFetches: ocrHits.map((f) => (f.status || '?') + ' ' + f.url),
  workers: window.__probe.workers.slice(-3),
  errors: window.__probe.errors.slice(-6),
};`, 600*time.Millisecond)

	step("4.5 OCR 结果与出处（应该写着「来自OCR」）", `
const items = [...document.querySelectorAll('.item')];
const last = items[items.length - 1];
const btn = last && last.querySelector('button.icon-btn');
if (btn) btn.click();
await new Promise((r) => setTimeout(r, 500));
return { diag: last ? last.innerText.replace(/\s+/g, ' ').trim().slice(0, 600) : '' };`, 400*time.Millisecond)

	step("5. lp 打印（字节从 JS 到 Go，比 sha256）", `
const r = await fetch('samples://localhost/invoice-a.pdf');
if (!r.ok) return { skipped: '没有 invoice-a.pdf，见 README' };
const buf = new Uint8Array(await r.arrayBuffer());
let bin = '';
const CHUNK = 0x8000;
for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
const b64 = btoa(bin);
const digest = await crypto.subtle.digest('SHA-256', buf);
const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

const t0 = performance.now();
const out = await window.mygo.call('Shell.PrintDocument', 'spike.pdf', b64);
const ms = Math.round(performance.now() - t0);
return { js: { size: buf.length, b64: b64.length, sha256: hex.slice(0, 16) + '…', ms },
         go: out, same: String(out.sha256).startsWith(hex.slice(0, 16)) };
`, 400*time.Millisecond)

	step("6. 收尾：最后 30 条错误 / 警告", `
return { errors: window.__probe.errors.slice(-30), console: window.__probe.console.slice(-30) };`, 200*time.Millisecond)

	fmt.Println("\n=== spike 结束 ===")
	mygo.App.Exit(0)
}

func pretty(v any) string {
	if m, ok := v.(map[string]any); ok {
		var b strings.Builder
		for k, val := range m {
			fmt.Fprintf(&b, "  %s: %v\n", k, val)
		}
		return b.String()
	}
	return fmt.Sprint(v)
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
