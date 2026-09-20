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

import 'dotenv/config';
import fs from 'fs';
import { z } from 'zod';

/**
 * The schema describing the structure of the main configuration file.
 */
const ConfigurationSchema = z
  .object({
    port: z.number().int().min(1000).max(65535),
    slack: z.object({
      token: z.string(),
      channel: z.string()
    }),
    comparisonThreshold: z.number().min(0).max(1),
    imageSize: z.object({ width: z.number().min(1), height: z.number().min(1) }),
    thumbnailScale: z.number().min(1),
    adminToken: z.string().min(1),
    data: z.string().min(1),
    runners: z.array(z.string().min(1)),
    preferredHardware: z.array(z.string()).optional()
  })
  .strict();

/**
 * Schema for environment variables with fallbacks to config file values
 */
const EnvironmentSchema = z.object({
  PORT: z.string().transform((val) => parseInt(val, 10)).optional(),
  DATA_DIR: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  SLACK_TOKEN: z.string().optional(),
  SLACK_CHANNEL: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  COMPARISON_THRESHOLD: z.string().transform((val) => parseFloat(val)).optional(),
  IMAGE_WIDTH: z.string().transform((val) => parseInt(val, 10)).optional(),
  IMAGE_HEIGHT: z.string().transform((val) => parseInt(val, 10)).optional(),
  THUMBNAIL_SCALE: z.string().transform((val) => parseInt(val, 10)).optional(),
  RATE_LIMIT_WINDOW_MS: z.string().transform((val) => parseInt(val, 10)).optional(),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform((val) => parseInt(val, 10)).optional()
});

/**
 * Parsed environment variables
 */
let EnvConfig: z.infer<typeof EnvironmentSchema>;

/**
 * Loads environment configuration from .env file
 */
function loadEnvironmentConfig(): z.infer<typeof EnvironmentSchema> {
  const res = EnvironmentSchema.safeParse(process.env);
  
  if (!res.success) {
    console.error('Environment variable validation errors:', res.error.issues);
    process.exit(1);
  }
  
  return res.data;
}

class Configuration {
  constructor(configFile: string, envConfig: z.infer<typeof EnvironmentSchema>) {
    // Load config file first
    const data = JSON.parse(fs.readFileSync(configFile).toString());
    const res = ConfigurationSchema.safeParse(data);

    if (!res.success) {
      console.error('Configuration file validation errors:', res.error.issues);
      process.exit(1);
    }

    const config = res.data;
    
    // Use environment variables if set, otherwise use config file values
    this.port = envConfig.PORT ?? config.port;
    this.slackToken = envConfig.SLACK_TOKEN ?? config.slack.token;
    this.slackChannel = envConfig.SLACK_CHANNEL ?? config.slack.channel;
    this.comparisonThreshold = envConfig.COMPARISON_THRESHOLD ?? config.comparisonThreshold;
    this.size = {
      width: envConfig.IMAGE_WIDTH ?? config.imageSize.width,
      height: envConfig.IMAGE_HEIGHT ?? config.imageSize.height
    };
    this.thumbnailScale = envConfig.THUMBNAIL_SCALE ?? config.thumbnailScale;
    this.adminToken = envConfig.ADMIN_TOKEN ?? config.adminToken;
    this.data = envConfig.DATA_DIR ?? config.data;
    this.runners = config.runners;
    this.preferredHardware = config.preferredHardware ?? [];
    this.corsOrigins = envConfig.CORS_ORIGINS ?? '*';
    this.path = configFile;
  }

  /// The port at which the server is available
  port: number;

  /// The token that is used to authenticate against Slack to be able to send messages
  slackToken: string;

  /// The channel ID to which messages are posted if a `slackToken` is provided
  slackChannel: string;

  /// The comparison threshold that the image comparison is using to detect changes
  comparisonThreshold: number;

  /// The image size that all of the images must have
  size: {
    width: number;
    height: number;
  };

  /// The scaling factor by which the image is reduced to produce a thumbnail
  thumbnailScale: number;

  /// A token that has to be sent in the header to be able to invalidate references
  adminToken: string;

  /// The path to where the test result data and images are being stored
  data: string;

  /// The list of ids for runners that are allowed to submit tests
  runners: string[];

  /// The list of hardware names that should be checked by default in the frontend
  preferredHardware: string[];

  /// The list of CORS origins that are allowed to access the API
  corsOrigins: string;

  /// The path to where the configuration file lives
  path: string;
}

/**
 * Loads the configuration from both .env file and config.json.
 * Environment variables take precedence over config file values.
 *
 * @param path The path to the config.json file
 */
export function loadConfiguration(path: string) {
  EnvConfig = loadEnvironmentConfig();
  Config = new Configuration(path, EnvConfig);
}

/**
 * Updates the configuration file on disk that was used to originally load the global
 * configuration.
 */
export function saveConfiguration() {
  const config = {
    port: Config.port,
    slack: {
      token: Config.slackToken,
      channel: Config.slackChannel
    },
    comparisonThreshold: Config.comparisonThreshold,
    imageSize: Config.size,
    thumbnailScale: Config.thumbnailScale,
    adminToken: Config.adminToken,
    data: Config.data,
    runners: Config.runners
  };
  fs.writeFileSync(Config.path, JSON.stringify(config, null, 2));
}

/**
 * The global configuration object that stores general configuration option that are used
 * in various places throughout the server.
 */
export let Config: Configuration;
