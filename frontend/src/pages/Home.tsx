import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  ActionIcon,
  Anchor,
  Box,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  ScrollArea,
  Select,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core';

import { SortableHeader } from '../components/SortableHeader';
import { TestHistory } from '../components/TestHistory';
import { TestRow } from '../components/TestRow';
import { SortColumn, SortDirection, TestRecord } from '../types';
import { sortRecords } from '../utils';

export default function Home() {
  const [records, setRecords] = useState<TestRecord[]>([]);
  const [allHardware, setAllHardware] = useState<string[]>([]);
  const [selectedHardware, setSelectedHardware] = useState<Set<string>>(new Set());
  const [adminToken, setAdminToken] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<TestRecord | null>(null);
  const [sortCol, setSortCol] = useState<SortColumn>('pixelError');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  const [groupFilter, setGroupFilter] = useState('');
  const [nameFilter, setNameFilter] = useState('');

  const [searchParams] = useSearchParams();
  const initialLinkHandled = useRef(false);

  // Auto-open modal when URL contains group/name/hardware params
  useEffect(() => {
    if (initialLinkHandled.current || records.length === 0) return;
    initialLinkHandled.current = true;
    const group = searchParams.get('group');
    const name = searchParams.get('name');
    const hardware = searchParams.get('hardware');
    if (group && name && hardware) {
      const found = records.find(
        (r) => r.group === group && r.name === name && r.hardware === hardware
      );
      if (found) setSelectedRecord(found);
    }
  }, [records]);

  useEffect(() => {
    Promise.all([
      fetch('/api/config').then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ preferredHardware: string[] }>;
      }),
      fetch('/api/test-records').then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<TestRecord[]>;
      })
    ])
      .then(([config, data]) => {
        const hardwares = [...new Set(data.map((r) => r.hardware))].sort();
        setAllHardware(hardwares);
        const urlHardware = searchParams.getAll('hardware').filter((hw) => hardwares.includes(hw));
        setSelectedHardware(
          new Set(
            urlHardware.length > 0
              ? urlHardware
              : config.preferredHardware.length > 0
                ? hardwares.filter((hw) => config.preferredHardware.includes(hw))
                : hardwares
          )
        );
        setRecords(data);
      })
      .catch((err) => {
        console.error('Failed to load data:', err);
      });
  }, []);

  function handleSort(column: SortColumn) {
    setSortDir((prev) =>
      column === sortCol ? (prev === 'asc' ? 'desc' : 'asc') : 'asc'
    );
    setSortCol(column);
  }

  function toggleHardware(hw: string) {
    setSelectedHardware((prev) => {
      const next = new Set(prev);
      if (next.has(hw)) {
        next.delete(hw);
      } else {
        next.add(hw);
      }
      return next;
    });
  }

  async function updateReference(record: TestRecord) {
    const response = await fetch('/api/update-reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminToken,
        group: record.group,
        name: record.name,
        hardware: record.hardware
      })
    }).catch((err) => {
      console.error('Failed to update reference:', err);
      alert('Network error: could not update reference image');
      return null;
    });
    if (!response) return;
    if (response.ok) {
      alert('Successfully updated reference image');
    } else {
      alert(
        `Error updating reference\n${response.status}\nError: ${response.statusText}`
      );
    }
  }

  const visibleRecords = useMemo(
    () =>
      sortRecords(records, sortCol, sortDir).filter((r) => {
        if (!selectedHardware.has(r.hardware)) return false;
        if (groupFilter && !r.group.toLowerCase().includes(groupFilter.toLowerCase()))
          return false;
        if (nameFilter && !r.name.toLowerCase().includes(nameFilter.toLowerCase()))
          return false;
        return true;
      }),
    [records, sortCol, sortDir, selectedHardware, groupFilter, nameFilter]
  );

  return (
    <Box style={{ fontFamily: 'Roboto, sans-serif' }}>
      {/* Header */}
      <Box
        py={'xl'}
        style={{ textAlign: 'center', backgroundColor: '#1a1a1a', borderBottom: '1px solid #333' }}
      >
        <Title
          order={1}
          style={{ fontVariant: 'small-caps', color: '#ffffff', marginBottom: '1rem' }}
        >
          <Link to={'/'} style={{ textDecoration: 'none', color: '#ffffff' }}>
            OpenSpace Image Testing
          </Link>
        </Title>
        <Text c="dimmed" style={{ fontSize: '0.9rem' }}>
          Visual Testing Dashboard
        </Text>
      </Box>

      {/* Controls */}
      <Group
        p={'md'}
        align={'flex-start'}
        justify={'space-between'}
        style={{ backgroundColor: '#252525', borderBottom: '1px solid #333' }}
      >
        <Group gap={'sm'} align={'center'} wrap={'wrap'}>
          <Text fw={600} style={{ color: '#e0e0e0' }}>Hardware:</Text>
          <Select
            size={'xs'}
            w={200}
            data={[
              { value: 'all', label: 'All' },
              ...allHardware.map((hw) => ({ value: hw, label: hw }))
            ]}
            defaultValue={'all'}
            onChange={(val) => {
              if (val === 'all') setSelectedHardware(new Set(allHardware));
              else if (val) setSelectedHardware(new Set([val]));
            }}
          />
          {allHardware.map((hw) => (
            <Checkbox
              key={hw}
              label={hw}
              checked={selectedHardware.has(hw)}
              onChange={() => toggleHardware(hw)}
            />
          ))}
          <Anchor component={Link} to={'/compare'} size={'sm'}>
            Hardware Compare
          </Anchor>
        </Group>
        <Group gap={'xs'}>
          <Text fw={600} style={{ color: '#e0e0e0' }}>Admin:</Text>
          <PasswordInput
            size={'xs'}
            w={180}
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
        </Group>
      </Group>

      {/* Test records table */}
      <ScrollArea
        offsetScrollbars
        style={{ maxHeight: 'calc(100vh - 250px)', overflowX: 'auto' }}
      >
        <Table
          horizontalSpacing={'xs'}
          verticalSpacing={4}
          withTableBorder
          withColumnBorders
          style={{ minWidth: '1200px' }}
        >
        <Table.Thead>
          <Table.Tr>
            <SortableHeader
              sortKey={'pixelError'}
              label={'Error'}
              onSort={handleSort}
              activeColumn={sortCol}
              direction={sortDir}
            />
            <SortableHeader
              sortKey={'group'}
              label={'Group'}
              onSort={handleSort}
              activeColumn={sortCol}
              direction={sortDir}
              w={160}
              filter={
                <TextInput
                  placeholder="Filter..."
                  onChange={(e) => setGroupFilter(e.target.value)}
                  rightSection={
                    groupFilter && (
                      <ActionIcon onClick={() => setGroupFilter('')} size={'xs'}>
                        <Text size={'xs'}>×</Text>
                      </ActionIcon>
                    )
                  }
                />
              }
            />
            <SortableHeader
              sortKey={'name'}
              label={'Name'}
              onSort={handleSort}
              activeColumn={sortCol}
              direction={sortDir}
              w={160}
              filter={
                <TextInput
                  placeholder="Filter..."
                  value={nameFilter}
                  onChange={(e) => setNameFilter(e.target.value)}
                  rightSection={
                    nameFilter && (
                      <ActionIcon onClick={() => setNameFilter('')} size={'xs'}>
                        <Text size={'xs'}>x</Text>
                      </ActionIcon>
                    )
                  }
                />
              }
            />
            <SortableHeader
              sortKey={'hardware'}
              label={'Hardware'}
              onSort={handleSort}
              activeColumn={sortCol}
              direction={sortDir}
            />
            <SortableHeader
              sortKey={'timing'}
              label={'Timing'}
              onSort={handleSort}
              activeColumn={sortCol}
              direction={sortDir}
            />
            <SortableHeader
              sortKey={'commitHash'}
              label={'Commit'}
              onSort={handleSort}
              activeColumn={sortCol}
              direction={sortDir}
            />
            <SortableHeader
              sortKey={'timeStamp'}
              label={'Timestamp'}
              onSort={handleSort}
              activeColumn={sortCol}
              direction={sortDir}
            />
            <Table.Th>Link</Table.Th>
            <Table.Th>Candidate</Table.Th>
            <Table.Th>Reference</Table.Th>
            <Table.Th>Difference</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {visibleRecords.map((record) => (
            <TestRow
              key={`${record.group}-${record.name}-${record.hardware}`}
              onOpen={setSelectedRecord}
              record={record}
            />
          ))}
        </Table.Tbody>
      </Table>
      </ScrollArea>

      <Modal
        opened={selectedRecord !== null}
        onClose={() => setSelectedRecord(null)}
        title={
          selectedRecord ? (
            <Group gap={'xs'} align={'center'}>
              <Text>{`${selectedRecord.group} / ${selectedRecord.name} — ${selectedRecord.hardware}`}</Text>
              <Tooltip label={'Copy link'} withArrow>
                <ActionIcon
                  variant={'subtle'}
                  size={'sm'}
                  onClick={() => {
                    const url = new URL(window.location.href);
                    url.search = '';
                    url.searchParams.set('group', selectedRecord.group);
                    url.searchParams.set('name', selectedRecord.name);
                    url.searchParams.set('hardware', selectedRecord.hardware);
                    navigator.clipboard.writeText(url.toString());
                  }}
                  aria-label={'Copy link to this test'}
                >
                  🔗
                </ActionIcon>
              </Tooltip>
            </Group>
          ) : ''
        }
        size={'auto'}
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {selectedRecord && (
          <TestHistory record={selectedRecord} onUpdateReference={updateReference} />
        )}
      </Modal>
    </Box>
  );
}
