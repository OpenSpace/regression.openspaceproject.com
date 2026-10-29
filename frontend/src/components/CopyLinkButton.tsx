import { useEffect, useState } from 'react';
import { ActionIcon, Tooltip } from '@mantine/core';

import { copyText } from '../utils';

interface Props {
  /// Returns the link that is copied when the button is clicked
  link: () => string;
  label: string;
  size?: 'xs' | 'sm' | 'md';
}

/**
 * The icon of a chain link
 */
function LinkIcon({ size }: { size: number }) {
  return (
    <svg
      xmlns={'http://www.w3.org/2000/svg'}
      width={size}
      height={size}
      viewBox={'0 0 24 24'}
      fill={'none'}
      stroke={'currentColor'}
      strokeWidth={2}
      strokeLinecap={'round'}
      strokeLinejoin={'round'}
      aria-hidden={'true'}
    >
      <path d={'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'} />
      <path d={'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'} />
    </svg>
  );
}

/**
 * A button that copies a link to the clipboard and confirms it in its tooltip.
 */
export function CopyLinkButton({ link, label, size = 'xs' }: Props) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    setStatus((await copyText(link())) ? 'copied' : 'failed');
  }

  const tooltip =
    status === 'copied'
      ? 'Copied!'
      : status === 'failed'
        ? 'Could not copy the link'
        : label;

  return (
    <Tooltip label={tooltip} withArrow opened={status !== 'idle' ? true : undefined}>
      <ActionIcon
        variant={'subtle'}
        size={size}
        onClick={copy}
        onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
        aria-label={label}
      >
        <LinkIcon size={size === 'xs' ? 14 : 16} />
      </ActionIcon>
    </Tooltip>
  );
}
