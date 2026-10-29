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

import { assert } from './assert';
import { referencePointer } from './database';
import { DataFolder } from './paths';
import { TestData } from './testrecords';

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
 * Returns the path to where the image files for the test identified by the
 * `application`, `group`, `name`, `hardware`, and `timestamp` are located. Note that the
 * returned folder might not exist, as test runs that reuse the images of a previous test
 * run do not have a folder.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which the path should be returned
 * @param name The name of the test for which the path should be returned
 * @param hardware The hardware for which the path should be returned
 * @param timestamp The time stamp for which the path should be returned
 * @returns The path to the test files for the provided parameters
 */
export function testPath(
  application: string,
  group: string,
  name: string,
  hardware: string,
  timestamp: Date
): string {
  return `${DataFolder}/tests/${application}/${hardware}/${group}/${name}/${dateToPath(timestamp)}`;
}

/**
 * Removes the provided `folder` if it exists and does not contain any files.
 *
 * @param folder The folder that should be removed if it is empty
 */
export function removeFolderIfEmpty(folder: string) {
  if (fs.existsSync(folder) && fs.readdirSync(folder).length == 0) {
    fs.rmdirSync(folder);
  }
}

/**
 * Returns whether the test identified by `application`, `group`, `name`, and `hardware`
 * has a current reference image.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which to check the current reference image
 * @param name The name of the test for which to check the current reference image
 * @param hardware The hardware for which to check the current reference image
 * @returns Returns `true` if there is a current reference image, `false` otherwise
 */
export function hasReferenceImage(
  application: string,
  group: string,
  name: string,
  hardware: string
): boolean {
  return referencePointer(application, group, name, hardware) != null;
}

/**
 * Returns the path to the reference image for the test identified by `application`,
 * `group`, `name`, and `hardware`. This function assumes that this test has a currently
 * valid reference image.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which to return the current reference image
 * @param name The name of the test for which to return the current reference image
 * @param hardware The hardware for which to return the current reference image
 * @returns The path to the current reference image for the requested test
 */
export function referenceImage(
  application: string,
  group: string,
  name: string,
  hardware: string
): string {
  const pointer = referencePointer(application, group, name, hardware);
  assert(pointer != null, 'No reference image found');

  return `${referenceImagePath(application, group, name, hardware)}/${pointer}`;
}

/**
 * Returns the path at which a new reference image that is created from the test run at
 * `timestamp` is stored and creates the folder for it if necessary. The reference pointer
 * is not changed; that has to happen once the image has been written.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which to create the reference image
 * @param name The name of the test for which to create the reference image
 * @param hardware The hardware for which to create the reference image
 * @param timestamp The time stamp of the test run from which the reference is created
 * @returns The path to the new reference image
 */
export function newReferenceImagePath(
  application: string,
  group: string,
  name: string,
  hardware: string,
  timestamp: Date
): string {
  const folder = referenceImagePath(application, group, name, hardware);
  fs.mkdirSync(folder, { recursive: true });
  return `${folder}/${dateToPath(timestamp)}.png`;
}

/**
 * Returns the path to the reference image that was used for the test run `data` of the
 * test identified by the `application`, `group`, `name`, and `hardware`. This might be
 * different from the currently active reference image.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which to return the reference image
 * @param name The name of the test for which to return the reference image
 * @param hardware The hardware for which to return the reference image
 * @param data The test run for which to return the reference image
 * @returns The path to the reference image of the requested test run
 */
export function testReferenceImage(
  application: string,
  group: string,
  name: string,
  hardware: string,
  data: TestData
): string {
  return `${referenceImagePath(application, group, name, hardware)}/${data.referenceImage}`;
}

/**
 * Returns the path to the candidate image of the test run `data` of the test identified by
 * the `application`, `group`, `name`, and `hardware`. As candidate images are shared
 * between test runs, the image might be stored in the folder of an earlier test run.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which to return the candidate image
 * @param name The name of the test for which to return the candidate image
 * @param hardware The hardware for which to return the candidate image
 * @param data The test run for which to return the candidate image
 * @returns The path to the candidate image of the requested test run
 */
export function candidateImage(
  application: string,
  group: string,
  name: string,
  hardware: string,
  data: TestData
): string {
  return `${testPath(application, group, name, hardware, data.candidateImage)}/candidate.png`;
}

/**
 * Returns the path to the difference image of the test run `data` of the test identified
 * by the `application`, `group`, `name`, and `hardware`. As difference images are shared
 * between test runs, the image might be stored in the folder of an earlier test run.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which to return the difference image
 * @param name The name of the test for which to return the difference image
 * @param hardware The hardware for which to return the difference image
 * @param data The test run for which to return the difference image
 * @returns The path to the difference image of the requested test run
 */
export function differenceImage(
  application: string,
  group: string,
  name: string,
  hardware: string,
  data: TestData
): string {
  return `${testPath(application, group, name, hardware, data.differenceImage)}/difference.png`;
}

/**
 * Returns a path to the folder that contains all references images for the provided
 * `application`, `group`, `name`, and `hardware`.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group for which to return the reference folder path
 * @param name The name of the test for which to return the reference folder path
 * @param hardware The hardware for which to return the reference folder path
 * @returns The path to the reference folder for the requested test
 */
export function referenceImagePath(
  application: string,
  group: string,
  name: string,
  hardware: string
): string {
  return `${DataFolder}/reference/${application}/${hardware}/${group}/${name}`;
}
