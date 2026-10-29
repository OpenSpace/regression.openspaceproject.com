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

import { Config } from './configuration';
import { BadGatewayError } from './errors';

/**
 * The number of milliseconds to wait for Jenkins to accept a build request
 */
const RequestTimeout = 15 * 1000;

/**
 * Starts the Jenkins job that builds the application and reruns a single test. Jenkins
 * only queues the build, so this returns as soon as the request was accepted.
 *
 * @param node The label of the Jenkins node on which the test should run
 * @param testId The `group/name` of the test that should be run
 * @param commit The commit that should be built, or `null` to build the latest commit
 * @returns The URL of the queue item that Jenkins created, if it returned one
 */
export async function triggerRerun(
  node: string,
  testId: string,
  commit: string | null
): Promise<string | null> {
  const { jenkins } = Config;
  if (jenkins == null) {
    throw new Error('Jenkins is not configured');
  }

  const url =
    `${jenkins.url.replace(/\/+$/, '')}/job/${encodeURIComponent(jenkins.job)}` +
    '/buildWithParameters';
  const auth = Buffer.from(`${jenkins.user}:${jenkins.token}`).toString('base64');

  // Requests that authenticate with an API token do not need a CSRF crumb
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: new URLSearchParams({ NODE: node, TEST_ID: testId, COMMIT: commit ?? '' }),
      signal: AbortSignal.timeout(RequestTimeout),
      redirect: 'manual'
    });
  } catch (e: unknown) {
    console.error('Could not reach Jenkins:', e);
    throw new BadGatewayError('Could not reach Jenkins to start the test run');
  }

  if (!response.ok) {
    console.error(`Jenkins rejected the build request with status ${response.status}`);
    throw new BadGatewayError(
      `Jenkins rejected the request to start the test run (status ${response.status})`
    );
  }
  return response.headers.get('location');
}
