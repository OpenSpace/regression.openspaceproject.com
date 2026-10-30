import { Anchor, Box, Table, Text, Tooltip } from '@mantine/core';

import { TestData, TestRecord } from '../types';
import {
  classifyValues,
  commitUrl,
  imageCount,
  imageError,
  pixelErrorDisplay,
  testLink,
  timingDisplay,
  Trend,
  worstImage
} from '../utils';

import { CopyLinkButton } from './CopyLinkButton';
import { ImageThumbnail } from './ImageThumbnail';
import { PixelDiffNumber } from './PixelDiffNumber';

interface Props {
  record: TestRecord;
  /// The repository that the commit hashes of the record's application refer to
  repository: string | null;
  /// Increased whenever the images might have changed on the server
  revision: number;
  onOpen: (record: TestRecord) => void;
}

/**
 * The number of most recent test runs that are used to determine the trends
 */
const TrendLength = 5;

/**
 * Returns the color, text, and tooltip describing the pixel error of the last test runs.
 */
function errorTrend(data: TestData[]): [string, string, string] {
  const runs = `the last ${data.length} test runs`;
  switch (classifyValues(data.map((d) => d.pixelError))) {
    case Trend.Improved:
      return ['green', '↓ Improved', `Pixel error of ${runs} has improved`];
    case Trend.Worsened:
      return ['red', '↑ Worsened', `Pixel error of ${runs} has gotten worse`];
    case Trend.Erratic:
      return ['yellow', '~ Erratic', `Pixel error of ${runs} is going up and down`];
    case Trend.Stable:
    default:
      return ['dimmed', '● Stable', `Pixel error of ${runs} is unchanged`];
  }
}

/**
 * Returns the color, text, and tooltip describing the number of log errors of the last
 * test runs.
 */
function logTrend(data: TestData[]): [string, string, string] {
  const latest = data[data.length - 1]?.nErrors ?? 0;
  if (latest === 0) {
    return ['dimmed', 'No errors', 'No errors in the log of the latest test run'];
  }

  const errors = latest === 1 ? '1 error' : `${latest} errors`;
  const runs = `the last ${data.length} test runs`;
  switch (classifyValues(data.map((d) => d.nErrors))) {
    case Trend.Improved:
      return ['yellow', `↓ ${errors}`, `The number of log errors decreased over ${runs}`];
    case Trend.Worsened:
      return ['red', `↑ ${errors}`, `The number of log errors increased over ${runs}`];
    case Trend.Erratic:
      return ['red', `~ ${errors}`, `The number of log errors changed over ${runs}`];
    case Trend.Stable:
    default:
      return [
        'orange',
        `● ${errors}`,
        `The number of log errors is unchanged over ${runs}`
      ];
  }
}

export function TestRow({ record, repository, revision, onOpen }: Props) {
  const latestData = record.data[record.data.length - 1];
  if (!latestData) return null;

  const ImageWidth = 250;

  const lastValues = record.data.slice(-TrendLength);
  const [diffColor, diffText, diffTooltip] = errorTrend(lastValues);
  const [nErrorsColor, nErrorsText, nErrorsTooltip] = logTrend(lastValues);
  const commit = commitUrl(repository, latestData.commitHash);
  const label = `${record.application} / ${record.group} / ${record.name} on ${record.hardware}`;

  // Tests with multiple images only show the image that needs the most attention
  const nImages = imageCount(latestData);
  const shownImage = worstImage(latestData);
  const errors = Array.from({ length: nImages }, (_, i) => (
    <div key={i}>
      Image {i + 1}: {pixelErrorDisplay(imageError(latestData, i + 1))}
    </div>
  ));

  return (
    <Table.Tr
      style={{ cursor: 'pointer' }}
      tabIndex={0}
      aria-label={`Show the history of ${label}`}
      onClick={() => onOpen(record)}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(record);
        }
      }}
    >
      <Table.Td style={{ width: 75, maxWidth: 75, whiteSpace: 'nowrap' }}>
        {nImages > 1 ? (
          <Tooltip label={errors} withArrow>
            <Box w={'fit-content'}>
              <PixelDiffNumber value={latestData.pixelError} />
            </Box>
          </Tooltip>
        ) : (
          <PixelDiffNumber value={latestData.pixelError} />
        )}
        <Tooltip label={diffTooltip} withArrow>
          <Text size={'xs'} c={diffColor}>
            {diffText}
          </Text>
        </Tooltip>
        <Tooltip label={nErrorsTooltip} withArrow>
          <Text size={'xs'} c={nErrorsColor}>
            {nErrorsText}
          </Text>
        </Tooltip>
      </Table.Td>
      <Table.Td style={{ width: 100, maxWidth: 100, wordBreak: 'break-word' }}>
        {record.application}
      </Table.Td>
      <Table.Td style={{ width: 200, maxWidth: 200, wordBreak: 'break-word' }}>
        {record.group}
      </Table.Td>
      <Table.Td style={{ width: 200, maxWidth: 200, wordBreak: 'break-word' }}>
        {record.name}
      </Table.Td>
      <Table.Td style={{ width: 100, maxWidth: 100, wordBreak: 'break-word' }}>
        {record.hardware}
      </Table.Td>
      <Table.Td style={{ width: 100, maxWidth: 100, wordBreak: 'break-word' }}>
        {timingDisplay(latestData.timing)}
      </Table.Td>
      <Table.Td style={{ width: 100, maxWidth: 100, wordBreak: 'break-word' }}>
        {commit ? (
          <Anchor
            href={commit}
            target={'_blank'}
            rel={'noopener noreferrer'}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
          >
            {latestData.commitHash.substring(0, 8)}
          </Anchor>
        ) : (
          <Text>{latestData.commitHash.substring(0, 8)}</Text>
        )}
      </Table.Td>
      <Table.Td style={{ width: 100, maxWidth: 100, wordBreak: 'break-word' }}>
        <Text>
          {new Date(latestData.timeStamp).toISOString().split('T')[0]}
          <br />
          {new Date(latestData.timeStamp).toISOString().split('T')[1]?.replace('Z', '')}
        </Text>
      </Table.Td>
      <Table.Td style={{ width: 50, maxWidth: 50, wordBreak: 'break-word' }}>
        <CopyLinkButton link={() => testLink(record)} label={`Copy link to ${label}`} />
      </Table.Td>
      {['candidate', 'reference', 'difference'].map((type) => (
        <Table.Td key={type} style={{ width: ImageWidth }}>
          <ImageThumbnail
            type={type}
            test={record}
            timestamp={latestData.timeStamp}
            revision={revision}
            stopPropagation
            width={ImageWidth}
            image={shownImage}
            {...(nImages > 1 ? { badge: `${shownImage}/${nImages}` } : {})}
          />
        </Table.Td>
      ))}
    </Table.Tr>
  );
}
