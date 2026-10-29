import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/errors';
import { decodeUploadedPng, pixelHash, pngHeaderSize } from '../src/image';

/**
 * Creates a PNG file of the provided size, in which every pixel has the provided color.
 */
function makePng(
  width: number,
  height: number,
  color: [number, number, number, number],
  options: { deflateLevel?: number } = {}
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data.set(color, i * 4);
  }
  return PNG.sync.write(png, options);
}

/**
 * Creates the beginning of a PNG file whose header claims the provided size.
 */
function fakeHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('pngHeaderSize', () => {
  it('reads the size of a PNG image', () => {
    expect(pngHeaderSize(makePng(7, 3, [0, 0, 0, 255]))).toEqual({ width: 7, height: 3 });
  });

  it('returns null for files that are not PNG images', () => {
    expect(pngHeaderSize(Buffer.from('GIF89a this is not a png file'))).toBeNull();
    expect(pngHeaderSize(Buffer.alloc(0))).toBeNull();
  });
});

describe('decodeUploadedPng', () => {
  it('decodes valid images', () => {
    const png = decodeUploadedPng(makePng(4, 2, [255, 0, 0, 255]));
    expect(png.width).toBe(4);
    expect(png.height).toBe(2);
  });

  it('rejects images that are too large without decoding them', () => {
    expect(() => decodeUploadedPng(fakeHeader(20000, 10))).toThrow(/16384x16384/);
    expect(() => decodeUploadedPng(fakeHeader(10, 16385))).toThrow(ValidationError);
  });

  it('rejects files that are not PNG images', () => {
    expect(() => decodeUploadedPng(Buffer.from('not a png'))).toThrow(ValidationError);
  });

  it('rejects broken PNG files', () => {
    expect(() => decodeUploadedPng(fakeHeader(10, 10))).toThrow(ValidationError);
  });
});

describe('pixelHash', () => {
  it('is the same for identical pixels that are encoded differently', async () => {
    const a = makePng(16, 16, [10, 20, 30, 255], { deflateLevel: 0 });
    const b = makePng(16, 16, [10, 20, 30, 255], { deflateLevel: 9 });
    expect(a.equals(b)).toBe(false);
    expect(await pixelHash(a)).toBe(await pixelHash(b));
  });

  it('differs for different pixels', async () => {
    const a = makePng(16, 16, [10, 20, 30, 255]);
    const b = makePng(16, 16, [10, 20, 31, 255]);
    expect(await pixelHash(a)).not.toBe(await pixelHash(b));
  });

  it('differs for different sizes with the same pixel data', async () => {
    const a = makePng(16, 4, [10, 20, 30, 255]);
    const b = makePng(4, 16, [10, 20, 30, 255]);
    expect(await pixelHash(a)).not.toBe(await pixelHash(b));
  });
});
