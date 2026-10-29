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

import { Response } from 'express';
import { rateLimit } from 'express-rate-limit';

import { Config } from '../configuration';

/**
 * The number of failed authentication attempts that a client can make per time window
 */
const MaxFailedAttempts = 10;

/**
 * Creates the rate limiters that protect the API. This has to be called after the
 * configuration has been loaded, as the limits are taken from it.
 *
 * @returns The rate limiters for the different kinds of API calls
 */
export function createLimiters() {
  const { windowMs, maxRequests } = Config.rateLimit;

  // Only failed authentication attempts count against the limit, so that the runners can
  // submit a large number of tests and admins are not locked out by their own actions
  const failedAuthentication = {
    windowMs: windowMs,
    limit: MaxFailedAttempts,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req: unknown, res: Response) => res.statusCode !== 401,
    standardHeaders: 'draft-8' as const,
    legacyHeaders: false
  };

  return {
    /// Limits the failed authentication attempts on the API calls that require the admin
    /// token
    admin: rateLimit({
      ...failedAuthentication,
      message: {
        error: 'Too many failed authentication attempts, please try again later'
      }
    }),

    /// Limits the failed authentication attempts on the API calls that require a runner id
    runner: rateLimit({
      ...failedAuthentication,
      message: {
        error: 'Too many failed authentication attempts, please try again later'
      }
    }),

    /// Limits the API calls that generate new comparison images, which are expensive
    compare: rateLimit({
      windowMs: windowMs,
      limit: maxRequests,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests, please slow down' }
    })
  };
}
