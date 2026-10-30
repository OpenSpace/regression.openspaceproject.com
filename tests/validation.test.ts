import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/errors';
import {
  NameSchema,
  parse,
  parseResultType,
  parseTimestamp,
  SubmitTestSchema
} from '../src/validation';

describe('NameSchema', () => {
  it.each(['openspace', 'windows-nvidia', 'apollo_8', 'v1.2', 'A1'])(
    'accepts %s',
    (name) => {
      expect(NameSchema.safeParse(name).success).toBe(true);
    }
  );

  it.each([
    '',
    '.',
    '..',
    '../x',
    'a/b',
    'a\\b',
    '.hidden',
    '-dash',
    'with space',
    'line\nbreak',
    'nul\0',
    'x'.repeat(129)
  ])('rejects %j', (name) => {
    expect(NameSchema.safeParse(name).success).toBe(false);
  });
});

describe('parseTimestamp', () => {
  it('treats timestamps without a timezone as UTC', () => {
    expect(parseTimestamp('2026-06-11T12:00:00')?.toISOString()).toBe(
      '2026-06-11T12:00:00.000Z'
    );
    expect(parseTimestamp('2026-06-11 12:00')?.toISOString()).toBe(
      '2026-06-11T12:00:00.000Z'
    );
    expect(parseTimestamp('2026-06-11')?.toISOString()).toBe('2026-06-11T00:00:00.000Z');
  });

  it('respects explicit timezones', () => {
    expect(parseTimestamp('2026-06-11T12:00:00Z')?.toISOString()).toBe(
      '2026-06-11T12:00:00.000Z'
    );
    expect(parseTimestamp('2026-06-11T12:00:00+02:00')?.toISOString()).toBe(
      '2026-06-11T10:00:00.000Z'
    );
    expect(parseTimestamp('2026-06-11T12:00:00.123456-0130')?.toISOString()).toBe(
      '2026-06-11T13:30:00.123Z'
    );
  });

  it.each([
    '',
    'yesterday',
    'June 11 2026',
    '2026-13-45',
    '2026-06-11T25:00:00',
    '1718100000'
  ])('rejects %j', (value) => {
    expect(parseTimestamp(value)).toBeNull();
  });
});

describe('parseResultType', () => {
  it('uses the first image if no number is provided', () => {
    expect(parseResultType('candidate')).toEqual({
      kind: 'candidate',
      image: 1,
      thumbnail: false
    });
    expect(parseResultType('reference-thumbnail')).toEqual({
      kind: 'reference',
      image: 1,
      thumbnail: true
    });
    expect(parseResultType('log')).toEqual({ kind: 'log' });
  });

  it('parses the number of the image', () => {
    expect(parseResultType('candidate-1')).toEqual({
      kind: 'candidate',
      image: 1,
      thumbnail: false
    });
    expect(parseResultType('difference-2-thumbnail')).toEqual({
      kind: 'difference',
      image: 2,
      thumbnail: true
    });
  });

  it.each([
    '',
    'invalid',
    'candidate-0',
    'candidate-02',
    'candidate-',
    'candidate-x',
    'candidate-thumbnail-2',
    'log-2',
    'log-thumbnail'
  ])('rejects %j', (value) => {
    expect(parseResultType(value)).toBeNull();
  });
});

describe('parse', () => {
  const valid = {
    runnerID: 'runner',
    hardware: 'windows-nvidia',
    group: 'apollo',
    name: 'earthrise',
    timestamp: '2026-01-01T00:00:00Z',
    timing: '1.5',
    commitHash: 'abcdef1'
  };

  it('returns the parsed values and applies defaults', () => {
    const result = parse(SubmitTestSchema, valid);
    expect(result.application).toBe('openspace');
    expect(result.timing).toBe(1.5);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('throws a ValidationError that names the invalid fields', () => {
    expect(() => parse(SubmitTestSchema, { ...valid, hardware: '../x' })).toThrow(
      ValidationError
    );
    expect(() => parse(SubmitTestSchema, { ...valid, hardware: '../x' })).toThrow(
      /hardware/
    );
  });

  it('rejects fields that were sent more than once', () => {
    expect(() => parse(SubmitTestSchema, { ...valid, group: ['a', 'b'] })).toThrow(
      ValidationError
    );
  });

  it('treats a missing body like an empty one', () => {
    expect(() => parse(SubmitTestSchema, undefined)).toThrow(/runnerID/);
  });
});
