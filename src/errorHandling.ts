import { WebClient } from '@slack/web-api';
import { Config } from './configuration';
import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Slack client for sending notifications
 */
let slackClient: WebClient | null = null;

/**
 * Initialize Slack client if credentials are configured
 */
export function initializeErrorReporting(): void {
  if (Config.slackToken && Config.slackChannel) {
    try {
      slackClient = new WebClient(Config.slackToken);
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
      text: 'Error in OpenSpace Visual Testing',
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
  } catch (slackErr: any) {
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
  req: Request,
  res: Response,
  next: NextFunction
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
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
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