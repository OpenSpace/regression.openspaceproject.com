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
 * The largest number of images that a single test run may have.
 */
export const MaxImagesPerTest = 8;

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
  runnerID: z.string().min(1),
  image: z.coerce.number().int().min(1).max(MaxImagesPerTest).default(1)
});

/**
 * The body of the `/api/update-reference` call.
 */
export const UpdateReferenceSchema = z.object(TestKeyShape);

/**
 * The body of the `/api/rerun-test` call. If no `commit` is provided, the latest commit
 * of the application is built.
 */
export const RerunTestSchema = z.object({
  ...TestKeyShape,
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, 'must be a lowercase hexadecimal commit hash')
    .optional()
});

/**
 * The body of the `/api/update-diff-threshold` call.
 */
export const ThresholdSchema = z.object({
  threshold: z.number().min(0).max(1)
});

/**
 * The kinds of images that are stored for each image of a test
 */
export type ImageKind = 'reference' | 'candidate' | 'difference';

/**
 * The result that is requested through the `/api/result` calls. Each test run has a single
 * log, but one set of images for each of its images.
 */
export type ResultType =
  { kind: 'log' } | { kind: ImageKind; image: number; thumbnail: boolean };

/**
 * Parses the type of a result. The number of the image is optional and defaults to the
 * first image, for example "candidate", "candidate-2", or "candidate-2-thumbnail".
 *
 * @param value The type that should be parsed
 * @returns The parsed type or `null` if the value is not a valid type
 */
export function parseResultType(value: string): ResultType | null {
  if (value == 'log') {
    return { kind: 'log' };
  }

  const match = /^(reference|candidate|difference)(?:-([1-9]\d*))?(-thumbnail)?$/.exec(
    value
  );
  if (match == null) {
    return null;
  }
  return {
    kind: match[1] as ImageKind,
    image: Number(match[2] ?? 1),
    thumbnail: match[3] != null
  };
}

/**
 * The URL parameters of the `/api/result` calls.
 */
export const ResultParamsSchema = z.object({
  ...TestKeyShape,
  type: z.string().transform((value, ctx) => {
    const type = parseResultType(value);
    if (type == null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be "log" or one of "reference", "candidate", or "difference", optionally ' +
          'followed by the number of the image and "-thumbnail"'
      });
      return z.NEVER;
    }
    return type;
  }),
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
  type: z.string().transform((value, ctx) => {
    const match = /^(reference|candidate)(?:-([1-9]\d*))?$/.exec(value);
    if (match == null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be "reference" or "candidate", optionally followed by the number of the image'
      });
      return z.NEVER;
    }
    return { kind: match[1] as 'reference' | 'candidate', image: Number(match[2] ?? 1) };
  })
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
