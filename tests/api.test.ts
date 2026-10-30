import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import request from 'supertest';
import { setTimeout as sleep } from 'timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Store all data of the tests in a temporary folder instead of the project's data folder
vi.mock('../src/paths', async () => {
  const fsModule = await import('fs');
  const osModule = await import('os');
  const pathModule = await import('path');
  const root = fsModule.mkdtempSync(
    pathModule.join(osModule.tmpdir(), 'regression-test-')
  );
  return { ProjectRoot: root, DataFolder: pathModule.join(root, 'data') };
});

import { createApp } from '../src/app';
import { initializeAudit } from '../src/audit';
import { loadConfiguration } from '../src/configuration';
import { closeDatabase, openDatabase } from '../src/database';
import { DataFolder, ProjectRoot } from '../src/paths';

const AdminToken = 'test-admin-token-0123456789';
const Runner = 'test-runner';
const Width = 64;
const Height = 32;

/**
 * Creates a PNG image in which every pixel has the same color, except for the first
 * `changed` pixels, which are white.
 */
function makePng(color: [number, number, number], changed = 0, width = Width): Buffer {
  const png = new PNG({ width: width, height: Height });
  for (let i = 0; i < width * Height; i++) {
    png.data.set(i < changed ? [255, 255, 255, 255] : [...color, 255], i * 4);
  }
  return PNG.sync.write(png);
}

let app: Express;

beforeAll(() => {
  fs.mkdirSync(path.join(DataFolder, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(DataFolder, 'reference'), { recursive: true });
  const configFile = path.join(ProjectRoot, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      slack: { token: '', channel: '' },
      comparisonThreshold: 0.1,
      imageSize: { width: Width, height: Height },
      applications: [
        { name: 'openspace', imageSize: { width: Width, height: Height } },
        { name: 'sgct', imageSize: null }
      ],
      thumbnailScale: 4,
      runners: [Runner],
      jenkins: {
        url: 'https://jenkins.test/',
        job: 'image testing',
        targets: [{ application: 'openspace', hardware: 'hw1', node: 'node-hw1' }]
      }
    })
  );
  // The package.json is needed for the version reported by the health check
  fs.writeFileSync(path.join(ProjectRoot, 'package.json'), '{ "version": "1.2.3" }');

  process.env['PORT'] = '8000';
  process.env['ADMIN_TOKEN'] = AdminToken;
  process.env['JENKINS_USER'] = 'jenkins-user';
  process.env['JENKINS_TOKEN'] = 'jenkins-token';
  loadConfiguration(configFile, path.join(ProjectRoot, 'missing.env'));
  initializeAudit();
  openDatabase();
  app = createApp();
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(ProjectRoot, { recursive: true, force: true });
});

function submit(
  fields: Record<string, string>,
  file: Buffer | null = makePng([0, 0, 255])
) {
  const values: Record<string, string> = {
    runnerID: Runner,
    hardware: 'hw1',
    group: 'group',
    name: 'test',
    timestamp: '2026-01-01T00:00:00Z',
    timing: '1.5',
    commitHash: 'abcdef1',
    ...fields
  };
  let req = request(app).post('/api/submit-test');
  for (const [key, value] of Object.entries(values)) {
    req = req.field(key, value);
  }
  if (file) {
    req = req.attach('file', file, 'candidate.png');
  }
  return req.attach('log', Buffer.from('error 1\n\nerror 2\n'), 'log.txt');
}

async function history(hardware = 'hw1') {
  const res = await request(app).get(
    `/api/test-history/openspace/group/test/${hardware}`
  );
  expect(res.status).toBe(200);
  return res.body as {
    timeStamp: string;
    pixelError: number;
    nErrors: number;
    referenceImage: string;
    candidateImage: string;
    differenceImage: string;
  }[];
}

describe('submitting test runs', () => {
  it('uses the first submission as the reference image', async () => {
    const res = await submit({});
    expect(res.status).toBe(200);

    const runs = await history();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.pixelError).toBe(0);
    expect(runs[0]!.nErrors).toBe(2);
    expect(runs[0]!.referenceImage).toBe('20260101T000000000Z.png');
    const reference = path.join(DataFolder, 'reference/openspace/hw1/group/test');
    expect(fs.existsSync(path.join(reference, '20260101T000000000Z.png'))).toBe(true);
    expect(fs.existsSync(path.join(reference, '20260101T000000000Z-thumbnail.png'))).toBe(
      true
    );
  });

  it('reuses identical images of earlier test runs', async () => {
    const res = await submit({ timestamp: '2026-01-02T00:00:00Z' });
    expect(res.status).toBe(200);

    const runs = await history();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.candidateImage).toBe(runs[0]!.timeStamp);
    expect(runs[1]!.differenceImage).toBe(runs[0]!.timeStamp);
    // As both images were reused, the test run does not have a folder
    const folder = path.join(
      DataFolder,
      'tests/openspace/hw1/group/test/20260102T000000000Z'
    );
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('rejects a second test run with the same timestamp', async () => {
    const res = await submit({ timestamp: '2026-01-02T00:00:00Z' });
    expect(res.status).toBe(409);
    expect(await history()).toHaveLength(2);
  });

  it('interprets timestamps without a timezone as UTC', async () => {
    const res = await submit(
      { timestamp: '2026-01-03T00:00:00' },
      makePng([0, 0, 255], 64)
    );
    expect(res.status).toBe(200);

    const runs = await history();
    expect(runs[2]!.timeStamp).toBe('2026-01-03T00:00:00.000Z');
    expect(runs[2]!.pixelError).toBeCloseTo(64 / (Width * Height));
    expect(runs[2]!.candidateImage).toBe(runs[2]!.timeStamp);
  });

  it('rejects names that could escape the data folder', async () => {
    for (const hardware of ['../escape', '..', 'a/b', '.hidden']) {
      const res = await submit({ hardware });
      expect(res.status).toBe(400);
    }
    expect(fs.existsSync(path.join(DataFolder, 'tests/escape'))).toBe(false);
    expect(fs.existsSync(path.join(DataFolder, 'escape'))).toBe(false);
  });

  it('rejects unknown runners, missing files, and images of the wrong size', async () => {
    expect((await submit({ runnerID: 'unknown' })).status).toBe(401);
    expect((await submit({ timestamp: '2026-02-01T00:00:00Z' }, null)).status).toBe(400);

    const wrongSize = await submit(
      { timestamp: '2026-02-02T00:00:00Z' },
      makePng([0, 0, 255], 0, Width * 2)
    );
    expect(wrongSize.status).toBe(400);
    expect(wrongSize.body.error).toMatch(/wrong size/);
  });

  it('rejects images that are larger than the maximum size before decoding them', async () => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(20000, 16);
    header.writeUInt32BE(20000, 20);

    const res = await submit({ timestamp: '2026-02-03T00:00:00Z' }, header);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/16384x16384/);
  });

  it('rejects timestamps in the future', async () => {
    const res = await submit({ timestamp: '2099-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });
});

describe('results', () => {
  it('returns the images, thumbnails, and logs', async () => {
    const image = await request(app).get(
      '/api/result/candidate/openspace/group/test/hw1'
    );
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['timestamp']).toBe('2026-01-03T00:00:00.000Z');

    const thumbnail = await request(app).get(
      '/api/result/difference-thumbnail/openspace/group/test/hw1/2026-01-02T12:00:00Z'
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['timestamp']).toBe('2026-01-02T00:00:00.000Z');

    const log = await request(app).get('/api/result/log/openspace/group/test/hw1');
    expect(log.status).toBe(200);
    expect(log.text).toBe('error 1\nerror 2');
  });

  it('supports the legacy URLs without an application, including a timestamp', async () => {
    const latest = await request(app).get('/api/result/candidate/group/test/hw1');
    expect(latest.status).toBe(200);

    const earlier = await request(app).get(
      '/api/result/candidate/group/test/hw1/2026-01-01T00:00:00Z'
    );
    expect(earlier.status).toBe(200);
    expect(earlier.headers['timestamp']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('answers unknown tests and invalid requests with errors', async () => {
    expect((await request(app).get('/api/result/candidate/openspace/x/y/z')).status).toBe(
      404
    );
    expect(
      (await request(app).get('/api/result/invalid/openspace/group/test/hw1')).status
    ).toBe(400);
    expect(
      (await request(app).get('/api/result/candidate/openspace/group/test/hw1/never'))
        .status
    ).toBe(400);
  });
});

describe('running tests', () => {
  it('requires a runner ID', async () => {
    const res = await request(app)
      .post('/api/run-test')
      .field('hardware', 'hw1')
      .field('group', 'group')
      .field('name', 'test')
      .attach('file', makePng([0, 0, 255]), 'candidate.png');
    expect(res.status).toBe(401);
  });

  it('returns the difference image without storing anything', async () => {
    const res = await request(app)
      .post('/api/run-test')
      .field('runnerID', Runner)
      .field('hardware', 'hw1')
      .field('group', 'group')
      .field('name', 'test')
      .attach('file', makePng([0, 0, 255], 128), 'candidate.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Number(res.headers['result'])).toBeCloseTo(128 / (Width * Height));
    expect(await history()).toHaveLength(3);
  });

  it('handles requests without a body', async () => {
    const res = await request(app).post('/api/run-test');
    expect(res.status).toBe(401);
  });
});

describe('updating the reference image', () => {
  function update(token: string | null) {
    const req = request(app).post('/api/update-reference');
    if (token != null) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.send({ group: 'group', name: 'test', hardware: 'hw1' });
  }

  it('requires the admin token', async () => {
    expect((await update(null)).status).toBe(401);
    expect((await update('wrong-token')).status).toBe(401);
    // The token in the body is not accepted anymore
    const body = await request(app)
      .post('/api/update-reference')
      .send({ adminToken: AdminToken, group: 'group', name: 'test', hardware: 'hw1' });
    expect(body.status).toBe(401);
  });

  it('makes the latest candidate the new reference image', async () => {
    const res = await update(AdminToken);
    expect(res.status).toBe(200);

    const runs = await history();
    const latest = runs[runs.length - 1]!;
    expect(latest.pixelError).toBe(0);
    expect(latest.referenceImage).toBe('20260103T000000000Z.png');
    // Earlier test runs keep their reference image
    expect(runs[0]!.referenceImage).toBe('20260101T000000000Z.png');

    // New test runs are compared against the new reference
    const next = await submit(
      { timestamp: '2026-01-04T00:00:00Z' },
      makePng([0, 0, 255], 64)
    );
    expect(next.status).toBe(200);
    expect((await history()).at(-1)!.pixelError).toBe(0);
  });

  it('rejects requests for unknown tests and invalid names', async () => {
    const unknown = await request(app)
      .post('/api/update-reference')
      .set('Authorization', `Bearer ${AdminToken}`)
      .send({ group: 'group', name: 'unknown', hardware: 'hw1' });
    expect(unknown.status).toBe(404);

    const invalid = await request(app)
      .post('/api/update-reference')
      .set('Authorization', `Bearer ${AdminToken}`)
      .send({ group: 'group', name: '../test', hardware: 'hw1' });
    expect(invalid.status).toBe(400);
  });
});

describe('rerunning tests', () => {
  function rerun(body: Record<string, string>, token: string | null = AdminToken) {
    const req = request(app).post('/api/rerun-test');
    if (token != null) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.send({ group: 'group', name: 'test', hardware: 'hw1', ...body });
  }

  function mockJenkins(response: Response | Error) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
      );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires the admin token', async () => {
    const jenkins = mockJenkins(new Response(null, { status: 201 }));
    expect((await rerun({}, null)).status).toBe(401);
    expect((await rerun({}, 'wrong-token')).status).toBe(401);
    expect(jenkins).not.toHaveBeenCalled();
  });

  it('starts the Jenkins job for the node of the hardware', async () => {
    const jenkins = mockJenkins(new Response(null, { status: 201 }));

    const latest = await rerun({});
    expect(latest.status).toBe(202);
    expect(jenkins).toHaveBeenCalledTimes(1);
    const [url, init] = jenkins.mock.calls[0]!;
    expect(url).toBe('https://jenkins.test/job/image%20testing/buildWithParameters');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${Buffer.from('jenkins-user:jenkins-token').toString('base64')}`
    );
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      NODE: 'node-hw1',
      TEST_ID: 'group/test',
      COMMIT: ''
    });

    expect((await rerun({ commit: 'abcdef1' })).status).toBe(202);
    const body = jenkins.mock.calls[1]![1]?.body as URLSearchParams;
    expect(body.get('COMMIT')).toBe('abcdef1');
  });

  it('rejects tests that cannot be rerun and invalid commits', async () => {
    const jenkins = mockJenkins(new Response(null, { status: 201 }));
    expect((await rerun({ hardware: 'hw2' })).status).toBe(400);
    expect((await rerun({ application: 'sgct' })).status).toBe(400);
    expect((await rerun({ commit: 'main; rm -rf' })).status).toBe(400);
    expect((await rerun({ name: 'unknown' })).status).toBe(404);
    expect(jenkins).not.toHaveBeenCalled();
  });

  it('reports when Jenkins fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockJenkins(new Response(null, { status: 403 }));
    const rejected = await rerun({});
    expect(rejected.status).toBe(502);
    expect(rejected.body.error).toMatch(/status 403/);

    mockJenkins(new Error('connect ECONNREFUSED'));
    const unreachable = await rerun({});
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error).not.toMatch(/ECONNREFUSED/);
  });
});

describe('comparing hardware', () => {
  it('compares the images of two hardware setups in memory', async () => {
    expect((await submit({ hardware: 'hw2' }, makePng([0, 0, 255], 32))).status).toBe(
      200
    );

    const res = await request(app).get(
      '/api/compare/candidate/openspace/group/test/hw1/hw2'
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Number(res.headers['result'])).toBeCloseTo((64 - 32) / (Width * Height));
    expect(fs.existsSync(path.join(DataFolder, 'temporary'))).toBe(false);
  });
});

describe('multiple images', () => {
  const Group = 'multi';
  const Url = 'openspace/multi/test/hw1';

  function submitImages(
    timestamp: string,
    images: Record<string, Buffer>,
    fields: Record<string, string> = {}
  ) {
    let req = request(app).post('/api/submit-test');
    const values = {
      runnerID: Runner,
      hardware: 'hw1',
      group: Group,
      name: 'test',
      timestamp: timestamp,
      timing: '1',
      commitHash: 'abcdef1',
      ...fields
    };
    for (const [key, value] of Object.entries(values)) {
      req = req.field(key, value);
    }
    for (const [field, image] of Object.entries(images)) {
      req = req.attach(field, image, `${field}.png`);
    }
    return req.attach('log', Buffer.from('error'), 'log.txt');
  }

  async function runs(url = Url) {
    const [application, group, name, hardware] = url.split('/');
    const res = await request(app).get(
      `/api/test-history/${application}/${group}/${name}/${hardware}`
    );
    expect(res.status).toBe(200);
    return res.body as {
      pixelError: number;
      candidateImage: string;
      differenceImage: string;
      images?: { pixelError: number }[];
    }[];
  }

  const testFolder = path.join(DataFolder, 'tests/openspace/hw1/multi/test');
  const referenceFolder = path.join(DataFolder, 'reference/openspace/hw1/multi/test');

  it('rejects gaps and wrong sizes without leaving files behind', async () => {
    const gap = await submitImages('2026-03-01T00:00:00Z', {
      file: makePng([0, 0, 255]),
      file3: makePng([0, 0, 255])
    });
    expect(gap.status).toBe(400);
    expect(gap.body.error).toMatch(/file2/);

    const missingFirst = await submitImages('2026-03-01T00:00:00Z', {
      file2: makePng([0, 0, 255])
    });
    expect(missingFirst.status).toBe(400);

    const wrongSize = await submitImages('2026-03-01T00:00:00Z', {
      file: makePng([0, 0, 255]),
      file2: makePng([0, 0, 255], 0, Width * 2)
    });
    expect(wrongSize.status).toBe(400);
    expect(wrongSize.body.error).toMatch(/wrong size/);

    expect(fs.existsSync(testFolder)).toBe(false);
    expect(fs.existsSync(referenceFolder)).toBe(false);
  });

  it('stores and returns all images of a test run', async () => {
    const res = await submitImages('2026-03-01T00:00:00Z', {
      file: makePng([0, 0, 255]),
      file2: makePng([255, 0, 0])
    });
    expect(res.status).toBe(200);

    expect(fs.existsSync(path.join(referenceFolder, '20260301T000000000Z.png'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(referenceFolder, '20260301T000000000Z-2.png'))).toBe(
      true
    );
    const folder = path.join(testFolder, '20260301T000000000Z');
    for (const file of [
      'candidate.png',
      'candidate-thumbnail.png',
      'candidate-2.png',
      'candidate-2-thumbnail.png',
      'difference.png',
      'difference-2.png'
    ]) {
      expect(fs.existsSync(path.join(folder, file))).toBe(true);
    }

    for (const type of [
      'candidate',
      'reference',
      'difference',
      'candidate-1',
      'candidate-2',
      'reference-2',
      'difference-2',
      'candidate-2-thumbnail',
      'reference-2-thumbnail',
      'difference-2-thumbnail'
    ]) {
      expect((await request(app).get(`/api/result/${type}/${Url}`)).status).toBe(200);
    }
    // The legacy URLs support the number of the image as well
    expect(
      (await request(app).get('/api/result/candidate-2/multi/test/hw1')).status
    ).toBe(200);
    expect((await request(app).get(`/api/result/candidate-3/${Url}`)).status).toBe(404);
    expect((await request(app).get(`/api/result/log-2/${Url}`)).status).toBe(400);
    expect((await request(app).get(`/api/result/log/${Url}`)).text).toBe('error');
  });

  it('reports the largest error and the error of each image', async () => {
    const res = await submitImages('2026-03-02T00:00:00Z', {
      file: makePng([0, 0, 255]),
      file2: makePng([255, 0, 0], 64)
    });
    expect(res.status).toBe(200);

    const latest = (await runs()).at(-1)!;
    expect(latest.pixelError).toBeCloseTo(64 / (Width * Height));
    expect(latest.images).toHaveLength(2);
    expect(latest.images![0]!.pixelError).toBe(0);
    expect(latest.images![1]!.pixelError).toBeCloseTo(64 / (Width * Height));
  });

  it('reuses identical images only per position', async () => {
    const res = await submitImages('2026-03-03T00:00:00Z', {
      file: makePng([0, 0, 255]),
      file2: makePng([255, 0, 0], 64)
    });
    expect(res.status).toBe(200);
    // All images were reused, so the test run does not have a folder
    expect(fs.existsSync(path.join(testFolder, '20260303T000000000Z'))).toBe(false);

    // This candidate looks like an earlier first image, but has to be stored as the second
    const swapped = await submitImages(
      '2026-03-04T00:00:00Z',
      { file: makePng([0, 0, 255]), file2: makePng([0, 0, 255]) },
      {}
    );
    expect(swapped.status).toBe(200);
    expect(
      fs.existsSync(path.join(testFolder, '20260304T000000000Z', 'candidate-2.png'))
    ).toBe(true);
  });

  it('compares each image in the run-test and compare calls', async () => {
    const image2 = await request(app)
      .post('/api/run-test')
      .field('runnerID', Runner)
      .field('hardware', 'hw1')
      .field('group', Group)
      .field('name', 'test')
      .field('image', '2')
      .attach('file', makePng([255, 0, 0]), 'candidate.png');
    expect(image2.status).toBe(200);
    expect(Number(image2.headers['result'])).toBe(0);

    const missing = await request(app)
      .post('/api/run-test')
      .field('runnerID', Runner)
      .field('hardware', 'hw1')
      .field('group', Group)
      .field('name', 'test')
      .field('image', '3')
      .attach('file', makePng([255, 0, 0]), 'candidate.png');
    expect(missing.status).toBe(404);

    const other = await submitImages(
      '2026-03-05T00:00:00Z',
      { file: makePng([0, 0, 255]), file2: makePng([255, 0, 0], 32) },
      { hardware: 'hw2' }
    );
    expect(other.status).toBe(200);
    const reference2 = await request(app).get(
      `/api/compare/reference-2/openspace/${Group}/test/hw1/hw2`
    );
    expect(reference2.status).toBe(200);
    expect(Number(reference2.headers['result'])).toBeCloseTo(32 / (Width * Height));
    const reference3 = await request(app).get(
      `/api/compare/reference-3/openspace/${Group}/test/hw1/hw2`
    );
    expect(reference3.status).toBe(404);
    const candidate3 = await request(app).get(
      `/api/compare/candidate-3/openspace/${Group}/test/hw1/hw2`
    );
    expect(candidate3.status).toBe(404);
  });

  it('upgrades all images to references', async () => {
    const res = await request(app)
      .post('/api/update-reference')
      .set('Authorization', `Bearer ${AdminToken}`)
      .send({ group: Group, name: 'test', hardware: 'hw1' });
    expect(res.status).toBe(200);

    expect(fs.existsSync(path.join(referenceFolder, '20260304T000000000Z.png'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(referenceFolder, '20260304T000000000Z-2.png'))).toBe(
      true
    );
    const latest = (await runs()).at(-1)!;
    expect(latest.pixelError).toBe(0);
    expect(latest.images!.map((image) => image.pixelError)).toEqual([0, 0]);
  });

  it('creates the reference of an image that is added to a test', async () => {
    const options = { hardware: 'hw1', name: 'grows' };
    const one = await submitImages(
      '2026-03-06T00:00:00Z',
      { file: makePng([0, 0, 255]) },
      options
    );
    expect(one.status).toBe(200);

    const two = await submitImages(
      '2026-03-07T00:00:00Z',
      { file: makePng([0, 0, 255]), file2: makePng([255, 0, 0]) },
      options
    );
    expect(two.status).toBe(200);
    const folder = path.join(DataFolder, 'reference/openspace/hw1/multi/grows');
    expect(fs.existsSync(path.join(folder, '20260306T000000000Z-2.png'))).toBe(true);

    const three = await submitImages(
      '2026-03-08T00:00:00Z',
      { file: makePng([0, 0, 255]), file2: makePng([255, 0, 0], 64) },
      options
    );
    expect(three.status).toBe(200);
    const all = await runs('openspace/multi/grows/hw1');
    expect(all[0]!.images).toBeUndefined();
    expect(all[1]!.pixelError).toBe(0);
    expect(all[2]!.images![1]!.pixelError).toBeCloseTo(64 / (Width * Height));

    // The first test run does not have a second image
    expect(
      (
        await request(app).get(
          '/api/result/candidate-2/openspace/multi/grows/hw1/2026-03-06T00:00:00Z'
        )
      ).status
    ).toBe(404);
  });

  it('does not add values for multiple images to test runs with one image', async () => {
    const records = await request(app).get('/api/test-records');
    const single = (records.body as { group: string; data: object[] }[]).find(
      (record) => record.group == 'group'
    )!;
    expect(Object.keys(single.data[0]!).sort()).toEqual([
      'candidateImage',
      'commitHash',
      'differenceImage',
      'nErrors',
      'pixelError',
      'referenceImage',
      'timeStamp',
      'timing'
    ]);
  });
});

describe('other endpoints', () => {
  it('reports the health of the server', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.version).toBe('1.2.3');
  });

  it('returns the applications with their repositories', async () => {
    const res = await request(app).get('/api/config');
    expect(res.body.applications).toEqual([
      { name: 'openspace', repository: 'https://github.com/OpenSpace/OpenSpace' },
      { name: 'sgct', repository: 'https://github.com/SGCT/SGCT' }
    ]);
    expect(res.body.rerunTargets).toEqual([
      { application: 'openspace', hardware: 'hw1' }
    ]);
  });

  it('answers unknown API endpoints with a JSON error', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('sends security headers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('validates the new threshold', async () => {
    const res = await request(app)
      .post('/api/update-diff-threshold')
      .set('Authorization', `Bearer ${AdminToken}`)
      .send({ threshold: 2 });
    expect(res.status).toBe(400);
  });

  it('regenerates the results in the background when the threshold changes', async () => {
    const before = await history();

    const res = await request(app)
      .post('/api/update-diff-threshold')
      .set('Authorization', `Bearer ${AdminToken}`)
      .send({ threshold: 0.5 });
    expect(res.status).toBe(202);

    let state = (await request(app).get('/api/diff-threshold')).body;
    for (let i = 0; i < 200 && state.regenerating; i++) {
      await sleep(25);
      state = (await request(app).get('/api/diff-threshold')).body;
    }
    expect(state).toEqual({ value: 0.5, regenerating: false });

    // Only the threshold is written to the configuration file, never the environment
    const config = JSON.parse(
      fs.readFileSync(path.join(ProjectRoot, 'config.json'), 'utf-8')
    );
    expect(config.comparisonThreshold).toBe(0.5);
    expect(config.adminToken).toBeUndefined();

    // White and blue pixels differ by more than the new threshold, so the errors stay
    // the same, and every test run still has its difference image
    const after = await history();
    expect(after.map((r) => r.pixelError)).toEqual(before.map((r) => r.pixelError));

    // The results of all images of a test run are regenerated
    const multiple = await request(app).get(
      '/api/result/difference-2/openspace/multi/grows/hw1'
    );
    expect(multiple.status).toBe(200);
    const records = (
      await request(app).get('/api/test-history/openspace/multi/grows/hw1')
    ).body as { images?: { pixelError: number }[] }[];
    expect(records.at(-1)!.images![1]!.pixelError).toBeCloseTo(64 / (Width * Height));

    for (const run of after) {
      const image = await request(app).get(
        `/api/result/difference/openspace/group/test/hw1/${run.timeStamp}`
      );
      expect(image.status).toBe(200);
    }
  });
});
