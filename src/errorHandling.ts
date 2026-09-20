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

import { Client } from '@slack/web-api';
import { Config } from './configuration';

/**
 * Slack client for sending notifications
 */
let slackClient: Client | null = null;

/**
 * Initialize Slack client if credentials are configured
 */
export function initializeErrorReporting(): void {
  if (Config.slackToken && Config.slackChannel) {
    try {
      slackClient = new Client(Config.slackToken);
      console.log('Error reporting initialized with Slack integration');
    } catch (err) {
      console.error('Failed to initialize Slack client:', err);
    }
  }
}

/**
 * Send error notification to Slack if configured
 */
export async function sendErrorNotification(error: Error, context?: string): Promise<void> {
  if (!slackClient || !Config.slackChannel) {
    console.error(`[Error] ${context || 'Unspecified context'}: ${error.message}`);
    return;
  }

  try {
    const errorSummary = {
      text: '⚠️ Error in OpenSpace Visual Testing',
      attachments: [
        {
          color: 'danger',
          title: error.name || 'Error',
          text: error.message,
          fields: [
            {
              title: 'Context',
              value: context || 'Unspecified',
              short: true
            },
            {
              title: 'Timestamp',
              value: new Date().toISOString(),
              short: true
            }
          ]
        }
      ]
    };

    await slackClient.chat.postMessage({
      channel: Config.slackChannel,
      ...errorSummary
    });
    
    console.log('Error notification sent to Slack');
  } catch (slackErr) {
    console.error('Failed to send Slack notification:', slackErr);
    // Fallback to console logging
    console.error(`[Error] ${context || 'Unspecified context'}: ${error.message}`);
  }
}

/**
 * Error handler middleware for Express
 */
export function errorHandler(
  err: Error,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // Log the error
  console.error(`[${new Date().toISOString()}] Error in ${req.method} ${req.path}:`);
  console.error(err.message);
  console.error(err.stack);

  // Send error notification if configured
  sendErrorNotification(err, `${req.method} ${req.path}`);

  // Send error response
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Try-catch wrapper for async handlers
 */
export function asyncHandler(handler: express.RequestHandler): express.RequestHandler {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Validation error class for API validation failures
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Not found error class for missing resources
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}