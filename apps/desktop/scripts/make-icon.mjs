#!/usr/bin/env node
/**
 * 生成应用图标（**纯 Node，零依赖**）。
 *
 * 为什么不直接放几张 .png 完事：图标是「改一处、三个平台都要重新出」的东西，
 * 而且 .ico / .icns 都是容器格式，从一张源图手工导出最容易忘、最容易不一致。
 * 这里用代码画：尺寸、圆角、配色都在一处，跑一次 `pnpm icons` 就能全平台重建。
 *
 * 产出（apps/desktop/src-tauri/icons/）：
 *   32x32.png / 128x128.png / 128x128@2x.png / icon.png   —— Tauri 与 Linux 用
 *   icon.ico                                              —— Windows
 *   icon.icns                                             —— macOS（只在 macOS 上用 iconutil 生成）
 *
 * 用法：node scripts/make-icon.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'src-tauri', 'icons');

// ------------------------------------------------------------------ 形状（单位坐标）

const PRIMARY_TOP = [0x3b, 0x7b, 0xfa];
const PRIMARY_BOTTOM = [0x1d, 0x4e, 0xd8];
const SHEET = [0xff, 0xff, 0xff];
const INK = [0xcb, 0xd5, 0xe1];
const OK = [0x04, 0x78, 0x57];

/** macOS 风格：留一圈边距，圆角接近 squircle */
const BACK = { x0: 0.07, y0: 0.07, x1: 0.93, y1: 0.93, r: 0.22 };
/** 票面 */
const SHEET_RECT = { x0: 0.28, y0: 0.19, x1: 0.72, y1: 0.81, r: 0.045 };
/** 票面上的字（故意 3 行、最后一行短一点，看着像票据信息） */
const LINES = [
  { x0: 0.345, y0: 0.30, x1: 0.655, y1: 0.345, r: 0.022 },
  { x0: 0.345, y0: 0.405, x1: 0.655, y1: 0.45, r: 0.022 },
  { x0: 0.345, y0: 0.51, x1: 0.545, y1: 0.555, r: 0.022 },
];
/** 右下角的「已处理」小勾 */
const BADGE = { cx: 0.705, cy: 0.735, r: 0.15 };
const CHECK = [
  { x0: 0.638, y0: 0.735, x1: 0.688, y1: 0.788 },
  { x0: 0.688, y0: 0.788, x1: 0.782, y1: 0.678 },
];

function insideRounded(u, v, rect) {
  const { x0, y0, x1, y1, r } = rect;
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return Math.hypot(u - cx, v - cy) <= r + 1e-9;
}

function distanceToSegment(u, v, seg) {
  const dx = seg.x1 - seg.x0;
  const dy = seg.y1 - seg.y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((u - seg.x0) * dx + (v - seg.y0) * dy) / len2));
  return Math.hypot(u - (seg.x0 + t * dx), v - (seg.y0 + t * dy));
}

function colorAt(u, v) {
  if (!insideRounded(u, v, BACK)) return null; // 圆角外面留透明
  const t = Math.min(1, Math.max(0, (v - BACK.y0) / (BACK.y1 - BACK.y0)));
  let color = [
    Math.round(PRIMARY_TOP[0] + (PRIMARY_BOTTOM[0] - PRIMARY_TOP[0]) * t),
    Math.round(PRIMARY_TOP[1] + (PRIMARY_BOTTOM[1] - PRIMARY_TOP[1]) * t),
    Math.round(PRIMARY_TOP[2] + (PRIMARY_BOTTOM[2] - PRIMARY_TOP[2]) * t),
  ];
  if (insideRounded(u, v, SHEET_RECT)) color = SHEET;
  for (const line of LINES) {
    if (insideRounded(u, v, line)) color = INK;
  }
  if (Math.hypot(u - BADGE.cx, v - BADGE.cy) <= BADGE.r) {
    color = OK;
    if (CHECK.some((seg) => distanceToSegment(u, v, seg) <= 0.028)) color = SHEET;
  }
  return color;
}

// ------------------------------------------------------------------ 位图 → PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 画一张 size×size 的 RGBA 位图。
 * 先在 4 倍大的画布上按形状填色，再降采样 —— 这就是抗锯齿，
 * 比在单个像素上算覆盖率简单得多，边缘也够干净。
 */
function renderIcon(size) {
  const SS = 4;
  const big = size * SS;
  const out = Buffer.alloc(size * size * 4);

  const bigRgba = Buffer.alloc(big * big * 4);
  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const color = colorAt((x + 0.5) / big, (y + 0.5) / big);
      if (!color) continue;
      const at = (y * big + x) * 4;
      bigRgba[at] = color[0];
      bigRgba[at + 1] = color[1];
      bigRgba[at + 2] = color[2];
      bigRgba[at + 3] = 255;
    }
  }

  const samples = SS * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const at = ((y * SS + dy) * big + (x * SS + dx)) * 4;
          const alpha = bigRgba[at + 3] / 255;
          r += bigRgba[at] * alpha;
          g += bigRgba[at + 1] * alpha;
          b += bigRgba[at + 2] * alpha;
          a += alpha;
        }
      }
      const at = (y * size + x) * 4;
      if (a > 0) {
        out[at] = Math.round(r / a);
        out[at + 1] = Math.round(g / a);
        out[at + 2] = Math.round(b / a);
      }
      out[at + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

const pngCache = new Map();
function png(size) {
  if (!pngCache.has(size)) pngCache.set(size, encodePng(size, renderIcon(size)));
  return pngCache.get(size);
}

// ------------------------------------------------------------------ 容器格式

/** ICO：一个表头 + 每个尺寸一条目录项 + PNG 数据（Vista 起支持 PNG 压缩的图标） */
function encodeIco(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 表示 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

/** ICNS：交给 macOS 自带的 iconutil（只在 macOS 上可用，其它平台跳过） */
function writeIcns(target) {
  if (process.platform !== 'darwin') {
    console.log('· 跳过 icon.icns（只有 macOS 的 iconutil 能生成；已提交的版本可继续用）');
    return;
  }
  const iconset = join(OUT_DIR, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const plan = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of plan) writeFileSync(join(iconset, name), png(size));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target]);
  rmSync(iconset, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 主流程

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, '32x32.png'), png(32));
writeFileSync(join(OUT_DIR, '128x128.png'), png(128));
writeFileSync(join(OUT_DIR, '128x128@2x.png'), png(256));
writeFileSync(join(OUT_DIR, 'icon.png'), png(1024));
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco([16, 32, 48, 64, 128, 256]));
writeIcns(join(OUT_DIR, 'icon.icns'));

console.log(`✓ 图标已写入 ${OUT_DIR}`);
