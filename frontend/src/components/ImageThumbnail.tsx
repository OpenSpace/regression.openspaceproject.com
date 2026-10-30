import { Anchor, Badge } from '@mantine/core';

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
  /// The 1-based number of the image of the test run
  image?: number;
  /// A text that is shown in the corner of the image
  badge?: string;
}

export function ImageThumbnail({
  type,
  test,
  timestamp,
  revision = 0,
  stopPropagation = false,
  width,
  image = 1,
  badge
}: Props) {
  return (
    <Anchor
      href={resultUrl(type, test, timestamp, revision, image)}
      target={'_blank'}
      style={badge ? { display: 'block', position: 'relative' } : undefined}
      onClick={stopPropagation ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
      onKeyDown={
        stopPropagation ? (e: React.KeyboardEvent) => e.stopPropagation() : undefined
      }
    >
      <img
        src={resultUrl(`${type}-thumbnail`, test, timestamp, revision, image)}
        style={{ width, height: 'auto', display: 'block' }}
        loading={'lazy'}
        alt={`${type} image${image > 1 ? ` ${image}` : ''} of ${test.group}/${test.name} on ${test.hardware}`}
      />
      {badge && (
        <Badge size={'xs'} style={{ position: 'absolute', top: 4, left: 4 }}>
          {badge}
        </Badge>
      )}
    </Anchor>
  );
}
