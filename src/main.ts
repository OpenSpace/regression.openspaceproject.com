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
import http from 'http';
import path from 'path';

import { createApp } from './app';
import { initializeAudit, printAudit } from './audit';
import { Config, loadConfiguration } from './configuration';
import { closeDatabase, openDatabase } from './database';
import { initializeErrorReporting } from './errorHandling';
import { TestLocks } from './lock';
import { DataFolder } from './paths';
import { backfillImageHashes, stopRegeneration, verifyDataFolder } from './testrecords';

/**
 * The time (in milliseconds) that the server waits for running operations to finish when
 * it is shut down
 */
const ShutdownTimeout = 30 * 1000;

/**
 * Stops the server once all running operations have finished, closes the database, and
 * exits the process.
 *
 * @param server The HTTP server that should be stopped
 * @param signal The signal that caused the shutdown
 */
async function shutdown(server: http.Server, signal: string) {
  printAudit(`Received ${signal}, shutting down`);
  stopRegeneration();
  server.close();

  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), ShutdownTimeout).unref()
  );
  const finished = await Promise.race([TestLocks.idle().then(() => true), timeout]);
  if (!finished) {
    console.error('Running operations did not finish in time');
  }

  closeDatabase();
  process.exit(finished ? 0 : 1);
}

export async function main() {
  try {
    loadConfiguration();

    // Create the data folder infrastructure
    fs.mkdirSync(path.join(DataFolder, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(DataFolder, 'reference'), { recursive: true });

    initializeErrorReporting();
    initializeAudit();
    openDatabase();
    verifyDataFolder();
    await backfillImageHashes();

    const server = http.createServer(createApp());
    server.on('error', (err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
    server.listen(Config.port, () => {
      console.log(`Listening on port: ${Config.port}`);
    });

    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        shutdown(server, signal);
      });
    }
  } catch (err: unknown) {
    console.error('Failed to start server:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Allow running this file directly (e.g. `ts-node src/main.ts` via `npm run
// dev:server`). index.cjs imports this module and calls main() itself, so the
// guard prevents a double start in that case.
if (require.main === module) {
  main();
}
