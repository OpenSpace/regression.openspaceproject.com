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

import fs from 'fs';
import { z } from 'zod';

/**
 * Schema for config.json validation
 */
const ConfigSchema = z.object({
  port: z.number().int().min(1000).max(65535),
  slack: z.object({
    token: z.string(),
    channel: z.string()
  }),
  comparisonThreshold: z.number().min(0).max(1),
  imageSize: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1)
  }),
  thumbnailScale: z.number().int().min(1),
  adminToken: z.string().min(1),
  data: z.string().min(1),
  runners: z.array(z.string().min(1)),
  preferredHardware: z.array(z.string()).optional()
});

/**
 * Validates the configuration file
 * @param path Path to the configuration file
 * @returns The validated configuration object
 */
export function validateConfig(path: string): any {
  if (!fs.existsSync(path)) {
    throw new Error(`Configuration file not found: ${path}`);
  }

  try {
    const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
    const result = ConfigSchema.safeParse(data);

    if (!result.success) {
      const errors = result.error.issues.map((issue: any) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      }));

      console.error('Configuration validation errors:');
      errors.forEach((err: any) => {
        console.error(`  ${err.path}: ${err.message}`);
      });

      throw new Error('Configuration validation failed');
    }

    return result.data;
  } catch (err: any) {
    if (err.message.includes('Configuration validation failed')) {
      throw err;
    }
    throw new Error(`Failed to load configuration: ${err.message}`);
  }
}

/**
 * Validates environment variables against expected schema
 * @param env The environment object to validate
 * @returns The validated environment variables
 */
export function validateEnvironment(env: Record<string, string | undefined>): any {
  const envSchema = z.object({
    PORT: z.string().refine((val) => !isNaN(parseInt(val, 10)), {
      message: 'PORT must be a valid number'
    }),
    DATA_DIR: z.string().optional(),
    ADMIN_TOKEN: z.string().optional(),
    SLACK_TOKEN: z.string().optional(),
    SLACK_CHANNEL: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    COMPARISON_THRESHOLD: z.string().refine((val) => !isNaN(parseFloat(val)), {
      message: 'COMPARISON_THRESHOLD must be a valid number'
    }).optional(),
    IMAGE_WIDTH: z.string().refine((val) => !isNaN(parseInt(val, 10)), {
      message: 'IMAGE_WIDTH must be a valid number'
    }).optional(),
    IMAGE_HEIGHT: z.string().refine((val) => !isNaN(parseInt(val, 10)), {
      message: 'IMAGE_HEIGHT must be a valid number'
    }).optional(),
    THUMBNAIL_SCALE: z.string().refine((val) => !isNaN(parseInt(val, 10)), {
      message: 'THUMBNAIL_SCALE must be a valid number'
    }).optional()
  });

  const result = envSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.issues.map((issue: any) => ({
      key: issue.path[0],
      message: issue.message
    }));

    console.error('Environment variable validation errors:');
    errors.forEach((err: any) => {
      console.error(`  ${err.key}: ${err.message}`);
    });

    throw new Error('Environment variable validation failed');
  }

  return result.data;
}
/**
 * Validates that required paths exist
 * @param data The data path to validate
 */
export function validatePaths(data: string): void {
  if (!fs.existsSync(data)) {
    console.warn(`Data directory does not exist: ${data}`);
    console.warn('Creating data directory...');
    fs.mkdirSync(data, { recursive: true });
  }

  const testsDir = `${data}/tests`;
  if (!fs.existsSync(testsDir)) {
    fs.mkdirSync(testsDir, { recursive: true });
  }

  const referenceDir = `${data}/reference`;
  if (!fs.existsSync(referenceDir)) {
    fs.mkdirSync(referenceDir, { recursive: true });
  }

  const temporaryDir = `${data}/temporary`;
  if (!fs.existsSync(temporaryDir)) {
    fs.mkdirSync(temporaryDir, { recursive: true });
  }
}

/**
 * Validates runner IDs against configuration
 * @param runnerId The runner ID to validate
 * @param allowedRunners The list of allowed runner IDs
 */
export function validateRunner(runnerId: string, allowedRunners: string[]): void {
  if (!runnerId || runnerId.length === 0) {
    throw new Error("Runner ID is required");
  }

  if (!allowedRunners.includes(runnerId)) {
    throw new Error(`Runner ID "${runnerId}" is not authorized`);
  }
}

/**
 * Validates test result data structure
 * @param data The test data to validate
 */
export function validateTestData(data: any): void {
  const testDataSchema = z.object({
    group: z.string().min(1),
    name: z.string().min(1),
    hardware: z.string().min(1),
    timestamp: z.number(),
    timing: z.number().min(0),
    pixelError: z.number().min(0),
    relativeError: z.number().min(0),
    status: z.string().min(1)
  });

  const result = testDataSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((issue: any) => ({
      path: issue.path.join("."),
      message: issue.message
    }));

    throw new Error(`Test data validation failed: ${errors.map((e: any) => e.message).join(", ")}`);
  }
}
