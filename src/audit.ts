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
import path from 'path';

import { DataFolder } from './paths';

/**
 * The audit log is moved aside when the server starts and the file is larger than this
 * size (in bytes)
 */
const MaxAuditSize = 10 * 1024 * 1024;

/**
 * The path to the file that is used to store the audit data. If it does not exist, it
 * will be created. If it already exists, the new audit data will be appended at the end.
 */
let AuditPath: string;

/**
 * Adds the provided `text` to the audit log. The line will also contain the current date
 * and time. Line breaks are removed from the `text` so that every entry is a single line.
 *
 * @param text The line that should be added to the audit log
 */
export function printAudit(text: string) {
  const line = text.replace(/[\r\n]+/g, ' ');
  console.log(line);
  fs.appendFileSync(AuditPath, `${new Date().toISOString()}  ${line}\n`);
}

/**
 * Initializes the file containing the audit log. This will either create the file if it
 * does not exist, or add newlines to the existing file to separate the new audit messages
 * from previous runs. If the existing file has grown too large, it is renamed to include
 * the current date and a new file is started.
 */
export function initializeAudit() {
  AuditPath = path.join(DataFolder, 'audit.txt');
  const now = new Date().toISOString();

  if (fs.existsSync(AuditPath) && fs.statSync(AuditPath).size > MaxAuditSize) {
    const archive = `audit-${now.replace(/[-:.]/g, '')}.txt`;
    fs.renameSync(AuditPath, path.join(DataFolder, archive));
    fs.writeFileSync(
      AuditPath,
      `${now}  Creating file, previous entries are in ${archive}\n`
    );
  } else if (fs.existsSync(AuditPath)) {
    fs.appendFileSync(AuditPath, '\n\n');
  } else {
    fs.writeFileSync(AuditPath, `${now}  Creating file\n`);
  }

  printAudit('Starting testing server');
}
