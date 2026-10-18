#!/usr/bin/env node
/**
 * Rust 工具链的看门人（`cargo` 与 `tauri` 都从这儿过）。
 *
 * 三件事：
 *
 * 1. **编译纪律**（AGENTS.md §1）。本机是 8 GB 的 MacBook Air，
 *    `cargo build` / `cargo test` / `tauri build` 会触发完整 codegen + **单进程链接**，
 *    一次几分钟、进程树峰值 0.7–1.2 GB（2026-10-18 实测：debug 744 MB、release 打包 1178 MB）
 *    —— 峰值本身不吓人，但**什么时候到峰值你控制不了**，而你走开的那几分钟没人踩刹车。
 *    这里只放行「只产 metadata」的那几个子命令，其余一律拒绝并说清原因 ——
 *    让人**故意**设 `ALLOW_RUST_BUILD=1` 才可能闯祸，而不是手一滑 `pnpm desktop:build` 就没了。
 *
 * 2. **内存纪律**：起飞前自检 + 运行期看门狗。
 *    看门狗是**事后**刹车：命令跑起来后不停采样（前 5 秒每 100 ms，之后每 2 秒），
 *    两条线任一越界就 **SIGKILL 整棵进程树**：
 *      · 这棵树（cargo + rustc + …）的 RSS 合计 > `RUST_MAX_MEMORY_MB`（默认 2500）
 *      · 系统可用内存（free + inactive + speculative）占比 < `RUST_MIN_FREE_RATIO`（默认 0.12）
 *    **宁可这次检查失败，也不要机器重启。** 检查可以再跑，重启会带走你正在做的事。
 *    但突发涨得太快，等到越界才杀可能已经晚了，能提前做的事必须提前做：会链接的命令
 *    （`cargo build/test/run`、任何 `tauri …`）在**启动 cargo 之前**先量一次可用内存
 *    （`RUST_MIN_FREE_MB` 默认 3000 MB），不够就拒绝，并列出「现在最吃内存的应用 + 怎么退」
 *    —— 内存紧张时该退应用（Chrome / 微信是大头），**不是退终端**（终端自己就是本会话）。
 *    `cargo check` 不链接，低于门槛只提醒、不拦。
 *
 * 3. **PATH**。这台机器上 rustup 装了但 `~/.cargo/bin` 没写进 shell 的 rc，
 *    直接写 `cargo` 的 npm script 只会得到 `command not found`。这里按常见位置找一遍 ——
 *    而且**找到之后要把它所在的目录塞进子进程的 PATH**：`tauri` 是 node 程序，
 *    它按名字 spawn `cargo metadata`，只给绝对路径不够。
 *
 * 用法：`node scripts/rust.mjs cargo check --all-targets -j 2 …`
 *       `node scripts/rust.mjs tauri dev`
 *
 * 允许（只产 metadata，不链接）：
 *   cargo check / fetch / metadata / tree / fmt / clippy
 * 只在 CI 或 `ALLOW_RUST_BUILD=1` 时允许：
 *   cargo test / bench / build / run / install，以及任何 `tauri …`
 *
 * 环境变量：`RUST_MAX_MEMORY_MB`（默认 2500）`RUST_MIN_FREE_RATIO`（默认 0.12）
 *           `RUST_MIN_FREE_MB`（起飞门槛，默认 3000）`RUST_SKIP_PREFLIGHT=1`（跳过自检）
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 只产 metadata：不 codegen、不链接，本机随便跑 */
const METADATA_ONLY = new Set(['check', 'fetch', 'metadata', 'tree', 'fmt', 'clippy']);

/** 进程树 RSS 上限（MB）。正常 check 峰值远低于此；这是给「跑飞了」准备的 */
const MAX_TREE_MB = Number(process.env.RUST_MAX_MEMORY_MB ?? 2500);
/** 系统可用内存占比下限（free + inactive + speculative / 总量） */
const MIN_FREE_RATIO = Number(process.env.RUST_MIN_FREE_RATIO ?? 0.12);
/** 起飞前自检：会链接的命令要求可用内存不低于这个数（MB），不到就**拒绝启动** */
const PREFLIGHT_MIN_MB = Number(process.env.RUST_MIN_FREE_MB ?? 3000);
/** 采样节奏：开头密一点（编译刚起时内存涨得最快），稳定后放宽 */
const SAMPLE_FAST_MS = 100;
const SAMPLE_SLOW_MS = 2000;
const FAST_WINDOW_MS = 5000;

const here = dirname(fileURLToPath(import.meta.url));
const tool = process.argv[2];
const args = process.argv.slice(3);

if (tool !== 'cargo' && tool !== 'tauri') {
  refuse('用法：node scripts/rust.mjs <cargo|tauri> <参数…>');
}

const sub = args[0] ?? '';
const forced = process.env.ALLOW_RUST_BUILD === '1' || process.env.CI === 'true';
const safe = tool === 'cargo' && METADATA_ONLY.has(sub);

if (!safe && !forced) {
  refuse(
    `本机不跑 \`${tool} ${sub}\`：\n` +
      '  它会触发完整 codegen 与**单进程链接**：一次几分钟、进程树峰值 0.7–1.2 GB。\n' +
      '  峰值本身不吓人，但它**什么时候来你控制不了** —— 机器本来就紧时就撞上了（AGENTS.md §1）。\n' +
      '  · 只做类型检查：`pnpm desktop:check`（= cargo check --all-targets -j 2）\n' +
      '  · 跑 Rust 单测 / 打包：默认交给 CI（.github/workflows/ci.yml 与 release.yml）\n' +
      '  · 确实要在这台机器上跑：前面加 ALLOW_RUST_BUILD=1 CARGO_BUILD_JOBS=1\n' +
      '    实测可行（debug 1 m 11 s / 744 MB，release 打包 4 m 07 s / 1178 MB）；\n' +
      '    放行之后还有**起飞前自检**，内存不够仍会被拦；要连它一起无视加 RUST_SKIP_PREFLIGHT=1',
  );
}

// 这台机器上 cargo 可能不在 PATH 里；macOS 上顺手把优先级压到 background，
// 内存紧张时系统先收它，而不是先收你的编辑器。
const binary = tool === 'cargo' ? findCargo() : findTauri();
const launcher = taskPolicy();
const command = launcher ?? binary;
const commandArgs = launcher ? ['-c', 'background', binary, ...args] : args;

// ─────────────────────────── 起飞前自检 ───────────────────────────
// 看门狗（run() 里那个）是**事后**刹车：越界才杀。可链接类命令会在几分钟里涨到 1 GB 上下，
// 内存被别的应用占着时，内核可能在看门狗反应过来之前就先动手了。
// 所以能提前做的事一定要提前做：**在启动 cargo 之前**量一次可用内存，不够就不开。
// 详细理由见文件头 §2 与 AGENTS.md §1。
const memory = systemMemory(true);

if (memory && process.env.RUST_SKIP_PREFLIGHT !== '1') {
  if (memory.usableMb >= PREFLIGHT_MIN_MB) {
    log(`起飞前自检：可用内存 ${gb(memory.usableMb)}，门槛 ${gb(PREFLIGHT_MIN_MB)} ✓`);
  } else if (safe) {
    // 只产 metadata：实测峰值 105–342 MB，不值得为它拦人，提醒一句就够
    log(
      `⚠️ 可用内存 ${gb(memory.usableMb)}，低于构建门槛 ${gb(PREFLIGHT_MIN_MB)}；` +
        '本次是 cargo check（不链接）会继续，但**这会儿别跑构建**。',
    );
  } else {
    refuse(preflightMessage(memory, PREFLIGHT_MIN_MB));
  }
}

run(command, commandArgs);

/** 起进程 + 看门狗。整棵进程树放一个进程组里，越界时能一次杀干净。 */
function run(command, argv) {
  const child = spawn(command, argv, {
    stdio: 'inherit',
    cwd: resolve(here, '..'),
    detached: process.platform !== 'win32',
    // 只把绝对路径喂给 spawn 不够：`tauri` 是 node 程序，它自己按**名字**去 spawn
    // `cargo metadata`。所以 cargo 所在目录必须进 PATH，否则一跑 tauri 就
    // 「failed to run 'cargo metadata' … No such file or directory」。
    env: { ...process.env, PATH: pathWithCargo() },
  });

  let peakMb = 0;
  let samples = 0;
  let killed = undefined;
  const startedAt = Date.now();

  const sample = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;

    const rssMb = treeRssMb(child.pid);
    samples += 1;
    if (rssMb > peakMb) peakMb = rssMb;

    if (rssMb > MAX_TREE_MB) {
      killed = `进程树内存 ${Math.round(rssMb)} MB，超过上限 ${MAX_TREE_MB} MB`;
    } else {
      const free = systemMemory();
      if (free && free.ratio < MIN_FREE_RATIO) {
        killed = `系统可用内存只剩 ${Math.round(free.ratio * 100)}%，低于下限 ${Math.round(
          MIN_FREE_RATIO * 100,
        )}%`;
      }
    }

    if (killed) {
      killTree(child);
      console.error(`\n[rust] ⛔ 已中止：${killed}`);
      console.error('[rust] 宁可这次检查失败，也不要机器重启。要放宽上限：RUST_MAX_MEMORY_MB / RUST_MIN_FREE_RATIO');
      setTimeout(() => process.exit(1), 200);
      return;
    }

    const elapsed = Date.now() - startedAt;
    timer = setTimeout(sample, elapsed < FAST_WINDOW_MS ? SAMPLE_FAST_MS : SAMPLE_SLOW_MS);
  };

  let timer = setTimeout(sample, SAMPLE_FAST_MS);
  timer.unref();

  child.on('error', (err) => {
    clearTimeout(timer);
    refuse(`调不起 ${command}：${err.message}`);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (killed) return; // 已经在看门狗那条路上退出了
    if (signal) {
      console.error(`[rust] ${command} 被信号 ${signal} 结束`);
      process.exit(1);
    }
    const peak = samples === 0 ? '太快，没采到样' : `${Math.round(peakMb)} MB`;
    console.error(`[rust] 峰值内存 ${peak}（上限 ${MAX_TREE_MB} MB，采样 ${samples} 次）`);
    process.exit(code ?? 1);
  });
}

/** 杀掉整棵进程树：先杀进程组，再兜底按 pid 杀 */
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // 负号 = 整个进程组
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已经没了
    }
  }
}

/** 这棵进程树（从 root 往下）的 RSS 合计，MB */
function treeRssMb(rootPid) {
  const out = spawnSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8' }).stdout ?? '';
  const rssKb = new Map();
  const children = new Map();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rss = Number(parts[2]);
    if (!Number.isFinite(pid)) continue;
    rssKb.set(pid, Number.isFinite(rss) ? rss : 0);
    const bucket = children.get(ppid);
    if (bucket) bucket.push(pid);
    else children.set(ppid, [pid]);
  }

  let totalKb = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    totalKb += rssKb.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return totalKb / 1024;
}

/**
 * 系统可用内存：macOS 看 vm_stat，Linux 看 /proc/meminfo。拿不到就返回 undefined。
 * `ratio` 给看门狗用；`detail` 打开才附带给自检报告用的字段 —— `compressorMb` / `swapUsedMb`
 * 是「已经在靠压缩和换页硬撑」的证据，有它才知道账面那个 `usableMb` 有多虚。
 * 看门狗每 100 ms 就要采一次样，所以默认不算这些额外字段（少开一个子进程）。
 */
function systemMemory(detail = false) {
  const total = totalmem();
  try {
    if (process.platform === 'darwin') {
      const out = spawnSync('vm_stat', [], { encoding: 'utf8' }).stdout ?? '';
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (label) =>
        Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? Number.NaN);
      // memory_pressure 的口径：free + inactive + speculative 都算「还能拿来用」
      const usable = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
      if (!Number.isFinite(usable)) return undefined;
      const usableBytes = usable * pageSize;
      const compressor = detail ? pages('Pages occupied by compressor') : 0;
      return {
        ratio: usableBytes / total,
        usableMb: usableBytes / 1048576,
        totalMb: total / 1048576,
        compressorMb: Number.isFinite(compressor) ? (compressor * pageSize) / 1048576 : 0,
        swapUsedMb: detail ? swapUsedMb() : 0,
      };
    }
    const text = readFileSync('/proc/meminfo', 'utf8');
    const availableKb = Number(/MemAvailable:\s+(\d+) kB/.exec(text)?.[1] ?? Number.NaN);
    if (!Number.isFinite(availableKb)) return undefined;
    return {
      ratio: (availableKb * 1024) / total,
      usableMb: availableKb / 1024,
      totalMb: total / 1048576,
      compressorMb: 0,
      swapUsedMb: 0,
    };
  } catch {
    return undefined;
  }
}

/** swap 已用量（MB）。macOS 从 sysctl 拿；拿不到算 0（只是报告里的一个注脚） */
function swapUsedMb() {
  try {
    if (process.platform === 'darwin') {
      const out = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).stdout ?? '';
      return Number(/used\s*=\s*([\d.]+)M/.exec(out)?.[1] ?? 0) || 0;
    }
    const text = readFileSync('/proc/meminfo', 'utf8');
    const size = (label) => Number(new RegExp(`${label}:\\s+(\\d+) kB`).exec(text)?.[1] ?? 0);
    return Math.max(0, (size('SwapTotal') - size('SwapFree')) / 1024);
  } catch {
    return 0;
  }
}

/**
 * 系统可用内存不够时的拒绝理由：差多少、谁在吃、怎么腾。
 * 关键是**最后一步要可执行** —— 直接给出 `osascript -e 'quit app "…"'`，
 * 免得人对着 Activity Monitor 自己猜该关谁（关窗口不算，helper 进程还在）。
 */
function preflightMessage(mem, minMb) {
  const lines = [`起飞前自检没过：可用内存 ${gb(mem.usableMb)}，低于构建门槛 ${gb(minMb)}。`];

  if (mem.compressorMb >= 1024 || mem.swapUsedMb >= 512) {
    lines.push(
      `  而且系统已经在靠压缩/换页撑：压缩器 ${gb(mem.compressorMb)}、swap 已用 ${gb(mem.swapUsedMb)}` +
        ' —— 账面这个「可用」是虚的。',
    );
  }

  const apps = topConsumers(5);
  const freeable = apps.filter((app) => !app.session);
  if (freeable.length > 0) {
    // 名字长短不一（`Google Chrome` 与 `com.apple.WebKit.WebContent` 混在一起），
    // 按最长的一个对齐，超长的截断，免得报告本身读起来费劲
    const width = Math.min(26, apps.reduce((max, app) => Math.max(max, app.name.length), 0));
    lines.push('  现在最吃内存的应用（要退应用，关窗口不算）：');
    for (const app of apps) {
      const name = app.name.length > width ? `${app.name.slice(0, width - 1)}…` : pad(app.name, width);
      const tag = app.session ? '   ← 本会话，别动' : '';
      lines.push(
        `    ${name} ${String(app.mb).padStart(5)} MB / ${String(app.count).padStart(2)} 个进程${tag}`,
      );
      if (app.fromApp && !app.session) lines.push(`      osascript -e 'quit app "${app.name}"'`);
    }
    lines.push(`  退掉这些非会话应用，账面能腾出约 ${gb(freeable.reduce((sum, app) => sum + app.mb, 0))}。`);
  }

  lines.push(
    '  · 只看类型、不链接的 `pnpm desktop:check` 不需要这么多内存，不受这条限制',
    '  · 确实要无视这条线硬跑：RUST_SKIP_PREFLIGHT=1（风险自担）',
  );
  return lines.join('\n');
}

/**
 * 当前最吃内存的「应用」（把 helper 子进程按应用名归并），供自检报告用。
 * 归并规则：`/Applications/Xxx.app/…` → `Xxx`；其余取可执行文件名。
 * 本会话（我们自己往上到 pid 1 的那条祖先进程链，即终端 + 编码助手）会打上 session 标记
 * —— 那些**不能**退：退了等于把正在做的事一起退掉。
 */
function topConsumers(limit) {
  const out = spawnSync('ps', ['-Ao', 'rss=,pid=,ppid=,args='], { encoding: 'utf8' }).stdout ?? '';

  const rows = [];
  for (const line of out.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!row) continue;
    rows.push({ rssKb: Number(row[1]), pid: Number(row[2]), ppid: Number(row[3]), args: row[4] });
  }

  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const session = new Set();
  for (let pid = process.pid; pid > 1 && !session.has(pid); pid = byPid.get(pid)?.ppid ?? 0) {
    session.add(pid);
  }

  const apps = new Map();
  for (const row of rows) {
    const { name, fromApp } = appLabel(row.args);
    let app = apps.get(name);
    if (!app) apps.set(name, (app = { name, fromApp, mb: 0, count: 0, session: false }));
    app.mb += row.rssKb / 1024;
    app.count += 1;
    if (session.has(row.pid)) app.session = true;
  }

  return [...apps.values()]
    .sort((a, b) => b.mb - a.mb)
    .slice(0, limit)
    .map((app) => ({ ...app, mb: Math.round(app.mb) }));
}

/** `/Applications/Xxx.app/…` → `Xxx`；否则取可执行文件名 */
function appLabel(args) {
  const app = /\/Applications\/([^/]+?)\.app\//.exec(args);
  if (app) return { name: app[1], fromApp: true };
  const binary = /^\S+/.exec(args)?.[0] ?? '';
  return { name: binary.replace(/.*\//, '') || '?', fromApp: false };
}

/** macOS：把优先级压到 background（`taskpolicy -c background`，不是 `-b`） */
function taskPolicy() {
  if (process.platform !== 'darwin') return undefined;
  return existsSync('/usr/bin/taskpolicy') ? '/usr/bin/taskpolicy' : undefined;
}

/** PATH → rustup 默认位置 → Homebrew。CI 里 cargo 本来就在 PATH 上。 */
function findCargo() {
  const candidates = [
    join(homedir(), '.cargo', 'bin', 'cargo'),
    '/opt/homebrew/bin/cargo',
    '/usr/local/bin/cargo',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'cargo';
}

/** `tauri` 由 @tauri-apps/cli 提供，pnpm 把它链在 apps/desktop/node_modules/.bin/ */
function findTauri() {
  const local = resolve(here, '..', 'node_modules', '.bin', 'tauri');
  return existsSync(local) ? local : 'tauri';
}

/**
 * 补上 `cargo` 所在目录的 PATH（见 `run()` 里的理由）。
 * 只加确实存在、且当前 PATH 里没有的目录 —— 免得把一个已经正常的环境改乱。
 */
function pathWithCargo() {
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  const extra = [join(homedir(), '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(
    (dir) => existsSync(dir) && !current.includes(dir),
  );
  return [...extra, ...current].join(':');
}

/** 一行 `[rust]` 前缀的进度 / 提醒（走 stderr，不污染 cargo 的 stdout） */
function log(message) {
  console.error(`[rust] ${message}`);
}

/** MB → 「x.xx GB」 */
function gb(mb) {
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** 右补空格（只用于对齐报告里的应用名） */
function pad(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function refuse(message) {
  console.error(`[rust] ${message}`);
  process.exit(1);
}
