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

import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { printAudit } from '../audit';
import { Config } from '../configuration';
import { UnauthorizedError } from '../errors';

/**
 * Compares two secrets in constant time. Both values are hashed first so that the
 * comparison does not reveal the length of the expected secret either.
 *
 * @param provided The secret that was provided by the client
 * @param expected The secret that the client has to provide
 * @returns `true` if both secrets are identical, `false` otherwise
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Returns whether the provided value is the id of one of the configured runners.
 *
 * @param runnerID The runner id that was provided by the client
 * @returns `true` if the id belongs to an allowed runner, `false` otherwise
 */
export function isRunner(runnerID: unknown): boolean {
  if (typeof runnerID !== 'string' || runnerID === '') {
    return false;
  }
  // Compare with all runners so that the duration does not reveal which one matched
  let found = false;
  for (const runner of Config.runners) {
    found = secretsMatch(runnerID, runner) || found;
  }
  return found;
}

/**
 * Middleware that only lets requests pass that provide the admin token in the
 * `Authorization: Bearer <token>` header.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
  if (match == null || !secretsMatch(match[1]!.trim(), Config.adminToken)) {
    printAudit(`Rejected admin request ${req.method} ${req.path} from ${req.ip}`);
    throw new UnauthorizedError('Invalid or missing admin token');
  }
  next();
}

/**
 * Middleware that only lets requests pass whose body contains the `runnerID` of one of
 * the configured runners. It has to run after the body has been parsed.
 */
export function requireRunner(req: Request, _res: Response, next: NextFunction) {
  const { body }: { body: unknown } = req;
  const runnerID =
    typeof body === 'object' && body != null && 'runnerID' in body ? body.runnerID : null;
  if (!isRunner(runnerID)) {
    printAudit(`Rejected runner request ${req.method} ${req.path} from ${req.ip}`);
    throw new UnauthorizedError('Invalid or missing runner ID');
  }
  next();
}
