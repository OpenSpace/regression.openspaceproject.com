/*****************************************************************************************
 *                                                                                       *
 * OpenSpace Visual Testing                                                              *
 *                                                                                       *
 * Copyright (c) 2024-2026                                                               *
 *                                                                                       *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this  *
 * software and associated documentation files (the "Software"), to deal in the Software *
 * without restriction, including without limitation the rights to use, copy, modify,    *
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to    *
 * permit persons to whom the Software is furnished to do so, subject to the following   *
 * conditions:                                                                           *
 *                                                                                       *
 * The above copyright notice and this permission notice shall be included in all copies *
 * or substantial portions of the Software.                                              *
 *                                                                                       *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,   *
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A         *
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT    *
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF  *
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE  *
 * OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                                         *
 ****************************************************************************************/

import { createHash } from 'crypto';
import fs from 'fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';

import { Config } from './configuration';
import { ValidationError } from './errors';
import { thumbnailForImage } from './globals';
import { MaxImageDimension } from './validation';

// sharp keeps files open in its cache, which would prevent them from being deleted on
// Windows
sharp.cache(false);

/**
 * The largest number of pixels that an image may have
 */
const MaxPixels = MaxImageDimension * MaxImageDimension;

/**
 * The 8 bytes with which every PNG file starts
 */
const PngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads the size of a PNG image from its header without decoding the image.
 *
 * @param buffer The beginning of the PNG file; at least the first 24 bytes are needed
 * @returns The width and height in pixels or `null` if the buffer is not a PNG file
 */
export function pngHeaderSize(buffer: Buffer): { width: number; height: number } | null {
  // The signature is followed by the IHDR chunk: 4 bytes length, 4 bytes type, and then
  // the width and the height as 4 byte big-endian integers
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(PngSignature) ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Decodes a PNG image that was uploaded by a client. The size of the image is checked
 * before it is decoded so that images that are too large are never loaded into memory.
 *
 * @param buffer The contents of the uploaded file
 * @returns The decoded image
 * @throws ValidationError if the file is not a valid PNG image or is too large
 */
export function decodeUploadedPng(buffer: Buffer): PNG {
  const size = pngHeaderSize(buffer);
  if (size == null) {
    throw new ValidationError('The uploaded file is not a PNG image');
  }
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > MaxImageDimension ||
    size.height > MaxImageDimension
  ) {
    throw new ValidationError(
      `The image is ${size.width}x${size.height} pixels, but images can be at most ` +
        `${MaxImageDimension}x${MaxImageDimension} pixels`
    );
  }

  try {
    return PNG.sync.read(buffer);
  } catch (e: unknown) {
    throw new ValidationError(
      `Error loading image: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Loads the PNG image stored at `path`.
 *
 * @param path The path to the image, which has to exist and be a valid PNG file
 * @returns The decoded image
 */
export function readPng(path: string): PNG {
  return PNG.sync.read(fs.readFileSync(path));
}

/**
 * Returns the size (width and height in pixels) of the PNG image stored at the provided
 * `path`. Only the header of the file is read.
 *
 * @param path The path to the image for which to return the size
 * @returns The width and height of the image in pixels
 */
export function imageSize(path: string): { width: number; height: number } {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(path, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const size = pngHeaderSize(header);
  if (size == null) {
    throw new Error(`File ${path} is not a PNG image`);
  }
  return size;
}

/**
 * Computes a hash of the pixels of an image, which is used to find identical images. The
 * hash covers the size and the 8-bit RGBA values of all pixels, so images that are
 * encoded differently but show exactly the same pixels have the same hash.
 *
 * @param image The path to a PNG file or the contents of a PNG file
 * @returns The SHA-256 hash of the image's pixels as a hexadecimal string
 */
export async function pixelHash(image: string | Buffer): Promise<string> {
  // The file is read by Node instead of sharp, as sharp cannot open paths that are longer
  // than 260 characters on Windows
  const input = typeof image === 'string' ? await fs.promises.readFile(image) : image;
  const { data, info } = await sharp(input, { limitInputPixels: MaxPixels })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  return createHash('sha256')
    .update(`${info.width}x${info.height}\n`)
    .update(data)
    .digest('hex');
}

/**
 * Runs an image comparison to compare the `reference` image with the `candidate` image.
 * The `reference` and `candidate` images must have the same size.
 *
 * @param reference The reference image
 * @param candidate The candidate image
 * @returns The difference image and the ratio of pixels that are changed between the
 *          reference and the candidate image. Returns `null` if the images have different
 *          sizes
 */
export function compareImages(
  reference: PNG,
  candidate: PNG
): { image: PNG; error: number } | null {
  if (reference.width != candidate.width || reference.height != candidate.height) {
    return null;
  }

  const { width, height } = reference;
  const image = new PNG({ width, height });
  const nPixels = pixelmatch(reference.data, candidate.data, image.data, width, height, {
    threshold: Config.comparisonThreshold
  });

  return { image: image, error: nPixels / (width * height) };
}

/**
 * Returns a message that describes that two images have different sizes.
 */
export function resolutionMismatch(
  reference: { width: number; height: number },
  candidate: { width: number; height: number }
): string {
  return (
    `Resolution mismatch: reference is ${reference.width}x${reference.height}, ` +
    `candidate is ${candidate.width}x${candidate.height}`
  );
}

/**
 * Creates a thumbnail for the image provided by the `path`. The path has to be a valid
 * filepath to a file that exists. The image is scaled down by the value specified in the
 * global configuration file. The thumbnail is stored at a location that is generated by
 * the `thumbnailForImage` function. The thumbnail preserves the aspect ratio of the
 * original image, which does not have to match the global image size.
 *
 * @param path The path to the file for which a thumbnail should be created
 * @returns The path to the thumbnail
 */
export async function createThumbnail(path: string): Promise<string> {
  const thumbnail = thumbnailForImage(path);
  const { width, height } = imageSize(path);
  // The files are read and written by Node instead of sharp, as sharp cannot open paths
  // that are longer than 260 characters on Windows
  const image = await sharp(await fs.promises.readFile(path), {
    limitInputPixels: MaxPixels
  })
    .resize({
      width: Math.max(1, Math.round(width / Config.thumbnailScale)),
      height: Math.max(1, Math.round(height / Config.thumbnailScale)),
      fit: 'fill'
    })
    .png()
    .toBuffer();
  await fs.promises.writeFile(thumbnail, image);
  return thumbnail;
}
