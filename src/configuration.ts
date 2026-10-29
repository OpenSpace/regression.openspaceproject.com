/*****************************************************************************************
 *                                                                                       *
 * OpenSpace Visual Testing                                                              *
 *                                                                                       *
 * Copyright (c) 2024-2026                                                               *
 *                                                                                       *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this  *
 * software and associated documentation files (the "Software"), to deal in the Software *
 * without restriction, including without limitation the rights to use, copy, modify,    *
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to    *
 * permit persons to whom the Software is furnished to do so, subject to the following   *
 * conditions:                                                                           *
 *                                                                                       *
 * The above copyright notice and this permission notice shall be included in all copies *
 * or substantial portions of the Software.                                              *
 *                                                                                       *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,   *
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A         *
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT    *
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF  *
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE  *
 * OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                                         *
 ****************************************************************************************/

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { ProjectRoot } from './paths';
import { MaxImageDimension, NameSchema } from './validation';

/**
 * The repositories that are used for the commit links of the applications that are known
 * by default, if the configuration does not specify a repository.
 */
const DefaultRepositories: Record<string, string> = {
  openspace: 'https://github.com/OpenSpace/OpenSpace',
  sgct: 'https://github.com/SGCT/SGCT'
};

/**
 * The schema for an image size in pixels.
 */
const SizeSchema = z.object({
  width: z.number().int().min(1).max(MaxImageDimension),
  height: z.number().int().min(1).max(MaxImageDimension)
});

/**
 * The schema describing a single application in the configuration file.
 */
const ApplicationSchema = z
  .object({
    name: NameSchema,
    repository: z.url().optional(),
    imageSize: SizeSchema.nullable().optional()
  })
  .strict();

/**
 * The schema describing the structure of the main configuration file.
 */
const ConfigurationSchema = z
  .object({
    slack: z.object({
      token: z.string(),
      channel: z.string()
    }),
    comparisonThreshold: z.number().min(0).max(1),
    imageSize: SizeSchema,
    applications: z.array(ApplicationSchema).min(1).optional(),
    thumbnailScale: z.number().int().min(1),
    runners: z.array(z.string().min(1)),
    preferredHardware: z.array(z.string()).optional()
  })
  .strict();

/**
 * Settings that older versions read from the configuration file, together with the
 * explanation of what replaced them. The server refuses to start while one of them is
 * present, so that a value is never silently ignored.
 */
const RemovedSettings: Record<string, string> = {
  port: 'The port is set with PORT in the .env file.',
  data:
    'The test results are always stored in the "data" folder next to the ' +
    'configuration file.',
  adminToken: 'The admin token is set with ADMIN_TOKEN in the .env file.'
};

/**
 * Treats empty environment variables (for example `ADMIN_TOKEN=`) as if they were unset.
 */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

/**
 * Creates a schema for an optional environment variable that has to follow the `schema`.
 */
function optionalVariable<T extends z.ZodType>(schema: T) {
  return z.preprocess(emptyToUndefined, schema.optional());
}

/**
 * Schema for environment variables. Apart from the port, the variables are optional and
 * override the corresponding values from the configuration file.
 */
const EnvironmentSchema = z.object({
  PORT: z.coerce
    .number({ error: 'PORT must be set to a number in the .env file' })
    .int()
    .min(1)
    .max(65535),
  ADMIN_TOKEN: optionalVariable(z.string()),
  SLACK_TOKEN: optionalVariable(z.string()),
  SLACK_CHANNEL: optionalVariable(z.string()),
  CORS_ORIGINS: optionalVariable(z.string()),
  COMPARISON_THRESHOLD: optionalVariable(z.coerce.number().min(0).max(1)),
  IMAGE_WIDTH: optionalVariable(z.coerce.number().int().min(1).max(MaxImageDimension)),
  IMAGE_HEIGHT: optionalVariable(z.coerce.number().int().min(1).max(MaxImageDimension)),
  THUMBNAIL_SCALE: optionalVariable(z.coerce.number().int().min(1)),
  RATE_LIMIT_WINDOW_MS: optionalVariable(z.coerce.number().int().min(1000)),
  RATE_LIMIT_MAX_REQUESTS: optionalVariable(z.coerce.number().int().min(1))
});

/**
 * Formats the issues of a failed validation into a readable list.
 */
function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

class Configuration {
  constructor(configFile: string, env: z.infer<typeof EnvironmentSchema>) {
    if (!fs.existsSync(configFile)) {
      throw new Error(`Configuration file not found: ${configFile}`);
    }

    const data: unknown = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (typeof data === 'object' && data != null) {
      for (const [setting, replacement] of Object.entries(RemovedSettings)) {
        if (setting in data) {
          throw new Error(
            `The "${setting}" setting in ${configFile} is no longer supported. ` +
              `${replacement} Remove the setting to continue.`
          );
        }
      }
    }

    const res = ConfigurationSchema.safeParse(data);
    if (!res.success) {
      throw new Error(
        `Invalid configuration file ${configFile}:\n${formatIssues(res.error.issues)}`
      );
    }
    const config = res.data;

    // Use environment variables if set, otherwise use config file values
    this.port = env.PORT;
    this.slackToken = env.SLACK_TOKEN ?? config.slack.token;
    this.slackChannel = env.SLACK_CHANNEL ?? config.slack.channel;
    this.comparisonThreshold = env.COMPARISON_THRESHOLD ?? config.comparisonThreshold;
    const defaultSize = {
      width: env.IMAGE_WIDTH ?? config.imageSize.width,
      height: env.IMAGE_HEIGHT ?? config.imageSize.height
    };
    if (config.applications == null) {
      // No explicit application list: behave as a single-application server in which
      // all of the data belongs to the "openspace" application
      this.applications = [
        {
          name: 'openspace',
          repository: DefaultRepositories['openspace']!,
          size: defaultSize
        }
      ];
    } else {
      this.applications = config.applications.map((app) => ({
        name: app.name,
        repository: app.repository ?? DefaultRepositories[app.name] ?? null,
        // An explicit `null` disables the fixed image size for this application; an
        // omitted value inherits the top-level default size
        size: app.imageSize === undefined ? defaultSize : app.imageSize
      }));
    }
    this.thumbnailScale = env.THUMBNAIL_SCALE ?? config.thumbnailScale;
    this.adminToken = env.ADMIN_TOKEN ?? '';
    this.runners = config.runners;
    this.preferredHardware = config.preferredHardware ?? [];
    this.corsOrigins = env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0)
      : null;
    this.rateLimit = {
      windowMs: env.RATE_LIMIT_WINDOW_MS ?? 60 * 1000,
      maxRequests: env.RATE_LIMIT_MAX_REQUESTS ?? 120
    };
    this.thresholdFromEnvironment = env.COMPARISON_THRESHOLD !== undefined;
    this.path = configFile;

    if (this.adminToken.trim() === '') {
      throw new Error(
        'No admin token is configured. Set ADMIN_TOKEN in the .env file to a long, ' +
          'random value'
      );
    }
  }

  /// The port at which the server is available
  port: number;

  /// The token that is used to authenticate against Slack to be able to send messages
  slackToken: string;

  /// The channel ID to which messages are posted if a `slackToken` is provided
  slackChannel: string;

  /// The comparison threshold that the image comparison is using to detect changes
  comparisonThreshold: number;

  /// The applications that are allowed to submit tests. Each application has a name, the
  /// repository that the commit hashes refer to, and the image size that its images must
  /// have. A `null` size means that the application does not have a fixed image size; for
  /// those applications, the candidate images only need to match the size of the current
  /// reference image
  applications: {
    name: string;
    repository: string | null;
    size: { width: number; height: number } | null;
  }[];

  /**
   * Returns whether the provided application name is a valid application that is allowed
   * to submit tests to this server.
   *
   * @param name The name of the application to check
   * @returns `true` if the application is known to this server, `false` otherwise
   */
  hasApplication(name: string): boolean {
    return this.applications.some((app) => app.name === name);
  }

  /**
   * Returns the image size that the images of the provided application must have, or
   * `null` if the application does not have a fixed image size.
   *
   * @param name The name of the application for which to return the image size
   * @returns The image size of the application or `null` if it has no fixed size
   */
  applicationSize(name: string): { width: number; height: number } | null {
    const app = this.applications.find((a) => a.name === name);
    return app ? app.size : null;
  }

  /// The scaling factor by which the image is reduced to produce a thumbnail
  thumbnailScale: number;

  /// A token that has to be sent in the `Authorization` header to be able to perform
  /// administrative tasks. It is only read from the ADMIN_TOKEN environment variable
  adminToken: string;

  /// The list of ids for runners that are allowed to submit tests
  runners: string[];

  /// The list of hardware names that should be checked by default in the frontend
  preferredHardware: string[];

  /// The list of CORS origins that are allowed to access the API, or `null` if the API
  /// should only be accessible from the same origin
  corsOrigins: string[] | null;

  /// The settings for the rate limiting of the expensive API calls
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };

  /// Whether the comparison threshold was set through the environment, in which case it
  /// takes precedence over the value stored in the configuration file
  thresholdFromEnvironment: boolean;

  /// The path to where the configuration file lives
  path: string;
}

/**
 * Loads the configuration from both the .env file and the config.json. Environment
 * variables take precedence over config file values.
 *
 * @param configFile The path to the config.json file
 * @param envFile The path to the .env file. Variables that are already set in the
 *        environment are not overwritten by the file
 */
export function loadConfiguration(
  configFile = path.join(ProjectRoot, 'config.json'),
  envFile = path.join(ProjectRoot, '.env')
) {
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, quiet: true });
  }

  const env = EnvironmentSchema.safeParse(process.env);
  if (!env.success) {
    throw new Error(`Invalid environment variables:\n${formatIssues(env.error.issues)}`);
  }

  Config = new Configuration(configFile, env.data);
}

/**
 * Changes the comparison threshold and stores the new value in the configuration file.
 * Only the threshold is changed in the file; values that were provided through the
 * environment are never written to it. The file is replaced atomically, so that an
 * interrupted write cannot leave a broken configuration behind.
 *
 * @param threshold The new comparison threshold
 */
export function saveComparisonThreshold(threshold: number) {
  Config.comparisonThreshold = threshold;

  const data = JSON.parse(fs.readFileSync(Config.path, 'utf-8'));
  data.comparisonThreshold = threshold;
  const temporary = `${Config.path}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporary, Config.path);

  if (Config.thresholdFromEnvironment) {
    console.warn(
      'The comparison threshold is also set through COMPARISON_THRESHOLD, which will ' +
        'override the stored value when the server is restarted'
    );
  }
}

/**
 * The global configuration object that stores general configuration option that are used
 * in various places throughout the server.
 */
export let Config: Configuration;
