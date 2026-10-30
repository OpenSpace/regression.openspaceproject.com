import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Anchor,
  Box,
  Button,
  Group,
  Loader,
  SegmentedControl,
  Select,
  Table,
  Text,
  TextInput,
  Title
} from '@mantine/core';

import { compareUrl, errorMessage, fetchConfig, fetchJson, resultUrl } from '../api';
import { PixelDiffNumber } from '../components/PixelDiffNumber';
import { TestRecord } from '../types';
import { imageCount } from '../utils';

type ImageType = 'reference' | 'candidate';

/**
 * The width of the images in the comparison table. The height follows from the aspect
 * ratio of the images
 */
const ImageWidth = 150;

function parseImageType(value: string | null): ImageType {
  return value === 'candidate' ? 'candidate' : 'reference';
}

function parseImageNumber(value: string | null): number {
  const image = Number(value);
  return Number.isInteger(image) && image >= 1 ? image : 1;
}

interface Props {
  type: string;
  application: string;
  group: string;
  name: string;
  hardware1: string;
  hardware2: string;
  /// The 1-based number of the image that is compared
  imageNumber: number;
}

function CompareCell({
  type,
  application,
  group,
  name,
  hardware1,
  hardware2,
  imageNumber
}: Props) {
  const [image, setImage] = useState<string | null>(null);
  const [pixelError, setPixelError] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The comparison is expensive, so it is only requested once and the image is shown
  // from the downloaded data instead of requesting it a second time through the <img>
  useEffect(() => {
    const url = compareUrl(
      type,
      application,
      group,
      name,
      hardware1,
      hardware2,
      imageNumber
    );
    const controller = new AbortController();
    let objectUrl: string | null = null;

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorMessage(res));
        const result = res.headers.get('result');
        setPixelError(result !== null ? Number(result) : null);
        objectUrl = URL.createObjectURL(await res.blob());
        setImage(objectUrl);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error(`Failed to load comparison ${url}:`, err);
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [type, application, group, name, hardware1, hardware2, imageNumber]);

  return (
    <Table.Td
      style={{
        backgroundColor: 'var(--mantine-color-dark-6)',
        border: '0.5px solid var(--mantine-color-gray-3)',
        textAlign: 'center'
      }}
    >
      {image == null && error == null && <Loader size={'sm'} />}
      {error != null && (
        <Text size={'xs'} c={'red'} maw={ImageWidth}>
          {error}
        </Text>
      )}
      {image != null && (
        <Anchor href={image} target={'_blank'}>
          <img
            src={image}
            alt={`Difference between ${hardware1} and ${hardware2}`}
            style={{ width: ImageWidth, height: 'auto', display: 'block' }}
          />
        </Anchor>
      )}
      {pixelError !== null && <PixelDiffNumber value={pixelError} />}
    </Table.Td>
  );
}

export default function Compare() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [application, setApplication] = useState(
    searchParams.get('application') ?? 'openspace'
  );
  const [applications, setApplications] = useState<string[]>(['openspace']);
  const [group, setGroup] = useState(searchParams.get('group') ?? '');
  const [name, setName] = useState(searchParams.get('name') ?? '');
  const [type, setType] = useState<ImageType>(parseImageType(searchParams.get('type')));
  const [hardwares, setHardwares] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState('');

  // The parameters of the comparison that is shown (separate from the input fields)
  const [result, setResult] = useState<{
    application: string;
    group: string;
    name: string;
    type: ImageType;
    image: number;
    nImages: number;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchConfig(controller.signal)
      .then((config) => {
        if (config.applications.length > 0) {
          setApplications(config.applications.map((app) => app.name));
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Failed to load config:', err);
      });
    return () => controller.abort();
  }, []);

  function generateComparison(
    app: string,
    g: string,
    n: string,
    t: ImageType,
    requestedImage = 1
  ) {
    fetchJson<TestRecord[]>('/api/test-records')
      .then((records) => {
        const hwList = [
          ...new Set(records.filter((r) => r.application === app).map((r) => r.hardware))
        ].sort();
        // The image selection is only needed if the test has more than one image
        const nImages = Math.max(
          1,
          ...records
            .filter((r) => r.application === app && r.group === g && r.name === n)
            .map((r) => {
              const latest = r.data[r.data.length - 1];
              return latest ? imageCount(latest) : 1;
            })
        );
        const image = requestedImage <= nImages ? requestedImage : 1;
        setLoadError(null);
        setResult({ application: app, group: g, name: n, type: t, image, nImages });
        setHardwares(hwList);
        const params = new URLSearchParams({
          application: app,
          group: g,
          name: n,
          type: t
        });
        if (image > 1) {
          params.set('image', String(image));
        }
        setShareUrl(`${location.origin}${location.pathname}?${params.toString()}`);
      })
      .catch((err: unknown) => {
        console.error('Failed to generate comparison:', err);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }

  // Auto-generate if URL params are present on mount
  useEffect(() => {
    const urlApplication = searchParams.get('application') ?? 'openspace';
    const urlGroup = searchParams.get('group');
    const urlName = searchParams.get('name');
    const urlType = parseImageType(searchParams.get('type'));
    if (urlGroup && urlName) {
      generateComparison(
        urlApplication,
        urlGroup,
        urlName,
        urlType,
        parseImageNumber(searchParams.get('image'))
      );
    }
    // Intentionally run only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleGenerate() {
    setSearchParams({ application, group, name, type });
    generateComparison(application, group, name, type);
  }

  function selectImage(image: number) {
    if (!result) return;
    const params: Record<string, string> = {
      application: result.application,
      group: result.group,
      name: result.name,
      type: result.type
    };
    if (image > 1) {
      params['image'] = String(image);
    }
    setSearchParams(params);
    generateComparison(result.application, result.group, result.name, result.type, image);
  }

  return (
    <Box>
      {/* Header */}
      <Box
        py={'xs'}
        style={{ textAlign: 'center', backgroundColor: 'var(--mantine-color-dark-7)' }}
      >
        <Title
          order={2}
          style={{ fontVariant: 'small-caps', fontFamily: 'Roboto, sans-serif' }}
        >
          <Link to={'/'} style={{ textDecoration: 'none', color: 'inherit' }}>
            OpenSpace Image Testing
          </Link>
        </Title>
      </Box>

      {/* Input fields */}
      <Group
        p={'sm'}
        align={'flex-end'}
        style={{ backgroundColor: 'var(--mantine-color-dark-6)' }}
      >
        <Select
          label={'Application'}
          size={'sm'}
          w={160}
          value={application}
          allowDeselect={false}
          onChange={(val) => setApplication(val ?? 'openspace')}
          data={applications.map((app) => ({ value: app, label: app }))}
        />
        <TextInput
          label={'Group'}
          size={'sm'}
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        />
        <TextInput
          label={'Name'}
          size={'sm'}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          label={'Type'}
          size={'sm'}
          w={160}
          value={type}
          allowDeselect={false}
          onChange={(val) => setType(parseImageType(val))}
          data={[
            { value: 'reference', label: 'Reference' },
            { value: 'candidate', label: 'Candidate' }
          ]}
        />
        <Button onClick={handleGenerate} autoFocus>
          Generate
        </Button>
      </Group>

      {loadError && (
        <Box px={'sm'} py={'xs'}>
          <Text c={'red'}>Failed to load the tests: {loadError}</Text>
        </Box>
      )}

      {shareUrl && (
        <Box px={'sm'} py={'xs'}>
          <Anchor href={shareUrl} size={'sm'}>
            {shareUrl}
          </Anchor>
        </Box>
      )}

      {result && result.nImages > 1 && (
        <Box px={'sm'} py={'xs'}>
          <SegmentedControl
            value={String(result.image)}
            onChange={(value) => selectImage(Number(value))}
            data={Array.from({ length: result.nImages }, (_, i) => ({
              value: String(i + 1),
              label: `Image ${i + 1}`
            }))}
          />
        </Box>
      )}

      {result && (
        <Table id={'splom'} withColumnBorders withTableBorder>
          <Table.Tbody>
            {hardwares.map((hw, i) => {
              const test = {
                application: result.application,
                group: result.group,
                name: result.name,
                hardware: hw
              };
              return (
                <Table.Tr key={hw}>
                  {/* Lower triangle: empty cells */}
                  {hardwares.slice(0, i).map((_, j) => (
                    <Table.Td key={j} />
                  ))}
                  {/* Diagonal: single hardware image */}
                  <Table.Td
                    style={{
                      backgroundColor: 'var(--mantine-color-dark-6)',
                      border: '0.5px solid var(--mantine-color-gray-3)',
                      textAlign: 'center'
                    }}
                  >
                    <Anchor
                      href={resultUrl(result.type, test, undefined, 0, result.image)}
                      target={'_blank'}
                    >
                      <img
                        src={resultUrl(
                          `${result.type}-thumbnail`,
                          test,
                          undefined,
                          0,
                          result.image
                        )}
                        alt={`${result.type} image on ${hw}`}
                        style={{ width: ImageWidth, height: 'auto', display: 'block' }}
                      />
                    </Anchor>
                    <Text size={'sm'} ta={'center'}>
                      {hw}
                    </Text>
                  </Table.Td>
                  {/* Upper triangle: cross-hardware comparisons */}
                  {hardwares.slice(i + 1).map((hw2) => (
                    <CompareCell
                      key={`${hw2}-${result.image}`}
                      imageNumber={result.image}
                      type={result.type}
                      application={result.application}
                      group={result.group}
                      name={result.name}
                      hardware1={hw}
                      hardware2={hw2}
                    />
                  ))}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}
    </Box>
  );
}
