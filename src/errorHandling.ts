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

import { retryPolicies, WebClient } from '@slack/web-api';
import { NextFunction, Request, Response } from 'express';
import multer from 'multer';

import { Config } from './configuration';
import { HttpError } from './errors';

/**
 * The client that sends notifications to Slack, or `null` if Slack is not configured
 */
let SlackClient: WebClient | null = null;

/**
 * The same message is sent to Slack at most once in this interval (in milliseconds)
 */
const RepeatInterval = 10 * 60 * 1000;

/**
 * The maximum number of messages that are sent to Slack in one hour
 */
const HourlyLimit = 20;

/**
 * The time at which each message was last sent to Slack
 */
const LastSent = new Map<string, number>();

/**
 * The times at which messages were sent to Slack within the last hour
 */
let SentTimes: number[] = [];

/**
 * Initializes the Slack client if the Slack integration is configured.
 */
export function initializeErrorReporting() {
  if (Config.slackToken && Config.slackChannel) {
    SlackClient = new WebClient(Config.slackToken, {
      retryConfig: retryPolicies.fiveRetriesInFiveMinutes
    });
    console.log('Error reporting initialized with Slack integration');
  }
}

/**
 * Reports a problem on the server. The message is always printed to the log and, if the
 * Slack integration is configured, also posted to the Slack channel. To prevent flooding
 * the channel, the same message is only posted once every 10 minutes and at most 20
 * messages are posted per hour. Failures to reach Slack are logged and never thrown.
 *
 * @param message The message describing the problem
 * @param context Optional information about where the problem happened
 */
export function reportError(message: string, context?: string) {
  const text = context ? `${context}: ${message}` : message;
  console.error(`[Error] ${text}`);

  if (SlackClient == null) {
    return;
  }

  const now = Date.now();
  for (const [key, time] of LastSent) {
    if (now - time >= RepeatInterval) {
      LastSent.delete(key);
    }
  }
  SentTimes = SentTimes.filter((time) => now - time < 60 * 60 * 1000);
  if (LastSent.has(message) || SentTimes.length >= HourlyLimit) {
    return;
  }
  LastSent.set(message, now);
  SentTimes.push(now);

  SlackClient.chat
    .postMessage({
      channel: Config.slackChannel,
      text: `Error in OpenSpace Visual Testing (${new Date().toISOString()})\n${text}`
    })
    .catch((err: unknown) => {
      console.error('Failed to send Slack notification:', err);
    });
}

/**
 * Returns the HTTP status code and the message that should be sent to the client for the
 * provided error. Only errors that are caused by the request reveal their message; for all
 * other errors, the client only receives a generic message.
 */
function classifyError(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) {
    return { status: err.status, message: err.message };
  }

  if (err instanceof multer.MulterError) {
    return { status: err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, message: err.message };
  }

  // Errors created by the body parsers and `res.sendFile` provide a status code and mark
  // whether their message can be shown to the client
  if (typeof err === 'object' && err != null && 'status' in err) {
    const { status } = err as { status: unknown };
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const expose = 'expose' in err && err.expose === true;
      const message = expose && err instanceof Error ? err.message : 'Bad request';
      return { status: status, message: message };
    }
  }

  return { status: 500, message: 'Internal Server Error' };
}

/**
 * The error handler middleware for Express. Errors caused by the request are answered
 * with their status code and message. All other errors are logged, reported, and answered
 * with a generic message so that no internal details reach the client.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { status, message } = classifyError(err);

  if (status >= 500) {
    console.error(
      `[${new Date().toISOString()}] Error in ${req.method} ${req.path}:`,
      err
    );
    reportError(
      err instanceof Error ? err.message : String(err),
      `${req.method} ${req.path}`
    );
  }

  if (res.headersSent) {
    // Let Express close the connection, as the response can no longer be changed
    next(err);
    return;
  }

  res.status(status).json({ error: message });
}
