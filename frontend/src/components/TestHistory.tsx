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
import {
  commitUrl,
  githubIssueUrl,
  imageCount,
  imageError,
  timingDisplay
} from '../utils';

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
  /// Whether the test can be rerun through Jenkins on its hardware
  canRerun: boolean;
  /// Reruns the test at the `commit`, or at the latest commit if it is `null`, and
  /// resolves to whether the rerun was started
  onRerun: (record: TestRecord, commit: string | null) => Promise<boolean>;
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
  onUpdateReference,
  canRerun,
  onRerun
}: Props) {
  const [updating, setUpdating] = useState(false);
  const [confirmOpened, { open, close }] = useDisclosure(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunOpened, rerunDialog] = useDisclosure(false);
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
  const nLatestImages = latest ? imageCount(latest) : 1;

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

  async function rerun(commit: string | null) {
    rerunDialog.close();
    setRerunning(true);
    try {
      await onRerun(record, commit);
    } finally {
      setRerunning(false);
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
            Are you sure you want to update the{' '}
            {nLatestImages > 1
              ? `${nLatestImages} reference images to their candidates`
              : 'reference image to the candidate'}{' '}
            for the test: {record.name}?{' '}
            <Text span fw={'bold'}>
              This action cannot be undone.
            </Text>
          </Text>

          {Array.from({ length: nLatestImages }, (_, i) => i + 1).map((image) => (
            <Stack key={image} align={'center'} gap={'xs'}>
              {nLatestImages > 1 && <Text fw={'bold'}>Image {image}</Text>}
              <Group align={'center'} my={'sm'} wrap={'nowrap'}>
                <Stack align={'center'} gap={'xs'}>
                  <Text>Candidate</Text>
                  <ImageThumbnail
                    type={'candidate'}
                    test={record}
                    timestamp={latest?.timeStamp}
                    revision={revision}
                    width={ImageWidth}
                    image={image}
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
                    image={image}
                  />
                </Stack>
              </Group>
              {latest && (
                <Text>
                  Error: <PixelDiffNumber value={imageError(latest, image)} />
                </Text>
              )}
            </Stack>
          ))}

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

      <Modal
        opened={rerunOpened}
        onClose={rerunDialog.close}
        title={'Rerun test'}
        size={'lg'}
        withCloseButton
        centered
      >
        <Stack align={'center'}>
          <Text px={'md'}>
            Jenkins will build OpenSpace and run the test {record.name} again on{' '}
            {record.hardware}. Which commit should be built?
          </Text>
          <Group>
            {latest && (
              <Button onClick={() => rerun(latest.commitHash)}>
                Commit {latest.commitHash.substring(0, 8)} of the latest run
              </Button>
            )}
            <Button onClick={() => rerun(null)}>Latest commit</Button>
            <Button onClick={rerunDialog.close} variant={'default'} autoFocus>
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
                const nImages = imageCount(d);
                // Each image has its own row, and the values of the whole test run span
                // the rows of all of its images
                return Array.from({ length: nImages }, (_, k) => k + 1).map((image) => (
                  <Table.Tr key={`${d.timeStamp}-${image}`}>
                    {image === 1 && (
                      <Table.Td rowSpan={nImages}>
                        <Text size={'sm'} c={'dimmed'}>
                          {new Date(d.timeStamp).toISOString().split('T')[0]}
                          <br />
                          {new Date(d.timeStamp)
                            .toISOString()
                            .split('T')[1]
                            ?.replace('Z', '')}
                        </Text>
                      </Table.Td>
                    )}
                    <Table.Td>
                      {nImages > 1 && (
                        <Text size={'xs'} c={'dimmed'}>
                          Image {image}
                        </Text>
                      )}
                      <PixelDiffNumber value={imageError(d, image)} />
                    </Table.Td>
                    {image === 1 && (
                      <>
                        <Table.Td rowSpan={nImages}>
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
                        <Table.Td rowSpan={nImages}>
                          <Text>{timingDisplay(d.timing)}</Text>
                        </Table.Td>
                        <Table.Td rowSpan={nImages}>
                          <Anchor
                            href={resultUrl('log', record, d.timeStamp)}
                            target={'_blank'}
                          >
                            Log ({d.nErrors} errors)
                          </Anchor>
                        </Table.Td>
                      </>
                    )}
                    {['candidate', 'reference', 'difference'].map((type) => (
                      <Table.Td key={type}>
                        <ImageThumbnail
                          type={type}
                          test={record}
                          timestamp={d.timeStamp}
                          revision={revision}
                          width={ImageWidth}
                          image={image}
                        />
                      </Table.Td>
                    ))}
                    {image === 1 && (
                      <Table.Td rowSpan={nImages}>
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
                            {canRerun && (
                              <Tooltip
                                label={'Enter the admin token in the header first'}
                                disabled={canUpdateReference}
                                withArrow
                              >
                                <Button
                                  variant={'default'}
                                  onClick={(e: React.MouseEvent) => {
                                    if (!canUpdateReference) {
                                      e.preventDefault();
                                      return;
                                    }
                                    rerunDialog.open();
                                  }}
                                  loading={rerunning}
                                  data-disabled={canUpdateReference ? undefined : true}
                                >
                                  Rerun Test
                                </Button>
                              </Tooltip>
                            )}
                          </Stack>
                        )}
                      </Table.Td>
                    )}
                  </Table.Tr>
                ));
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
