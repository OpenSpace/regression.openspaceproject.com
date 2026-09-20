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

/**
 * Migration script: Convert from file-based storage to SQLite database
 * Run with: node scripts/migrate-to-sqlite.cjs
 */

import fs from 'fs';
import path from 'path';
import sqlite3 from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || 'data';
const DB_PATH = join(DATA_DIR, 'testresults.db');

console.log('Starting SQLite migration...');
console.log(`Data directory: ${DATA_DIR}`);
console.log(`Database path: ${DB_PATH}`);

// Create database connection
const db = sqlite3(DB_PATH);

try {
  // Create tables
  console.log('Creating tables...');
  
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
      log_path TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_group_name ON test_records(group_name);
    CREATE INDEX IF NOT EXISTS idx_name ON test_records(name);
    CREATE INDEX IF NOT EXISTS idx_hardware ON test_records(hardware);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON test_records(timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_record ON test_records(group_name, name, hardware, timestamp);
  `);
  
  // Read all test result JSON files
  const testsDir = join(DATA_DIR, 'tests');
  if (!fs.existsSync(testsDir)) {
    console.log('No test results directory found. Skipping migration.');
    process.exit(0);
  }
  
  const files = fs.readdirSync(testsDir);
  console.log(`Found ${files.length} test result files to migrate.`);
  
  let migratedCount = 0;
  let skippedCount = 0;
  
  // Prepare insert statement
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO test_records 
    (group_name, name, hardware, timestamp, timing, pixel_error, relative_error, 
     difference_image_path, status, log_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const file of files) {
    try {
      const filePath = join(testsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const record = JSON.parse(content);
      
      // Insert or replace the record
      const result = insertStmt.run(
        record.group,
        record.name,
        record.hardware,
        record.data[0].timestamp,
        record.data[0].timing,
        record.data[0].pixelError,
        record.data[0].relativeError,
        record.data[0].differenceImage,
        record.data[0].status,
        record.data[0].log
      );
      
      migratedCount++;
    } catch (err) {
      console.error(`Error processing file ${file}:`, err.message);
      skippedCount++;
    }
  }
  
  console.log('');
  console.log('Migration complete!');
  console.log(`Successfully migrated: ${migratedCount} records`);
  console.log(`Skipped: ${skippedCount} files`);
  
  // Verify migration
  const count = db.prepare('SELECT COUNT(*) as count FROM test_records').get() as { count: number };
  console.log(`Total records in database: ${count.count}`);
  
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  db.close();
  console.log('Database connection closed.');
}