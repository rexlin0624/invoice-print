import { describe, expect, it } from 'vitest';

import { imageDimensions } from './engine';

/**
 * 图片头解析的回归。
 *
 * 这段代码是「**先量尺寸、再解码**」那道闸（见 engine.ts 的 `renderImageFile`）：
 * 量不出来就直接拒绝渲染，所以任何一张合法发票图片被误判成「无法识别」，
 * 用户看到的就是一片空白 —— 而这在单测里只有把字节喂进来才看得见。
 */

function bytes(...parts: Array<number[] | Uint8Array>): ArrayBuffer {
  const out: number[] = [];
  for (const part of parts) out.push(...part);
  return new Uint8Array(out).buffer;
}

/** 最小的 SOI + 若干段 + SOF0（宽 400、高 300） */
function jpegWithSegment(segment: number[]): ArrayBuffer {
  return bytes(
    [0xff, 0xd8], // SOI
    segment, // 一个 APPn 段（长度必须正确，否则会跳到错的地方）
    [
      0xff, 0xc0, 0x00, 0x0b, // SOF0，长度 11
      0x08, // 精度
      0x01, 0x2c, // 高 300
      0x01, 0x90, // 宽 400
      0x03, // 分量数
      0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ],
  );
}

describe('imageDimensions', () => {
  it('JPEG：从 SOFn 读出宽高', () => {
    const got = imageDimensions(jpegWithSegment([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]));
    expect(got).toEqual({ width: 400, height: 300 });
  });

  it('JPEG：marker 前的 0xFF 填充字节不影响解析', () => {
    // `FF FF E0 …`：填充字节是合法的，旧写法会把它当成 marker 0xFF 而算错偏移
    const got = imageDimensions(
      jpegWithSegment([0xff, 0xff, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    );
    expect(got).toEqual({ width: 400, height: 300 });
  });

  it('JPEG：读不到 SOF 时返回 undefined（调用方据此拒绝解码）', () => {
    expect(imageDimensions(bytes([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
  });

  it('PNG：从 IHDR 读宽高', () => {
    const got = imageDimensions(
      bytes([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // 签名
        0x00, 0x00, 0x00, 0x0d, // 长度
        0x49, 0x48, 0x44, 0x52, // IHDR
        0x00, 0x00, 0x01, 0x90, // 宽 400
        0x00, 0x00, 0x01, 0x2c, // 高 300
      ]),
    );
    expect(got).toEqual({ width: 400, height: 300 });
  });

  it('BMP：高为负数表示自上而下，取绝对值', () => {
    const got = imageDimensions(
      bytes([
        0x42, 0x4d, // BM
        ...new Array(16).fill(0), // 文件头剩下的 16 字节 → 宽高从第 18 字节开始
        0x90, 0x01, 0x00, 0x00, // 宽 400（小端）
        0x2c, 0xff, 0xff, 0xff, // 高 -212（小端）
      ]),
    );
    expect(got).toEqual({ width: 400, height: 212 });
  });

  it('认不出的格式返回 undefined', () => {
    expect(imageDimensions(bytes([0x25, 0x50, 0x44, 0x46]))).toBeUndefined();
  });
});
