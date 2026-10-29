import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  PasswordInput,
  ScrollArea,
  Select,
  Table,
  Text,
  TextInput,
  Title
} from '@mantine/core';
import { notifications } from '@mantine/notifications';

import { errorMessage, fetchConfig, fetchJson } from '../api';
import { CopyLinkButton } from '../components/CopyLinkButton';
import { SortableHeader } from '../components/SortableHeader';
import { TestHistory } from '../components/TestHistory';
import { TestRow } from '../components/TestRow';
import { AppConfig, SortColumn, SortDirection, TestKey, TestRecord } from '../types';
import { sortRecords, testLink } from '../utils';

/**
 * The key under which the admin token is kept in the session storage, so that it survives
 * reloading the page but not closing the browser tab
 */
const AdminTokenKey = 'adminToken';

function readStoredToken(): string {
  try {
    return sessionStorage.getItem(AdminTokenKey) ?? '';
  } catch {
    return '';
  }
}

/**
 * Loads the configuration and the test records that are shown on the page.
 */
function loadData(signal?: AbortSignal): Promise<[AppConfig, TestRecord[]]> {
  return Promise.all([
    fetchConfig(signal),
    fetchJson<TestRecord[]>('/api/test-records', signal)
  ]);
}

function sameTest(a: TestKey, b: TestKey): boolean {
  return (
    a.application === b.application &&
    a.group === b.group &&
    a.name === b.name &&
    a.hardware === b.hardware
  );
}

/**
 * The state of the page that is stored in the URL. A link to a single test uses the
 * `application`, `group`, `name`, and `hardware` parameters; the filters use `app`, `hw`,
 * `groupFilter`, and `nameFilter`.
 */
interface UrlState {
  test: TestKey | null;
  application: string | null;
  hardware: string[];
  groupFilter: string;
  nameFilter: string;
}

function readUrlState(params: URLSearchParams): UrlState {
  const application = params.get('application');
  const group = params.get('group');
  const name = params.get('name');
  const hardware = params.get('hardware');
  const test =
    application && group && name && hardware
      ? { application, group, name, hardware }
      : null;

  return {
    test: test,
    // Older links used the `application` and `hardware` parameters as filters
    application: params.get('app') ?? (test ? null : application),
    hardware: params.has('hw')
      ? params.getAll('hw')
      : test
        ? []
        : params.getAll('hardware'),
    groupFilter: params.get('groupFilter') ?? '',
    nameFilter: params.get('nameFilter') ?? ''
  };
}

export default function Home() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [initialUrl] = useState(() => readUrlState(searchParams));

  const [records, setRecords] = useState<TestRecord[]>([]);
  const [config, setConfig] = useState<AppConfig>({
    preferredHardware: [],
    applications: []
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const [defaultHardware, setDefaultHardware] = useState<string[]>([]);
  const [selectedHardware, setSelectedHardware] = useState<Set<string>>(new Set());
  const [selectedApplication, setSelectedApplication] = useState('all');
  const [adminToken, setAdminToken] = useState(readStoredToken);
  const [selectedRecord, setSelectedRecord] = useState<TestRecord | null>(null);
  const [sortCol, setSortCol] = useState<SortColumn>('pixelError');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [groupFilter, setGroupFilter] = useState(initialUrl.groupFilter);
  const [nameFilter, setNameFilter] = useState(initialUrl.nameFilter);

  // Shows the loaded configuration and test records and applies the state from the URL
  const showData = useCallback(
    ([cfg, data]: [AppConfig, TestRecord[]]) => {
      setConfig(cfg);
      setRecords(data);

      const hardwares = [...new Set(data.map((r) => r.hardware))].sort();
      const preferred = hardwares.filter((hw) => cfg.preferredHardware.includes(hw));
      const defaults = preferred.length > 0 ? preferred : hardwares;
      const fromUrl = initialUrl.hardware.filter((hw) => hardwares.includes(hw));
      setDefaultHardware(defaults);
      setSelectedHardware(new Set(fromUrl.length > 0 ? fromUrl : defaults));

      const { application } = initialUrl;
      const known = cfg.applications.some((app) => app.name === application);
      setSelectedApplication(application && known ? application : 'all');

      const { test } = initialUrl;
      if (test) {
        const found = data.find((r) => sameTest(r, test));
        if (found) {
          setSelectedRecord(found);
        } else {
          notifications.show({
            color: 'yellow',
            title: 'Test not found',
            message: `${test.application} / ${test.group} / ${test.name} on ${test.hardware}`
          });
        }
      }
      setLoading(false);
    },
    [initialUrl]
  );

  function showLoadError(err: unknown) {
    console.error('Failed to load data:', err);
    setLoadError(err instanceof Error ? err.message : String(err));
    setLoading(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal)
      .then(showData)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) showLoadError(err);
      });
    return () => controller.abort();
  }, [showData]);

  // Keep the filters and the opened test in the URL so that the page can be shared
  useEffect(() => {
    if (loading) return;

    const params = new URLSearchParams();
    if (selectedApplication !== 'all') {
      params.set('app', selectedApplication);
    }
    const hardware = [...selectedHardware].sort();
    const isDefault =
      hardware.length === defaultHardware.length &&
      hardware.every((hw) => defaultHardware.includes(hw));
    if (!isDefault) {
      if (hardware.length === 0) {
        params.set('hw', '');
      }
      hardware.forEach((hw) => params.append('hw', hw));
    }
    if (groupFilter) params.set('groupFilter', groupFilter);
    if (nameFilter) params.set('nameFilter', nameFilter);
    if (selectedRecord) {
      params.set('application', selectedRecord.application);
      params.set('group', selectedRecord.group);
      params.set('name', selectedRecord.name);
      params.set('hardware', selectedRecord.hardware);
    }

    if (params.toString() !== searchParams.toString()) {
      setSearchParams(params, { replace: true });
    }
  }, [
    loading,
    selectedApplication,
    selectedHardware,
    defaultHardware,
    groupFilter,
    nameFilter,
    selectedRecord,
    searchParams,
    setSearchParams
  ]);

  useEffect(() => {
    try {
      if (adminToken) {
        sessionStorage.setItem(AdminTokenKey, adminToken);
      } else {
        sessionStorage.removeItem(AdminTokenKey);
      }
    } catch {
      // The session storage is not available, the token is only kept in memory
    }
  }, [adminToken]);

  const repositories = useMemo(
    () => new Map(config.applications.map((app) => [app.name, app.repository])),
    [config]
  );
  const allHardware = useMemo(
    () => [...new Set(records.map((r) => r.hardware))].sort(),
    [records]
  );

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

  async function refreshRecords() {
    const data = await fetchJson<TestRecord[]>('/api/test-records');
    setRecords(data);
    setSelectedRecord((prev) =>
      prev ? (data.find((r) => sameTest(r, prev)) ?? null) : null
    );
    setRevision((r) => r + 1);
  }

  async function updateReference(record: TestRecord): Promise<boolean> {
    const test = `${record.application} / ${record.group} / ${record.name} on ${record.hardware}`;
    let response: Response;
    try {
      response = await fetch('/api/update-reference', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          application: record.application,
          group: record.group,
          name: record.name,
          hardware: record.hardware
        })
      });
    } catch (err: unknown) {
      console.error('Failed to update reference:', err);
      notifications.show({
        color: 'red',
        title: 'Could not update the reference image',
        message: 'The server could not be reached. Check your connection and try again.'
      });
      return false;
    }

    if (!response.ok) {
      notifications.show({
        color: 'red',
        title: 'Could not update the reference image',
        message:
          response.status === 401
            ? 'The admin token is not correct. Check the token in the header and try again.'
            : await errorMessage(response)
      });
      return false;
    }

    notifications.show({
      color: 'green',
      title: 'Reference image updated',
      message: `The latest candidate is now the reference image of ${test}`
    });
    try {
      await refreshRecords();
    } catch (err: unknown) {
      console.error('Failed to reload the test records:', err);
    }
    return true;
  }

  const visibleRecords = useMemo(
    () =>
      sortRecords(records, sortCol, sortDir).filter((r) => {
        if (selectedApplication !== 'all' && r.application !== selectedApplication)
          return false;
        if (!selectedHardware.has(r.hardware)) return false;
        if (groupFilter && !r.group.toLowerCase().includes(groupFilter.toLowerCase()))
          return false;
        if (nameFilter && !r.name.toLowerCase().includes(nameFilter.toLowerCase()))
          return false;
        return true;
      }),
    [
      records,
      sortCol,
      sortDir,
      selectedApplication,
      selectedHardware,
      groupFilter,
      nameFilter
    ]
  );

  function filterInput(value: string, setValue: (value: string) => void, label: string) {
    return (
      <TextInput
        placeholder={'Filter...'}
        aria-label={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rightSection={
          value && (
            <ActionIcon
              onClick={() => setValue('')}
              size={'xs'}
              variant={'subtle'}
              aria-label={`Clear ${label.toLowerCase()}`}
            >
              <Text size={'xs'}>×</Text>
            </ActionIcon>
          )
        }
      />
    );
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header: the three columns keep the title centered regardless of the side items */}
      <Box
        px={'md'}
        py={'xs'}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          backgroundColor: 'var(--mantine-color-dark-8)',
          borderBottom: '1px solid var(--mantine-color-dark-4)'
        }}
      >
        <Anchor
          component={Link}
          to={'/compare'}
          size={'sm'}
          style={{ justifySelf: 'start' }}
        >
          Hardware Compare
        </Anchor>
        <Title
          order={2}
          style={{ fontVariant: 'small-caps', fontFamily: 'Roboto, sans-serif' }}
        >
          <Link to={'/'} style={{ textDecoration: 'none', color: 'inherit' }}>
            OpenSpace Image Testing
          </Link>
        </Title>
        <Group gap={'xs'} style={{ justifySelf: 'end' }}>
          <Text fw={600} component={'label'} htmlFor={'admin-token'}>
            Admin:
          </Text>
          <PasswordInput
            id={'admin-token'}
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
      </Box>

      {/* Controls */}
      <Group
        p={'md'}
        gap={'sm'}
        align={'center'}
        wrap={'wrap'}
        style={{
          backgroundColor: 'var(--mantine-color-dark-6)',
          borderBottom: '1px solid var(--mantine-color-dark-4)'
        }}
      >
        <Text fw={600}>Application:</Text>
        <Select
          size={'xs'}
          w={200}
          aria-label={'Application'}
          data={[
            { value: 'all', label: 'All' },
            ...config.applications.map((app) => ({ value: app.name, label: app.name }))
          ]}
          value={selectedApplication}
          allowDeselect={false}
          onChange={(val) => setSelectedApplication(val ?? 'all')}
        />
        <Text fw={600}>Hardware:</Text>
        {allHardware.map((hw) => (
          <Checkbox
            key={hw}
            label={hw}
            checked={selectedHardware.has(hw)}
            onChange={() => toggleHardware(hw)}
          />
        ))}
      </Group>

      {/* Test records table */}
      {/* The table fills the remaining height below the header and the controls */}
      <ScrollArea offsetScrollbars style={{ flex: 1, minHeight: 0 }}>
        {loading && (
          <Center p={'xl'}>
            <Loader />
          </Center>
        )}
        {!loading && loadError != null && (
          <Center p={'xl'}>
            <Alert color={'red'} title={'Failed to load the test results'} maw={600}>
              <Text mb={'sm'}>{loadError}</Text>
              <Button
                variant={'default'}
                onClick={() => {
                  setLoading(true);
                  setLoadError(null);
                  loadData().then(showData).catch(showLoadError);
                }}
              >
                Try again
              </Button>
            </Alert>
          </Center>
        )}
        {!loading && loadError == null && (
          <Table
            horizontalSpacing={'xs'}
            verticalSpacing={4}
            withTableBorder
            withColumnBorders
            striped
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
                  sortKey={'application'}
                  label={'Application'}
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
                  filter={filterInput(groupFilter, setGroupFilter, 'Group filter')}
                />
                <SortableHeader
                  sortKey={'name'}
                  label={'Name'}
                  onSort={handleSort}
                  activeColumn={sortCol}
                  direction={sortDir}
                  w={160}
                  filter={filterInput(nameFilter, setNameFilter, 'Name filter')}
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
                  key={`${record.application}/${record.group}/${record.name}/${record.hardware}`}
                  onOpen={setSelectedRecord}
                  record={record}
                  repository={repositories.get(record.application) ?? null}
                  revision={revision}
                />
              ))}
            </Table.Tbody>
          </Table>
        )}
        {!loading && loadError == null && visibleRecords.length === 0 && (
          <Center p={'xl'}>
            <Text c={'dimmed'}>No tests match the current filters</Text>
          </Center>
        )}
      </ScrollArea>

      <Modal
        opened={selectedRecord !== null}
        onClose={() => setSelectedRecord(null)}
        title={
          selectedRecord ? (
            <Group gap={'xs'} align={'center'}>
              <Text>{`${selectedRecord.application} / ${selectedRecord.group} / ${selectedRecord.name} — ${selectedRecord.hardware}`}</Text>
              <CopyLinkButton
                link={() => testLink(selectedRecord)}
                label={'Copy link to this test'}
                size={'sm'}
              />
            </Group>
          ) : (
            ''
          )
        }
        size={'auto'}
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {selectedRecord && (
          <TestHistory
            record={selectedRecord}
            repository={repositories.get(selectedRecord.application) ?? null}
            revision={revision}
            canUpdateReference={adminToken.trim() !== ''}
            onUpdateReference={updateReference}
          />
        )}
      </Modal>
    </Box>
  );
}
