import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Config, loadConfiguration } from '../src/configuration';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-config-'));
const configFile = path.join(folder, 'config.json');
const envFile = path.join(folder, 'missing.env');

const baseConfig = {
  slack: { token: '', channel: '' },
  comparisonThreshold: 0.1,
  imageSize: { width: 1920, height: 1080 },
  thumbnailScale: 6,
  runners: ['runner']
};

function load(config: Record<string, unknown>) {
  fs.writeFileSync(configFile, JSON.stringify(config));
  loadConfiguration(configFile, envFile);
}

beforeEach(() => {
  process.env['PORT'] = '8000';
  process.env['ADMIN_TOKEN'] = 'admin-token-from-env';
});

afterAll(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('the admin token', () => {
  it('is read from the ADMIN_TOKEN environment variable', () => {
    load(baseConfig);
    expect(Config.adminToken).toBe('admin-token-from-env');
  });

  it('is required', () => {
    process.env['ADMIN_TOKEN'] = '';
    expect(() => load(baseConfig)).toThrow(/ADMIN_TOKEN/);
    delete process.env['ADMIN_TOKEN'];
    expect(() => load(baseConfig)).toThrow(/ADMIN_TOKEN/);
  });

  it('cannot be set in the configuration file', () => {
    expect(() => load({ ...baseConfig, adminToken: 'token' })).toThrow(
      /"adminToken" setting .* ADMIN_TOKEN in the \.env file/
    );
  });
});

describe('settings of older versions', () => {
  it.each(['port', 'data'])('rejects the "%s" setting with an explanation', (setting) => {
    expect(() => load({ ...baseConfig, [setting]: 'value' })).toThrow(
      new RegExp(`"${setting}" setting .* no longer supported`)
    );
  });
});

describe('the Jenkins configuration', () => {
  const jenkins = {
    url: 'https://jenkins.test',
    job: 'image-testing',
    targets: [{ application: 'openspace', hardware: 'windows-nvidia', node: 'node' }]
  };

  afterEach(() => {
    delete process.env['JENKINS_USER'];
    delete process.env['JENKINS_TOKEN'];
  });

  it('enables reruns for the targets if the credentials are set', () => {
    process.env['JENKINS_USER'] = 'user';
    process.env['JENKINS_TOKEN'] = 'token';
    load({ ...baseConfig, jenkins: jenkins });
    expect(Config.jenkins?.user).toBe('user');
    expect(Config.jenkins?.token).toBe('token');
    expect(Config.rerunNode('openspace', 'windows-nvidia')).toBe('node');
    expect(Config.rerunNode('openspace', 'linux-nvidia')).toBeNull();
  });

  it('disables reruns without the credentials or the configuration', () => {
    process.env['JENKINS_USER'] = 'user';
    load({ ...baseConfig, jenkins: jenkins });
    expect(Config.jenkins).toBeNull();
    expect(Config.rerunNode('openspace', 'windows-nvidia')).toBeNull();

    process.env['JENKINS_TOKEN'] = 'token';
    load(baseConfig);
    expect(Config.jenkins).toBeNull();
  });

  it('rejects invalid node labels', () => {
    const target = { ...jenkins.targets[0], node: 'node && rm' };
    expect(() =>
      load({ ...baseConfig, jenkins: { ...jenkins, targets: [target] } })
    ).toThrow(/jenkins\.targets\.0\.node/);
  });
});

describe('the sample configuration', () => {
  it('is valid once the admin token is set', () => {
    const sample = fs.readFileSync(
      path.join(__dirname, '..', 'config.sample.json'),
      'utf-8'
    );
    load(JSON.parse(sample));
    expect(Config.applications.map((app) => app.name)).toEqual(['openspace', 'sgct']);
  });
});

describe('values that can only be set in the configuration file', () => {
  const variables = [
    'COMPARISON_THRESHOLD',
    'IMAGE_WIDTH',
    'IMAGE_HEIGHT',
    'THUMBNAIL_SCALE'
  ];

  afterEach(() => {
    variables.forEach((variable) => delete process.env[variable]);
    vi.restoreAllMocks();
  });

  it('ignores the old environment variables with a warning', () => {
    process.env['COMPARISON_THRESHOLD'] = '0.9';
    process.env['IMAGE_WIDTH'] = '640';
    process.env['IMAGE_HEIGHT'] = '480';
    process.env['THUMBNAIL_SCALE'] = '2';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    load(baseConfig);

    expect(Config.comparisonThreshold).toBe(0.1);
    expect(Config.applicationSize('openspace')).toEqual({ width: 1920, height: 1080 });
    expect(Config.thumbnailScale).toBe(6);
    for (const variable of variables) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(variable));
    }
  });
});
