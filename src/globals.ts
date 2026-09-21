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

import { assert } from './assert';
import { Config } from './configuration';
import { imagesAreEqual } from './image';
import { loadTestRecord } from './testrecords';

/**
 * Converts the provided `date` to a version in which it can be used as part of a path in
 * the filesystem or as part of a URL
 *
 * @param date The Date object that should be converted
 * @returns A string that is safe to be used as a filesystem path or a URL
 */
export function dateToPath(date: Date): string {
  return date.toISOString().split('-').join('').split(':').join('').split('.').join('');
}

/**
 * The shape of a folder name as it is created by `dateToPath`, for example
 * "20260610T153545847Z".
 */
const FolderTimestamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/**
 * Parses a folder name (in the format produced by dateToPath) and returns a Date object.
 * This is the inverse of dateToPath.
 *
 * @param folderName The folder name to parse (e.g., "20260610T153545847Z")
 * @returns A Date object representing the timestamp, or `null` if the name does not have
 *          the expected format
 */
export function parseFolderPathToTimestamp(folderName: string): Date | null {
  const match = FolderTimestamp.exec(folderName);
  if (match == null) {
    return null;
  }

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7])
    )
  );
}

/**
 * Returns the path used for storing the thumbnail for the provided image.
 *
 * @param path The path to the image for which the thumbnail path should be returned
 * @returns The path to the thumbnail image
 */
export function thumbnailForImage(path: string): string {
  const ext = path.substring(path.lastIndexOf('.'));
  const base = path.substring(0, path.lastIndexOf('.'));
  return `${base}-thumbnail${ext}`;
}

/**
 * Returns the base path to where the files for the latest test for the `group`, `name`,
 * and `hardware` are stored. If no test exists for that test, `null` is returned.
 *
 * @param group The name of the group for which the latest test should be returned
 * @param name The name of the test for which the latest run should be returned
 * @param hardware The hardware for which the latest test should be returned
 * @param timestamp If the date is provided, the last test before or at the provided date is
 *        returned. If no exact match exists, the closest previous timestamp is returned.
 * @returns The path where the test files for the latest test are stored
 */
export function latestTestPath(
  group: string,
  name: string,
  hardware: string,
  timestamp?: Date
): string | null {
  const path = `${Config.data}/tests/${hardware}/${group}/${name}`;
  if (!fs.existsSync(path)) {
    return null;
  }

  let tests = fs.readdirSync(path);

  if (timestamp) {
    const target = timestamp.getTime();

    // Find the test with the largest timestamp that is at or before the target
    let bestTest: string | null = null;
    let bestTime = -Infinity;

    for (const test of tests) {
      const date = parseFolderPathToTimestamp(test);
      if (date == null) {
        // The folder does not have the shape of a test run, so we skip it
        continue;
      }

      const time = date.getTime();
      if (time <= target && time > bestTime) {
        bestTime = time;
        bestTest = test;
      }
    }

    if (bestTest == null) {
      // No test exists at or before the target timestamp
      return null;
    }

    tests = [bestTest];
  }

  if (tests.length == 0) {
    return null;
  }

  tests.sort();

  return `${path}/${tests[tests.length - 1]}`;
}

/**
 * Returns the path to where the files for the test identified by the `group`, `name`,
 * `hardware`, and `timestamp` are located. Note that the returned folder might not exist,
 * if such a test is not available.
 *
 * @param group The name of the group for which the path should be returned
 * @param name The name of the test for which the path should be returned
 * @param hardware The hardware for which the path should be returned
 * @param timestamp The time stamp for which the path should be returned
 * @returns The path to the test files for the provided parameters
 */
export function testPath(
  group: string,
  name: string,
  hardware: string,
  timestamp: Date
): string {
  return `${Config.data}/tests/${hardware}/${group}/${name}/${dateToPath(timestamp)}`;
}

/**
 * Returns the path to the file that contains the name of the file that is considered the
 * most current reference image. If this file does not exist, then there is no current
 * reference image and the next candidiate image will be upgraded to be the new reference
 * image.
 *
 * @param group The group name of the test for which to return the reference pointer file
 * @param name The test name for which to return the reference pointer file
 * @param hardware The hardware for which to return the reference pointer file
 * @returns The path to the reference pointer file that contains the name of the current
 *          reference file for the test
 */
function referencePointer(group: string, name: string, hardware: string): string {
  return `${Config.data}/reference/${hardware}/${group}/${name}/ref.txt`;
}

/**
 * Invalidates the current reference image for the test identified by the `group`, `name`,
 * and `hardware`.
 *
 * @param group The name of the group for which the current reference should be
 *              invalidated
 * @param name The name of the test for which the current reference should be invalidated
 * @param hardware The hardware for which the current reference should be invalidated
 */
export function clearReferencePointer(group: string, name: string, hardware: string) {
  fs.unlinkSync(referencePointer(group, name, hardware));
}

/**
 * Updates the current reference image for the test identified by `group`, `name`, and
 * `hardware` to point at the image identified by the `timestamp`.
 *
 * @param group The name of the group for which to update the current reference image
 * @param name The name of the test for which to update the current reference image
 * @param hardware The hardware for which to update the current reference image
 * @param timestamp The time stamp of the image that is used as the new reference image
 * @returns The path to the file that is used as the new reference image
 */
export function updateReferencePointer(
  group: string,
  name: string,
  hardware: string,
  timestamp: Date
): string {
  assert(!hasReferenceImage(group, name, hardware), 'Reference pointer already exists');

  const p = `${dateToPath(timestamp)}.png`;
  const ref = referencePointer(group, name, hardware);
  if (!fs.existsSync(path.dirname(ref))) {
    fs.mkdirSync(path.dirname(ref), { recursive: true });
  }
  fs.writeFileSync(ref, p);

  return referenceImage(group, name, hardware);
}

/**
 * Returns whether the test identified by `group`, `name`, and `hardware` has a current
 * reference image.
 *
 * @param group The name of the group for which to check the current reference image
 * @param name The name of the test for which to check the current reference image
 * @param hardware The hardware for which to check the current reference image
 * @returns Returns `true` if there is a current reference image, `false` otherwise
 */
export function hasReferenceImage(
  group: string,
  name: string,
  hardware: string
): boolean {
  return fs.existsSync(referencePointer(group, name, hardware));
}

/**
 * Returns the path to the reference image for the test identified by `group`,
 * `name`, and `hardware`. This function assumes that this test has a currently valid
 * reference image.
 *
 * @param group The name of the group for which to return the current reference image
 * @param name The name of the test for which to return the current reference image
 * @param hardware The hardware for which to return the current reference image
 * @returns The path to the current reference image for the requested test
 */
export function referenceImage(group: string, name: string, hardware: string): string {
  assert(hasReferenceImage(group, name, hardware), 'No reference image found');

  const path = fs.readFileSync(referencePointer(group, name, hardware)).toString();
  return `${Config.data}/reference/${hardware}/${group}/${name}/${path}`;
}

/**
 * Returns the path to the candidate image for the test identified by the `group`, `name`,
 * `hardware`, and `timestamp`. Note that this path might not exist if no test has run for
 * these test parameters.
 *
 * @param group The name of the group for which to return the candidate image
 * @param name The name of the test for which to return the candidate image
 * @param hardware The hardware for which to return the candidate image
 * @param timestamp The time stamp for which to return the candidate image
 * @returns The path to the candidate image for the requested test
 */
export function candidateImage(
  group: string,
  name: string,
  hardware: string,
  timestamp?: Date
): string {
  const path = testDataPath(group, name, hardware, timestamp);
  if (fs.existsSync(path)) {
    const data = loadTestRecord(path);
    return `${testPath(group, name, hardware, data.candidateImage)}/candidate.png`;
  } else {
    // The data path might not exist yet, if this is the first time the test is run
    if (timestamp == null) {
      return `${latestTestPath(group, name, hardware)}/candidate.png`;
    } else {
      return `${testPath(group, name, hardware, timestamp)}/candidate.png`;
    }
  }
}

/**
 * Returns the path to the difference image for the test identified by the `group`,
 * `name`, `hardware`, and `timestamp`. Note that this path might not exist if no test has
 * run for these test parameters.
 *
 * @param group The name of the group for which to return the difference image
 * @param name The name of the test for which to return the difference image
 * @param hardware The hardware for which to return the difference image
 * @param timestamp The time stamp for which to return the difference image
 * @returns The path to the difference image for the requested test
 */
export function differenceImage(
  group: string,
  name: string,
  hardware: string,
  timestamp?: Date
): string {
  const path = testDataPath(group, name, hardware, timestamp);
  if (fs.existsSync(path)) {
    const data = loadTestRecord(path);
    return `${testPath(group, name, hardware, data.differenceImage)}/difference.png`;
  } else {
    // The data path might not exist yet, if this is the first time the test is run
    if (timestamp == null) {
      return `${latestTestPath(group, name, hardware)}/difference.png`;
    } else {
      return `${testPath(group, name, hardware, timestamp)}/difference.png`;
    }
  }
}

/**
 * Returns the path to the log file for the test identified by the `group`, `name`,
 * `hardware`, and `timestamp`. Note that this path might not exist if no test has run for
 * these test parameters.
 *
 * @param group The name of the group for which to return the log file
 * @param name The name of the test for which to return the log file
 * @param hardware The hardware for which to return the log file
 * @param timestamp The time stamp for which to return the log file
 * @returns The path to the log file for the requested test
 */
export function logFile(
  group: string,
  name: string,
  hardware: string,
  timestamp: Date
): string {
  return `${testPath(group, name, hardware, timestamp)}/log.txt`;
}

/**
 * Returns the path to the test data file for the test identified by the `group`, `name`,
 * `hardware`, and `timestamp`. If the `timestamp` value is not provided, the latest path
 * will be returned instead. Note that this path might not exist if no test has run for
 * these test parameters.
 *
 * @param group The name of the group for which to return the test data file
 * @param name The name of the test for which to return the test data file
 * @param hardware The hardware for which to return the test data file
 * @param timestamp The time stamp for which to return the test data file or the latest
 *                  test path if this parameter is omitted
 * @returns The path to the test data file for the requested test
 */
export function testDataPath(
  group: string,
  name: string,
  hardware: string,
  timestamp?: Date
): string {
  if (timestamp) {
    return `${testPath(group, name, hardware, timestamp)}/data.json`;
  } else {
    return `${latestTestPath(group, name, hardware)}/data.json`;
  }
}

/**
 * Returns a path to the folder that contains all references images for the provided
 * `group`, `name`, and `hardware`.
 *
 * @param group The name of the group for which to return the reference folder path
 * @param name The name of the test for which to return the reference folder path
 * @param hardware The hardware for which to return the reference folder path
 * @returns The path to the reference folder for the requested test
 */
export function referenceImagePath(
  group: string,
  name: string,
  hardware: string
): string {
  return `${Config.data}/reference/${hardware}/${group}/${name}`;
}

/**
 * Returns a path to a temporary file in which files can be stored for a short time.
 *
 * @returns A path to a temporary file in which files can be stored for a short time
 */
export function temporaryPath(): string {
  return `${Config.data}/temporary/`;
}

/**
 * Inspects all available candidate images for the test identified by `group`, `name`, and
 * `hardware` and checks if any of the candidate images are identical to the image
 * provided by `image`. If that is the case, the timestamp of the test in which the
 * already existing candidate image is located will be returned.
 *
 * @param group The name of the group for which to check all candidate images
 * @param name The name of the test for which to check all candidate images
 * @param hardware The hardware identifier of the test for which to check candidate images
 * @param image The path to the image for which we want to find a duplicate
 * @returns The timestamp of the test in which to find the already existing candidate
 *          file if a duplicate was found or `null` if the `image` does not have any
 *          duplicates
 */
export function findMatchingCandidateImage(
  group: string,
  name: string,
  hardware: string,
  image: string
): Date | null {
  const base = `${Config.data}/tests/${hardware}/${group}/${name}`;
  const runs = fs.readdirSync(base);
  assert(runs.length > 0, `Could not find test folders for ${hardware}/${group}/${name}`);

  for (const run of runs) {
    const path = `${base}/${run}/candidate.png`;

    // We don't want to compare the image with itself
    if (path == image) continue;

    if (fs.existsSync(path)) {
      const equal = imagesAreEqual(image, path);
      if (equal) {
        // We have found our winner
        const data = loadTestRecord(`${base}/${run}/data.json`);
        return data.timeStamp;
      }
    }
  }

  // If we get this far, we have tested all images and not found a match
  return null;
}

/**
 * Inspects all available difference images for the test identified by `group`, `name`,
 * and `hardware` and checks if any of the difference images are identical to the image
 * provided by `image`. If that is the case, the timestamp of the test in which the
 * already existing difference image is located will be returned.
 *
 * @param group The name of the group for which to check all difference images
 * @param name The name of the test for which to check all difference images
 * @param hardware The hardware id of the test for which to check difference images
 * @param image The path to the image for which we want to find a duplicate
 * @returns The timestamp of the test in which to find the already existing difference
 *          file if a duplicate was found or `null` if the `image` does not have any
 *          duplicates
 */
export function findMatchingDifferenceImage(
  group: string,
  name: string,
  hardware: string,
  image: string
): Date | null {
  const base = `${Config.data}/tests/${hardware}/${group}/${name}`;
  const runs = fs.readdirSync(base);
  assert(runs.length > 0, `Could not find test folders for ${hardware}/${group}/${name}`);

  for (const run of runs) {
    const path = `${base}/${run}/difference.png`;

    // We don't want to compare the image with itself
    if (path == image) continue;

    if (fs.existsSync(path)) {
      const equal = imagesAreEqual(image, path);
      if (equal) {
        // We have found our winner
        const data = loadTestRecord(`${base}/${run}/data.json`);
        return data.timeStamp;
      }
    }
  }

  // If we get this far, we have tested all iamges and not found a match
  return null;
}
