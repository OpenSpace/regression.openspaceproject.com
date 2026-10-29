import { Anchor } from '@mantine/core';

import { resultUrl } from '../api';
import { TestKey } from '../types';

interface Props {
  type: string;
  test: TestKey;
  timestamp?: string;
  /// Increased whenever the images might have changed on the server
  revision?: number;
  stopPropagation?: boolean;
  width: number;
}

export function ImageThumbnail({
  type,
  test,
  timestamp,
  revision = 0,
  stopPropagation = false,
  width
}: Props) {
  return (
    <Anchor
      href={resultUrl(type, test, timestamp, revision)}
      target={'_blank'}
      onClick={stopPropagation ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
      onKeyDown={
        stopPropagation ? (e: React.KeyboardEvent) => e.stopPropagation() : undefined
      }
    >
      <img
        src={resultUrl(`${type}-thumbnail`, test, timestamp, revision)}
        style={{ width, height: 'auto', display: 'block' }}
        loading={'lazy'}
        alt={`${type} image of ${test.group}/${test.name} on ${test.hardware}`}
      />
    </Anchor>
  );
}
