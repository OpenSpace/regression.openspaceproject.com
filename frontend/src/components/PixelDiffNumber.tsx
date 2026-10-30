import { Box, Text } from '@mantine/core';

import { pixelErrorDisplay } from '../utils';

export function PixelDiffNumber({ value }: { value: number }) {
  const style = diffStyle(value);

  function diffStyle(diff: number): { backgroundColor: string; color: string } {
    if (diff === 0.0) return { backgroundColor: '#eeeeee', color: '#111111' };
    else if (diff < 0.001) return { backgroundColor: '#4ce600', color: '#111111' };
    else if (diff < 0.01) return { backgroundColor: '#55cc00', color: '#111111' };
    else if (diff < 0.05) return { backgroundColor: '#66cc00', color: '#111111' };
    else if (diff < 0.1) return { backgroundColor: '#ede621', color: '#111111' };
    else if (diff < 0.25) return { backgroundColor: '#edc421', color: '#111111' };
    else if (diff < 0.5) return { backgroundColor: '#cc5000', color: '#ffffff' };
    else if (diff < 0.75) return { backgroundColor: '#cc4400', color: '#ffffff' };
    else if (diff < 1.0) return { backgroundColor: '#cc2200', color: '#ffffff' };
    else return { backgroundColor: '#cc0000', color: '#ffffff' };
  }

  return (
    <Box px={4} py={2} style={{ borderRadius: 4, display: 'inline-block', ...style }}>
      <Text size={'sm'}>{pixelErrorDisplay(value)}</Text>
    </Box>
  );
}
