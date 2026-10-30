import { describe, expect, it } from 'vitest';

import { compareUrl, resultUrl } from '../frontend/src/api';
import { TestData, TestRecord } from '../frontend/src/types';
import {
  classifyValues,
  imageCount,
  imageError,
  sortRecords,
  Trend,
  worstImage
} from '../frontend/src/utils';

function record(name: string, pixelError: number, timeStamp: string): TestRecord {
  const data: TestData = {
    pixelError,
    timing: 1,
    commitHash: 'abc',
    timeStamp,
    nErrors: 0
  };
  return { application: 'openspace', group: 'group', name, hardware: 'hw', data: [data] };
}

describe('sortRecords', () => {
  const records = [
    record('b', 0.5, '2026-01-02T00:00:00Z'),
    record('a', 0.1, '2026-01-03T00:00:00Z'),
    record('c', 0.5, '2026-01-01T00:00:00Z'),
    record('a', 0.1, '2026-01-04T00:00:00Z')
  ];

  it('sorts strings alphabetically in both directions', () => {
    expect(sortRecords(records, 'name', 'asc').map((r) => r.name)).toEqual([
      'a',
      'a',
      'b',
      'c'
    ]);
    expect(sortRecords(records, 'name', 'desc').map((r) => r.name)).toEqual([
      'c',
      'b',
      'a',
      'a'
    ]);
  });

  it('sorts numbers numerically and keeps equal values in their original order', () => {
    expect(sortRecords(records, 'pixelError', 'asc').map((r) => r.name)).toEqual([
      'a',
      'a',
      'b',
      'c'
    ]);
  });

  it('sorts by timestamp', () => {
    expect(
      sortRecords(records, 'timeStamp', 'asc').map((r) =>
        r.data[0]!.timeStamp.slice(0, 10)
      )
    ).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  });

  it('does not change the input', () => {
    const copy = [...records];
    sortRecords(records, 'name');
    expect(records).toEqual(copy);
  });
});

describe('multiple images', () => {
  const test = { application: 'app', group: 'g', name: 'n', hardware: 'hw' };
  const single = record('a', 0.5, '2026-01-01T00:00:00Z').data[0]!;

  it('only adds the number of the image to the URLs of later images', () => {
    expect(resultUrl('candidate', test)).toBe('/api/result/candidate/app/g/n/hw');
    expect(resultUrl('candidate', test, undefined, 0, 1)).toBe(
      '/api/result/candidate/app/g/n/hw'
    );
    expect(resultUrl('candidate', test, undefined, 0, 2)).toBe(
      '/api/result/candidate-2/app/g/n/hw'
    );
    expect(resultUrl('difference-thumbnail', test, 'time', 3, 2)).toBe(
      '/api/result/difference-2-thumbnail/app/g/n/hw/time?revision=3'
    );
    expect(compareUrl('reference', 'app', 'g', 'n', 'a', 'b')).toBe(
      '/api/compare/reference/app/g/n/a/b'
    );
    expect(compareUrl('reference', 'app', 'g', 'n', 'a', 'b', 2)).toBe(
      '/api/compare/reference-2/app/g/n/a/b'
    );
  });

  it('handles test runs without per-image values', () => {
    expect(imageCount(single)).toBe(1);
    expect(imageError(single, 1)).toBe(0.5);
    expect(worstImage(single)).toBe(1);
  });

  it('finds the image with the largest error and prefers lower numbers', () => {
    const data = (...errors: number[]) => ({
      ...single,
      images: errors.map((pixelError) => ({ pixelError }))
    });
    expect(imageCount(data(0, 0.1))).toBe(2);
    expect(imageError(data(0, 0.1), 2)).toBe(0.1);
    expect(worstImage(data(0, 0.1))).toBe(2);
    expect(worstImage(data(0.1, 0))).toBe(1);
    expect(worstImage(data(0.1, 0.1))).toBe(1);
    expect(worstImage(data(0, 0))).toBe(1);
  });
});

describe('classifyValues', () => {
  it('classifies the trend of the values', () => {
    expect(classifyValues([])).toBe(Trend.Stable);
    expect(classifyValues([0.1])).toBe(Trend.Stable);
    expect(classifyValues([0.1, 0.1, 0.1])).toBe(Trend.Stable);
    expect(classifyValues([0.3, 0.2, 0.1])).toBe(Trend.Improved);
    expect(classifyValues([0.1, 0.2, 0.2])).toBe(Trend.Worsened);
    expect(classifyValues([0.1, 0.3, 0.2])).toBe(Trend.Erratic);
  });

  it('ignores floating point noise', () => {
    expect(classifyValues([0.1, 0.1 + 1e-9, 0.1 - 1e-9])).toBe(Trend.Stable);
  });
});
