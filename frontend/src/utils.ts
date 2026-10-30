import { resultUrl } from './api';
import { SortColumn, SortDirection, TestData, TestKey, TestRecord } from './types';

export function timingDisplay(timing: number): string {
  return `${Math.round(timing * 1000) / 1000}s`;
}

export function pixelErrorDisplay(error: number): string {
  return `${Math.round(error * 100000) / 1000}%`;
}

/**
 * Returns the number of images of a test run.
 */
export function imageCount(data: TestData): number {
  return data.images?.length ?? 1;
}

/**
 * Returns the pixel error of the image with the 1-based number `image` of a test run.
 */
export function imageError(data: TestData, image: number): number {
  return data.images?.[image - 1]?.pixelError ?? data.pixelError;
}

/**
 * Returns the 1-based number of the image with the largest pixel error of a test run. If
 * multiple images have the same error, the one with the lowest number is returned.
 */
export function worstImage(data: TestData): number {
  let worst = 1;
  for (let image = 2; image <= imageCount(data); image++) {
    if (imageError(data, image) > imageError(data, worst)) {
      worst = image;
    }
  }
  return worst;
}

/**
 * Returns the URL of the commit `commitHash` in the `repository`, or `null` if the
 * repository is not known.
 */
export function commitUrl(repository: string | null, commitHash: string): string | null {
  return repository ? `${repository}/commit/${encodeURIComponent(commitHash)}` : null;
}

/**
 * Returns the URL to the GitHub "New Issue" page of the `repository` with the title and
 * body prefilled with the information about the test run `data` of `record`. The links in
 * the body have to be absolute as they are opened from GitHub. Returns `null` if the
 * repository is not known.
 */
export function githubIssueUrl(
  record: TestRecord,
  data: TestData,
  repository: string | null
): string | null {
  if (!repository) {
    return null;
  }

  const base = window.location.origin;
  const nImages = imageCount(data);
  const image = (type: string, n: number) =>
    `[![${type}](${base}${resultUrl(`${type}-thumbnail`, record, data.timeStamp, 0, n)})]` +
    `(${base}${resultUrl(type, record, data.timeStamp, 0, n)})`;
  const imageRows = Array.from({ length: nImages }, (_, i) => {
    const n = i + 1;
    const label =
      nImages > 1 ? `Image ${n} (${pixelErrorDisplay(imageError(data, n))}) | ` : '';
    return `| ${label}${image('candidate', n)} | ${image('reference', n)} | ${image('difference', n)} |`;
  });

  const title = `Failing image test: ${record.hardware}/${record.group}/${record.name}`;
  const body = [
    `**Test:** ${record.application} / ${record.group} / ${record.name}`,
    `**Hardware:** ${record.hardware}`,
    `**Run:** ${data.timeStamp} on commit [${data.commitHash.substring(0, 8)}](${commitUrl(repository, data.commitHash)})`,
    `**Pixel error:** ${pixelErrorDisplay(data.pixelError)}`,
    `**Log:** [${data.nErrors} errors](${base}${resultUrl('log', record, data.timeStamp)})`,
    '',
    nImages > 1
      ? '| Image | Candidate | Reference | Difference |'
      : '| Candidate | Reference | Difference |',
    nImages > 1 ? '|---|---|---|---|' : '|---|---|---|',
    ...imageRows
  ].join('\n');

  const params = new URLSearchParams({ title, body });
  return `${repository}/issues/new?${params.toString()}`;
}

/**
 * Returns the link to the main page that opens the history of the provided test.
 */
export function testLink(test: TestKey): string {
  const url = new URL('/', window.location.origin);
  url.searchParams.set('application', test.application);
  url.searchParams.set('group', test.group);
  url.searchParams.set('name', test.name);
  url.searchParams.set('hardware', test.hardware);
  return url.toString();
}

/**
 * Copies the `text` to the clipboard. The Clipboard API is only available in secure
 * contexts (HTTPS or localhost), so a hidden text field is used as a fallback.
 *
 * @returns `true` if the text was copied, `false` otherwise
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to the text field below
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

/**
 * Changes smaller than this are considered to be noise when classifying trends
 */
const TrendEpsilon = 1e-6;

export enum Trend {
  Stable,
  Improved,
  Worsened,
  Erratic
}

/**
 * Classifies how the `values` change over time. Changes smaller than `TrendEpsilon` are
 * ignored, so that floating point noise does not count as a change.
 *
 * @param values The values, sorted from oldest to newest
 * @returns The trend of the values
 */
export function classifyValues(values: number[]): Trend {
  if (values.length <= 1) return Trend.Stable;

  const diffs = values.slice(1).map((v, i) => v - values[i]!);
  const anyIncrease = diffs.some((d) => d > TrendEpsilon);
  const anyDecrease = diffs.some((d) => d < -TrendEpsilon);

  if (!anyIncrease && !anyDecrease) return Trend.Stable;
  if (anyIncrease && anyDecrease) return Trend.Erratic;
  if (anyDecrease) return Trend.Improved;
  return Trend.Worsened;
}

/**
 * Compares two values for sorting. Strings are compared alphabetically and numbers
 * numerically; equal values are reported as equal so that the sort is consistent.
 */
function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

export function sortRecords(
  records: TestRecord[],
  column: SortColumn,
  direction: SortDirection = 'asc'
): TestRecord[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    if (
      column === 'application' ||
      column === 'group' ||
      column === 'name' ||
      column === 'hardware'
    ) {
      return compareValues(a[column], b[column]) * sign;
    }
    const aData = a.data[a.data.length - 1];
    const bData = b.data[b.data.length - 1];
    if (!aData || !bData) return 0;
    if (column === 'timeStamp') {
      const aTime = new Date(aData.timeStamp).getTime();
      const bTime = new Date(bData.timeStamp).getTime();
      return compareValues(aTime, bTime) * sign;
    }
    return compareValues(aData[column], bData[column]) * sign;
  });
}
