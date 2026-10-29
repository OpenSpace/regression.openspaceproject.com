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

/**
 * A set of asynchronous locks that are identified by a key. Functions that are run with
 * the same key are executed one after another in the order in which they were started,
 * while functions with different keys run independently of each other.
 */
export class KeyedMutex {
  /// For each key, the promise that is resolved when the last queued function finishes
  private tails = new Map<string, Promise<void>>();

  /**
   * Runs the function `fn` once all previously started functions with the same `key` have
   * finished. The returned promise resolves or rejects with the result of `fn`.
   *
   * @param key The key of the lock that should be held while `fn` is running
   * @param fn The function that should be run while holding the lock
   * @returns The value returned by `fn`
   */
  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /**
   * Returns a promise that resolves once no function is running or waiting for any key.
   */
  async idle() {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values());
    }
  }
}

/**
 * The locks that protect the files and database rows of a single test. All operations
 * that change a test (submitting a test run, updating the reference image, regenerating
 * the difference images) have to hold the lock of that test.
 */
export const TestLocks = new KeyedMutex();

/**
 * Returns the key of the lock for the test identified by `application`, `group`, `name`,
 * and `hardware`.
 */
export function testLockKey(
  application: string,
  group: string,
  name: string,
  hardware: string
): string {
  return JSON.stringify([application, hardware, group, name]);
}
