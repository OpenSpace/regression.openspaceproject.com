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

import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { setImmediate as yieldToEventLoop } from 'timers/promises';

import { printAudit } from './audit';
import {
  allReferencePointers,
  allTestRuns,
  allTests,
  HashedImage,
  imagesWithoutHash,
  inTransaction,
  setImageHash,
  testHistory,
  TestKeyParts,
  updateRunImage
} from './database';
import { reportError } from './errorHandling';
import {
  candidateImage,
  differenceImage,
  imageFile,
  referenceImagePath,
  removeFolderIfEmpty,
  testPath,
  testReferenceImage,
  thumbnailForImage
} from './globals';
import { compareImages, createThumbnail, pixelHash, readPng } from './image';
import { testLockKey, TestLocks } from './lock';

export type TestRecord = {
  /// The name of the application that generated this record
  application: string;
  /// The group name of the test record. This value only contains characters that are
  /// allowed by the `NamePattern`
  group: string;
  /// The name of the test record. This value only contains characters that are allowed
  /// by the `NamePattern`
  name: string;
  /// The name of the hardware that was used to generate this record
  hardware: string;
  /// The individual test runs, sorted by their timestamp
  data: TestData[];
};

export type TestData = {
  /// The timestamp at which this test data was generated
  timeStamp: Date;

  /// The number of seconds it took to run this test
  timing: number;

  /// The number of error lines in the log file
  nErrors: number;

  /// The commit hash of the OpenSpace repository that was used to generate this image
  commitHash: string;

  /// Name of the file of the first reference image that was used for this test. The names
  /// of the reference images for the other images are derived from it, see `imageFile`
  referenceImage: string;

  /// The images of this test run, sorted by their number. There is always at least one
  images: TestImage[];
};

export type TestImage = {
  /// The 1-based position of the image in the test run
  image: number;

  /// Contains the pixel error in the image as a value between 0 and 1 as the ratio of
  /// changed pixels to overall pixels
  pixelError: number;

  /// The timestamp of the test whose candidate image that was used for this image
  candidateImage: Date;

  /// The timestamp for the test whose difference image that was used for this image
  differenceImage: Date;
};

/**
 * The number of missing files that are listed individually in the audit log
 */
const MaxListedMissingFiles = 20;

/**
 * Runs a check on all of the data results and ensure that they are all self consistent.
 * This includes checks for:
 *   - All reference pointers point at files that exist
 *   - All images used by the test runs, and their thumbnails, exist
 * Missing files are reported, but do not prevent the server from starting.
 */
export function verifyDataFolder() {
  printAudit('Verifying data files');
  const missing: string[] = [];

  printAudit('  Reference pointers');
  for (const pointer of allReferencePointers()) {
    const { application, group, name, hardware, referenceImage } = pointer;
    const folder = referenceImagePath(application, group, name, hardware);
    const p = `${folder}/${referenceImage}`;
    if (!fs.existsSync(p)) {
      missing.push(`Reference image ${p}`);
    }
  }

  printAudit('  Test run images');
  // Many test runs share the same images, so every image only needs to be checked once
  const verified = new Set<string>();
  function verifyImage(image: string, kind: string) {
    if (verified.has(image)) return;
    verified.add(image);

    if (!fs.existsSync(image)) {
      missing.push(`${kind} image ${image}`);
    }
    if (!fs.existsSync(thumbnailForImage(image))) {
      missing.push(`Thumbnail of ${kind} image ${image}`);
    }
  }

  for (const { application, group, name, hardware, data } of allTestRuns()) {
    for (const image of data.images) {
      verifyImage(
        testReferenceImage(application, group, name, hardware, data, image.image),
        'Reference'
      );
      verifyImage(candidateImage(application, group, name, hardware, image), 'Candidate');
      verifyImage(
        differenceImage(application, group, name, hardware, image),
        'Difference'
      );
    }
  }

  if (missing.length > 0) {
    printAudit(`  ${missing.length} files are missing:`);
    for (const file of missing.slice(0, MaxListedMissingFiles)) {
      printAudit(`    ${file}`);
    }
    if (missing.length > MaxListedMissingFiles) {
      printAudit(`    and ${missing.length - MaxListedMissingFiles} more`);
    }
    reportError(`${missing.length} files are missing in the data folder, see audit.txt`);
  }
}

/**
 * Computes the hashes of all candidate and difference images that do not have a hash in
 * the database yet. This is only necessary for test runs that were migrated from the
 * file-based storage, as the hashes of all newly submitted images are computed when they
 * are submitted.
 */
export async function backfillImageHashes() {
  const Concurrency = 8;

  for (const kind of ['candidate', 'difference'] as HashedImage[]) {
    const images = imagesWithoutHash(kind);
    if (images.length == 0) continue;

    printAudit(`Computing the hashes of ${images.length} ${kind} images`);
    const hashes: { image: (typeof images)[number]; hash: string }[] = [];
    let missing = 0;
    let next = 0;
    async function work() {
      while (next < images.length) {
        const image = images[next]!;
        next++;
        const { application, group, name, hardware, owner } = image;
        const file = imageFile(
          `${testPath(application, group, name, hardware, owner)}/${kind}.png`,
          image.image
        );
        if (!fs.existsSync(file)) {
          missing++;
          continue;
        }
        hashes.push({ image: image, hash: await pixelHash(file) });
        if (hashes.length % 1000 == 0) {
          console.log(`  ${hashes.length} / ${images.length}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Concurrency }, work));

    inTransaction(() => {
      for (const { image, hash } of hashes) {
        const { application, group, name, hardware, owner } = image;
        setImageHash(kind, application, group, name, hardware, image.image, owner, hash);
      }
    });
    printAudit(`  Computed ${hashes.length} hashes, ${missing} images are missing`);
  }
}

/**
 * Whether the test results are currently being regenerated
 */
let Regenerating = false;

/**
 * Whether a running regeneration should stop after the current test
 */
let StopRequested = false;

/**
 * Returns whether the test results are currently being regenerated.
 */
export function isRegenerating(): boolean {
  return Regenerating;
}

/**
 * Starts to regenerate all test results in the background, see `regenerateTestResults`.
 *
 * @returns `true` if the regeneration was started, `false` if a regeneration is already
 *          running
 */
export function startRegeneration(): boolean {
  if (Regenerating) {
    return false;
  }

  Regenerating = true;
  StopRequested = false;
  regenerateTestResults()
    .catch((err: unknown) => {
      reportError(
        `Regenerating the test results failed: ${err instanceof Error ? err.message : err}`
      );
    })
    .finally(() => {
      Regenerating = false;
    });
  return true;
}

/**
 * Asks a running regeneration to stop after the test that it is currently working on.
 */
export function stopRegeneration() {
  StopRequested = true;
}

/**
 * This function will regenerate all of the difference images that are locally stored and
 * update the pixel error values in all tests. In general this should only be necessary if
 * the version of the image diff tool has been updated or if the global image threshold
 * limit has changed. The tests are regenerated one after another while holding the lock
 * of the respective test, so test runs can still be submitted in the meantime.
 */
export async function regenerateTestResults() {
  printAudit('Regenerating all test results');

  const tests = allTests();
  for (const [i, test] of tests.entries()) {
    if (StopRequested) {
      printAudit(`  Regeneration stopped after ${i} of ${tests.length} tests`);
      return;
    }

    const { application, group, name, hardware } = test;
    await TestLocks.run(testLockKey(application, group, name, hardware), () =>
      regenerateTest(test)
    );
    await yieldToEventLoop();

    if ((i + 1) % 100 == 0) {
      console.log(`  Regenerated ${i + 1} / ${tests.length} tests`);
    }
  }

  printAudit(`  Regenerated all ${tests.length} tests`);
}

/**
 * Regenerates the difference images and pixel errors of all test runs of a single test.
 *
 * @param test The test whose results should be regenerated
 */
async function regenerateTest(test: TestKeyParts) {
  const { application, group, name, hardware } = test;

  // Test runs that use the same reference and candidate image end up with the same
  // difference image. So we only generate it once and store it in the folder of the
  // earliest of these test runs. Each image of a test is handled separately
  type Run = { data: TestData; image: TestImage };
  const runGroups = new Map<string, Run[]>();
  const previousDifferences = new Set<string>();
  for (const data of testHistory(application, group, name, hardware)) {
    for (const image of data.images) {
      const key = JSON.stringify([
        image.image,
        data.referenceImage,
        image.candidateImage.getTime()
      ]);
      const runs = runGroups.get(key);
      if (runs) {
        runs.push({ data, image });
      } else {
        runGroups.set(key, [{ data, image }]);
      }
      previousDifferences.add(differenceImage(application, group, name, hardware, image));
    }
  }

  const updates: { timeStamp: Date; image: TestImage; hash: string }[] = [];
  const currentDifferences = new Set<string>();
  for (const runs of runGroups.values()) {
    // The runs are sorted by timestamp, so the first one is the earliest
    const { data, image } = runs[0]!;
    const reference = testReferenceImage(
      application,
      group,
      name,
      hardware,
      data,
      image.image
    );
    const candidate = candidateImage(application, group, name, hardware, image);

    let comparison: { image: PNG; error: number } | null = null;
    if (fs.existsSync(reference) && fs.existsSync(candidate)) {
      comparison = compareImages(readPng(reference), readPng(candidate));
    }
    if (comparison == null) {
      // The images are missing or have different sizes, which can't happen for submitted
      // tests. We keep the previous results for these test runs
      printAudit(
        `  Could not compare the images of (${application}/${group}/${name}/${hardware})`
      );
      for (const run of runs) {
        currentDifferences.add(
          differenceImage(application, group, name, hardware, run.image)
        );
      }
      continue;
    }

    const folder = testPath(application, group, name, hardware, data.timeStamp);
    fs.mkdirSync(folder, { recursive: true });
    const difference = imageFile(`${folder}/difference.png`, image.image);
    const buffer = PNG.sync.write(comparison.image);
    fs.writeFileSync(difference, buffer);
    await createThumbnail(difference);
    const hash = await pixelHash(buffer);

    currentDifferences.add(difference);
    for (const run of runs) {
      updates.push({
        timeStamp: run.data.timeStamp,
        image: {
          ...run.image,
          pixelError: comparison.error,
          differenceImage: data.timeStamp
        },
        hash: hash
      });
    }
    await yieldToEventLoop();
  }

  inTransaction(() => {
    for (const { timeStamp, image, hash } of updates) {
      updateRunImage(application, group, name, hardware, timeStamp, image, hash);
    }
  });

  // Remove the difference images that are no longer used by any test run
  for (const image of previousDifferences) {
    if (currentDifferences.has(image)) continue;

    for (const file of [image, thumbnailForImage(image)]) {
      fs.rmSync(file, { force: true });
    }
    removeFolderIfEmpty(path.dirname(image));
  }
}
