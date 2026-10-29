import { useEffect, useState } from 'react';
import {
  Anchor,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  Tooltip
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';

import { fetchJson, historyUrl, resultUrl } from '../api';
import { TestData, TestRecord } from '../types';
import { commitUrl, githubIssueUrl, timingDisplay } from '../utils';

import { ImageThumbnail } from './ImageThumbnail';
import { PixelDiffNumber } from './PixelDiffNumber';

interface Props {
  record: TestRecord;
  /// The repository that the commit hashes of the record's application refer to
  repository: string | null;
  /// Increased whenever the images might have changed on the server
  revision: number;
  /// Whether an admin token was entered, which is needed to update the reference
  canUpdateReference: boolean;
  /// Updates the reference image and resolves to whether that was successful
  onUpdateReference: (record: TestRecord) => Promise<boolean>;
}

/**
 * The number of test runs that are shown at first and added by "Show more"
 */
const PageSize = 25;

export function TestHistory({
  record,
  repository,
  revision,
  canUpdateReference,
  onUpdateReference
}: Props) {
  const [updating, setUpdating] = useState(false);
  const [confirmOpened, { open, close }] = useDisclosure(false);
  const [history, setHistory] = useState<TestData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PageSize);

  // The record only contains the most recent test runs, so the full history is loaded
  // when it is shown. It is loaded again when the record changes, for example after the
  // reference image was updated
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<TestData[]>(historyUrl(record), controller.signal)
      .then((data) => {
        setHistory(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Failed to load the history:', err);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [record]);

  // The newest test run comes first
  const testData = history ? [...history].reverse() : [];
  const latest = record.data[record.data.length - 1];

  const ImageWidth = 250;

  async function updateReference() {
    close();
    setUpdating(true);
    try {
      await onUpdateReference(record);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <>
      <Modal
        opened={confirmOpened}
        onClose={close}
        title={'Are you sure?'}
        size={'lg'}
        withCloseButton
        centered
      >
        <Stack align={'center'}>
          <Text px={'md'}>
            Are you sure you want to update the reference image to the candidate for the
            test: {record.name}?{' '}
            <Text span fw={'bold'}>
              This action cannot be undone.
            </Text>
          </Text>

          <Group align={'center'} my={'sm'} wrap={'nowrap'}>
            <Stack align={'center'} gap={'xs'}>
              <Text>Candidate</Text>
              <ImageThumbnail
                type={'candidate'}
                test={record}
                timestamp={latest?.timeStamp}
                revision={revision}
                width={ImageWidth}
              />
            </Stack>
            <Text>→</Text>
            <Stack align={'center'} gap={'xs'}>
              <Text>Reference</Text>
              <ImageThumbnail
                type={'reference'}
                test={record}
                timestamp={latest?.timeStamp}
                revision={revision}
                width={ImageWidth}
              />
            </Stack>
          </Group>
          {latest && (
            <Text>
              Error: <PixelDiffNumber value={latest.pixelError} />
            </Text>
          )}

          <Group>
            <Button onClick={updateReference} color={'red'}>
              Yes, update reference
            </Button>
            <Button onClick={close} variant={'default'} autoFocus>
              Cancel
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Box p={'md'} bg={'dark.8'}>
        {history == null && error == null && (
          <Group justify={'center'} p={'xl'}>
            <Loader />
          </Group>
        )}
        {error != null && <Text c={'red'}>Failed to load the test history: {error}</Text>}
        {history != null && (
          <Table
            horizontalSpacing={'xs'}
            verticalSpacing={4}
            withTableBorder
            withColumnBorders
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Timestamp</Table.Th>
                <Table.Th>Error</Table.Th>
                <Table.Th>Commit</Table.Th>
                <Table.Th>Timing</Table.Th>
                <Table.Th>Log</Table.Th>
                <Table.Th>Candidate</Table.Th>
                <Table.Th>Reference</Table.Th>
                <Table.Th>Difference</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {testData.slice(0, visibleCount).map((d: TestData, i: number) => {
                const commit = commitUrl(repository, d.commitHash);
                const issue = i === 0 ? githubIssueUrl(record, d, repository) : null;
                return (
                  <Table.Tr key={d.timeStamp}>
                    <Table.Td>
                      <Text size={'sm'} c={'dimmed'}>
                        {new Date(d.timeStamp).toISOString().split('T')[0]}
                        <br />
                        {new Date(d.timeStamp)
                          .toISOString()
                          .split('T')[1]
                          ?.replace('Z', '')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <PixelDiffNumber value={d.pixelError} />
                    </Table.Td>
                    <Table.Td>
                      {commit ? (
                        <Anchor
                          href={commit}
                          target={'_blank'}
                          rel={'noopener noreferrer'}
                        >
                          {d.commitHash.substring(0, 8)}
                        </Anchor>
                      ) : (
                        <Text>{d.commitHash.substring(0, 8)}</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text>{timingDisplay(d.timing)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Anchor
                        href={resultUrl('log', record, d.timeStamp)}
                        target={'_blank'}
                      >
                        Log ({d.nErrors} errors)
                      </Anchor>
                    </Table.Td>
                    {['candidate', 'reference', 'difference'].map((type) => (
                      <Table.Td key={type}>
                        <ImageThumbnail
                          type={type}
                          test={record}
                          timestamp={d.timeStamp}
                          revision={revision}
                          width={ImageWidth}
                        />
                      </Table.Td>
                    ))}
                    <Table.Td>
                      {i === 0 && (
                        <Stack gap={'xs'}>
                          <Tooltip
                            label={'Enter the admin token in the header first'}
                            disabled={canUpdateReference}
                            withArrow
                          >
                            {/* `data-disabled` instead of `disabled` keeps the tooltip working */}
                            <Button
                              variant={'default'}
                              onClick={(e: React.MouseEvent) => {
                                if (!canUpdateReference) {
                                  e.preventDefault();
                                  return;
                                }
                                open();
                              }}
                              loading={updating}
                              data-disabled={canUpdateReference ? undefined : true}
                            >
                              Upgrade Candidate to Reference
                            </Button>
                          </Tooltip>
                          {issue && (
                            <Button
                              component={'a'}
                              href={issue}
                              target={'_blank'}
                              rel={'noopener noreferrer'}
                              variant={'default'}
                            >
                              Create GitHub Issue
                            </Button>
                          )}
                        </Stack>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
        {history != null && testData.length > visibleCount && (
          <Group justify={'center'} mt={'md'}>
            <Button
              variant={'default'}
              onClick={() => setVisibleCount((c) => c + PageSize)}
            >
              Show more ({testData.length - visibleCount} older test runs)
            </Button>
          </Group>
        )}
      </Box>
    </>
  );
}
