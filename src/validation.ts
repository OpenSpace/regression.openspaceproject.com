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

import { z } from 'zod';

import { ValidationError } from './errors';

/**
 * The name of the application that requests resolve to if they do not name one. This is
 * used by the legacy API routes and by clients that predate multiple applications.
 */
export const DefaultApplication = 'openspace';

/**
 * The largest width and height (in pixels) that a submitted image may have.
 */
export const MaxImageDimension = 16384;

/**
 * The amount of time a submitted timestamp may lie in the future, to allow for clocks
 * that are slightly off.
 */
export const MaxFutureOffset = 24 * 60 * 60 * 1000;

/**
 * The pattern that application, group, test, and hardware names must follow. As these
 * names are used as folder names, they must start with a letter or a digit, which rules
 * out `.`, `..`, and hidden folders, and they may only contain characters that are safe in
 * file paths and URLs on all operating systems.
 */
export const NamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The schema for application, group, test, and hardware names.
 */
export const NameSchema = z
  .string()
  .regex(
    NamePattern,
    'must start with a letter or digit, contain only letters, digits, ".", "_", and ' +
      '"-", and be at most 128 characters long'
  );

/**
 * Matches the timestamps that are accepted by the server: an ISO 8601 date, optionally
 * followed by a time (separated by `T` or a space) and a timezone.
 */
const TimestampPattern =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Parses a timestamp and returns it as a Date. All timestamps that do not name a timezone
 * are interpreted as UTC, which is the timezone in which the test results are stored.
 *
 * @param value The timestamp that should be parsed
 * @returns The parsed timestamp or `null` if the value is not a valid timestamp
 */
export function parseTimestamp(value: string): Date | null {
  const match = TimestampPattern.exec(value.trim());
  if (match == null) {
    return null;
  }

  const [, date, time, timezone] = match;
  if (time == null) {
    // A date-only value is always interpreted as midnight UTC
    const result = new Date(`${date}T00:00:00Z`);
    return isNaN(result.getTime()) ? null : result;
  }

  // JavaScript only guarantees to parse offsets in the form +HH:mm
  const zone = timezone
    ? timezone.toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
    : 'Z';
  const result = new Date(`${date}T${time}${zone}`);
  return isNaN(result.getTime()) ? null : result;
}

/**
 * A schema that accepts a timestamp string and turns it into a Date, see `parseTimestamp`.
 */
const TimestampSchema = z.string().transform((value, ctx) => {
  const date = parseTimestamp(value);
  if (date == null) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be an ISO 8601 timestamp, for example 2026-01-31T12:00:00Z'
    });
    return z.NEVER;
  }
  return date;
});

/**
 * The fields that identify a single test. The application is optional and defaults to
 * the `DefaultApplication`.
 */
const TestKeyShape = {
  application: NameSchema.default(DefaultApplication),
  group: NameSchema,
  name: NameSchema,
  hardware: NameSchema
};

/**
 * The body of the `/api/submit-test` call.
 */
export const SubmitTestSchema = z.object({
  ...TestKeyShape,
  runnerID: z.string().min(1),
  timestamp: TimestampSchema,
  timing: z.coerce.number().min(0),
  commitHash: z.string().regex(/^[0-9a-fA-F]{4,64}$/, 'must be a hexadecimal commit hash')
});

/**
 * The body of the `/api/run-test` call.
 */
export const RunTestSchema = z.object({
  ...TestKeyShape,
  runnerID: z.string().min(1)
});

/**
 * The body of the `/api/update-reference` call.
 */
export const UpdateReferenceSchema = z.object(TestKeyShape);

/**
 * The body of the `/api/update-diff-threshold` call.
 */
export const ThresholdSchema = z.object({
  threshold: z.number().min(0).max(1)
});

/**
 * The URL parameters of the `/api/result` calls.
 */
export const ResultParamsSchema = z.object({
  ...TestKeyShape,
  type: z.enum([
    'reference',
    'candidate',
    'difference',
    'reference-thumbnail',
    'candidate-thumbnail',
    'difference-thumbnail',
    'log'
  ]),
  timestamp: TimestampSchema.optional()
});

/**
 * The URL parameters of the `/api/compare` calls.
 */
export const CompareParamsSchema = z.object({
  application: NameSchema.default(DefaultApplication),
  group: NameSchema,
  name: NameSchema,
  hardware1: NameSchema,
  hardware2: NameSchema,
  type: z.enum(['reference', 'candidate'])
});

/**
 * The URL parameters of the `/api/test-history` call.
 */
export const HistoryParamsSchema = z.object({
  application: NameSchema,
  group: NameSchema,
  name: NameSchema,
  hardware: NameSchema
});

/**
 * Validates the `value` against the `schema` and returns the parsed value. If the value
 * is not valid, a ValidationError is thrown that describes all problems.
 *
 * @param schema The schema that the value has to follow
 * @param value The value that should be validated
 * @returns The parsed value
 */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const problems = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `'${issue.path.join('.')}' ${issue.message}` : issue.message
    );
    throw new ValidationError(`Invalid request: ${problems.join('; ')}`);
  }
  return result.data;
}
