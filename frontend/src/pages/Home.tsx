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
  Tooltip,
  Card,
  SimpleGrid
} from '@mantine/core';

import { SearchBar } from '../components/SearchBar';
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
  const [globalSearch, setGlobalSearch] = useState('');

  const [searchParams] = useSearchParams();
  const initialLinkHandled = useRef(false);

  // Calculate metrics from records
  const metrics = useMemo(() => {
    if (records.length === 0) {
      return {
        totalTests: 0,
        recentPassRate: 0,
        avgTiming: 0,
        hardwareCount: 0
      };
    }

    const totalTests = records.length;
    const recentPasses = records.filter((r) => r.data.length > 0 && r.data[r.data.length - 1].pixelError < 0.01).length;
    const recentPassRate = totalTests > 0 ? ((recentPasses / totalTests) * 100).toFixed(1) : '0.0';
    
    const totalTiming = records.reduce((sum, r) => sum + (r.data[r.data.length - 1]?.timing || 0), 0);
    const avgTiming = totalTests > 0 ? (totalTiming / totalTests).toFixed(2) : '0.0';

    return {
      totalTests,
      recentPassRate: parseFloat(recentPassRate),
      avgTiming: parseFloat(avgTiming),
      hardwareCount: new Set(records.map((r) => r.hardware)).size
    };
  }, [records]);

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
        if (globalSearch) {
          const searchLower = globalSearch.toLowerCase();
          return (
            r.group.toLowerCase().includes(searchLower) ||
            r.name.toLowerCase().includes(searchLower) ||
            r.hardware.toLowerCase().includes(searchLower)
          );
        }
        return true;
      }),
    [records, sortCol, sortDir, selectedHardware, groupFilter, nameFilter, globalSearch]
  );

  return (
    <Box>
      {/* Header */}
      <Box
        py={'md'}
        style={{ textAlign: 'center', backgroundColor: 'var(--mantine-color-dark-7)' }}
      >
        <Title
          order={1}
          style={{ fontVariant: 'small-caps', fontFamily: 'Roboto, sans-serif' }}
        >
          <Link to={'/'} style={{ textDecoration: 'none', color: 'white' }}>
            OpenSpace Image Testing
          </Link>
        </Title>
      </Box>

      {/* Metrics */}\n      {records.length > 0 && (
        <Box p={'sm'} style={{ backgroundColor: 'var(--mantine-color-dark-5)' }}>
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
            <Card>
              <Text size="xs" c="dimmed">Total Tests</Text>
              <Text size="xl" fw={700}>{metrics.totalTests}</Text>
            </Card>
            <Card>
              <Text size="xs" c="dimmed">Recent Pass Rate</Text>
              <Text size="xl" fw={700} c={metrics.recentPassRate >= 90 ? 'green' : 'yellow'}>{metrics.recentPassRate}%</Text>
            </Card>
            <Card>
              <Text size="xs" c="dimmed">Avg Timing (ms)</Text>
              <Text size="xl" fw={700}>{metrics.avgTiming}</Text>
            </Card>
            <Card>
              <Text size="xs" c="dimmed">Hardware Count</Text>
              <Text size="xl" fw={700}>{metrics.hardwareCount}</Text>
            </Card>
          </SimpleGrid>
        </Box>
      )}

      {/* Controls */}
      <Group
        p={'sm'}
        align={'flex-start'}
        justify={'space-between'}
        style={{ backgroundColor: 'var(--mantine-color-dark-6)' }}
      >
        <Group gap={'sm'} align={'center'} wrap={'wrap'}>
          <Text fw={600}>Hardware:</Text>
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
          <Text fw={600}>Search:</Text>
          <SearchBar
            value={globalSearch}
            onChange={(e) => setGlobalSearch(e.target.value)}
            placeholder="Search group, name, or hardware..."
            size="xs"
            w={300}
          />
        </Group>
        <Group gap={'xs'}>
          <Text fw={600}>Admin:</Text>
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
      <ScrollArea style={{ overflowX: 'auto' }}>
        <Table striped highlightOnHover withColumnBorders stickyHeader fz={'md'}>
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
