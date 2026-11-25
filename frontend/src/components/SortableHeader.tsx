import { Stack, Table, UnstyledButton } from '@mantine/core';

import { type SortColumn, type SortDirection } from '../types';

interface Props {
  sortKey: SortColumn;
  label: string;
  onSort: (col: SortColumn) => void;
  filter?: React.ReactNode;
  activeColumn?: SortColumn;
  direction?: SortDirection;
  w?: number | string;
}

export function SortableHeader({
  sortKey,
  label,
  onSort,
  filter,
  activeColumn,
  direction,
  w
}: Props) {
  const isActive = activeColumn === sortKey;
  const indicator = isActive ? (direction === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <Table.Th style={w !== undefined ? { width: w, maxWidth: w } : undefined}>
      <Stack gap={0}>
        <UnstyledButton
          style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
          onClick={() => onSort(sortKey)}
        >
          {label}
          {indicator}
        </UnstyledButton>
        {filter}
      </Stack>
    </Table.Th>
  );
}
