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
import Database from 'better-sqlite3';
import { Config } from './configuration';
import { TestData } from './testrecords';

const DB_PATH = path.join(Config.data, 'testresults.db');

/**
 * SQLite database connection singleton
 */
let dbInstance: Database.Database | null = null;

/**
 * Get or create the database connection
 */
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    if (!fs.existsSync(DB_PATH)) {
      // Create database with schema
      dbInstance = new Database(DB_PATH);
      createSchema(dbInstance);
    } else {
      dbInstance = new Database(DB_PATH);
    }
  }
  return dbInstance;
}

/**
 * Create the database schema
 */
function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_name TEXT NOT NULL,
      name TEXT NOT NULL,
      hardware TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      timing INTEGER NOT NULL,
      pixel_error REAL NOT NULL,
      relative_error REAL NOT NULL,
      difference_image_path TEXT,
      status TEXT NOT NULL,
      log_path TEXT,
      runner_id TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_group_name ON test_records(group_name);
    CREATE INDEX IF NOT EXISTS idx_name ON test_records(name);
    CREATE INDEX IF NOT EXISTS idx_hardware ON test_records(hardware);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON test_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_group_name_name ON test_records(group_name, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_record ON test_records(group_name, name, hardware, timestamp);
  `);
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
/**
 * Save test data to SQLite database
 */
export function saveTestDataSQLite(data: TestData): void {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO test_records 
    (group_name, name, hardware, timestamp, timing, pixel_error, relative_error, 
     difference_image_path, status, log_path, runner_id, commit_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    data.group,
    data.name,
    data.hardware,
    data.timestamp,
    data.timing,
    data.pixelError,
    data.relativeError,
    data.differenceImage,
    data.status,
    data.log,
    data.runnerID,
    data.commitHash,
    Date.now()
  );
}

/**
 * Get test records by group, name, and hardware
 */
export function getTestRecordsSQLite(group: string, name: string, hardware: string): TestData[] {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM test_records 
    WHERE group_name = ? AND name = ? AND hardware = ?
    ORDER BY timestamp DESC
  `);
  
  const rows = stmt.all(group, name, hardware) as any[];
  
  return rows.map(row => ({
    group: row.group_name,
    name: row.name,
    hardware: row.hardware,
    data: [{
      timestamp: row.timestamp,
      timing: row.timing,
      pixelError: row.pixel_error,
      relativeError: row.relative_error,
      differenceImage: row.difference_image_path,
      status: row.status,
      log: row.log_path,
      runnerID: row.runner_id,
      commitHash: row.commit_hash
    }]
  }));
}

/**
 * Get all test records from SQLite database
 */
export function getAllTestRecordsSQLite(): TestData[] {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM test_records 
    ORDER BY timestamp DESC
  `);
  
  const rows = stmt.all() as any[];
  
  // Group by group/name/hardware
  const recordsMap = new Map<string, TestData>();
  
  for (const row of rows) {
    const key = `${row.group_name}|${row.name}|${row.hardware}`;
    
    if (!recordsMap.has(key)) {
      recordsMap.set(key, {
        group: row.group_name,
        name: row.name,
        hardware: row.hardware,
        data: []
      });
    }
    
    recordsMap.get(key)!.data.push({
      timestamp: row.timestamp,
      timing: row.timing,
      pixelError: row.pixel_error,
      relativeError: row.relative_error,
      differenceImage: row.difference_image_path,
      status: row.status,
      log: row.log_path,
      runnerID: row.runner_id,
      commitHash: row.commit_hash
    });
  }
  
  return Array.from(recordsMap.values());
}
