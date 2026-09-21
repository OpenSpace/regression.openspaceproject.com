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
 * Run with: node scripts/migrate-to-sqlite.cjs [--remove-old]
 *   --remove-old: Remove old file structure after successful migration
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || 'data';
const DB_PATH = path.join(DATA_DIR, 'testresults.db');
const REMOVE_OLD = process.argv.includes('--remove-old');

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
      relative_error REAL,
      difference_image_path TEXT,
      status TEXT CHECK(status IN ('pass', 'fail')),
      log_path TEXT,
      commit_hash TEXT NOT NULL,
      reference_image TEXT NOT NULL,
      candidate_image INTEGER NOT NULL,
      difference_image INTEGER NOT NULL,
      n_errors INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(group_name, name, hardware, timestamp)
    );
    
    CREATE INDEX IF NOT EXISTS idx_group_name ON test_records(group_name);
    CREATE INDEX IF NOT EXISTS idx_name ON test_records(name);
    CREATE INDEX IF NOT EXISTS idx_hardware ON test_records(hardware);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON test_records(timestamp);
  `);
  
  // Add missing columns if they don't exist (for existing databases created before this update)
  const columns = db.pragma('table_info(test_records)');
  const columnNames = columns.map(c => c.name);
  const missingColumns = [
    'commit_hash', 'reference_image', 'candidate_image', 'difference_image', 'n_errors'
  ].filter(col => !columnNames.includes(col));
  
  for (const col of missingColumns) {
    console.log(`Adding missing column: ${col}`);
    if (col === 'commit_hash' || col === 'reference_image' || col === 'candidate_image' || col === 'difference_image') {
      db.exec(`ALTER TABLE test_records ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    } else if (col === 'n_errors') {
      db.exec(`ALTER TABLE test_records ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  
  // Read all test result JSON files
  const testsDir = path.join(DATA_DIR, 'tests');
  if (!fs.existsSync(testsDir)) {
    console.log('No test results directory found. Skipping migration.');
    process.exit(0);
  }
  
  // Recursively find all data.json files
  function findJsonFiles(dir, files = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findJsonFiles(fullPath, files);
      } else if (entry.isFile() && entry.name === 'data.json') {
        files.push(fullPath);
      }
    }
    return files;
  }
  
  const jsonFiles = findJsonFiles(testsDir);
  console.log(`Found ${jsonFiles.length} data.json files to migrate.`);
  
  let migratedCount = 0;
  let skippedCount = 0;
  
  // Prepare insert statement
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO test_records 
    (group_name, name, hardware, timestamp, timing, pixel_error, relative_error, 
     difference_image_path, status, log_path, commit_hash, reference_image, 
     candidate_image, difference_image, n_errors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const filePath of jsonFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const record = JSON.parse(content);
      
      // Extract path components from the file path
      // data/tests/<hardware>/<group>/<name>/<timestamp>/data.json
      const relPath = path.relative(testsDir, filePath);
      const parts = relPath.split(path.sep);
      
      if (parts.length < 5) {
        console.warn(`Skipping ${filePath}: unexpected path structure`);
        skippedCount++;
        continue;
      }
      
      const hardware = parts[0];
      const group = parts[1];
      const name = parts[2];
      const timestampStr = parts[3];
      
      // Parse timestamp: 20260407T084341145Z -> 2026-04-07T08:43:41.145Z
      const y = timestampStr.substring(0, 4);
      const m = timestampStr.substring(4, 6);
      const d = timestampStr.substring(6, 8);
      const H = timestampStr.substring(9, 11);
      const M = timestampStr.substring(11, 13);
      const S = timestampStr.substring(13, 15);
      const ms = timestampStr.substring(15, 18);
      const timestamp = new Date(`${y}-${m}-${d}T${H}:${M}:${S}.${ms}Z`).getTime();
      
      // Insert or replace the record
      // Convert candidateImage and differenceImage from date strings to Unix timestamps
      const candidateImageTimestamp = new Date(record.candidateImage).getTime();
      const differenceImageTimestamp = new Date(record.differenceImage).getTime();
      
      const result = insertStmt.run(
        group,
        name,
        hardware,
        timestamp,
        Math.round(record.timing * 1000), // Convert to milliseconds as per testrecords.ts
        record.pixelError,
        record.relativeError,
        record.differenceImage, // This is actually the image timestamp string
        record.nErrors === 0 ? 'pass' : 'fail',
        undefined, // log_path - not available in file
        record.commitHash,
        record.referenceImage,
        candidateImageTimestamp,
        differenceImageTimestamp,
        record.nErrors
      );
      
      migratedCount++;
    } catch (err) {
      console.error(`Error processing file ${filePath}:`, err.message);
      skippedCount++;
    }
  }
  
  console.log('');
  console.log('Migration complete!');
  console.log(`Successfully migrated: ${migratedCount} records`);
  console.log(`Skipped: ${skippedCount} files`);
  
  // Verify migration
  const count = db.prepare('SELECT COUNT(*) as count FROM test_records').get();
  console.log(`Total records in database: ${count.count}`);
  
  // Remove old files if --remove-old flag is set
  if (REMOVE_OLD) {
    console.log('');
    console.log('Removing old file structure...');
    try {
      const testsDir = path.join(DATA_DIR, 'tests');
      if (fs.existsSync(testsDir)) {
        fs.rmSync(testsDir, { recursive: true, force: true });
        console.log('Old file structure removed successfully.');
      } else {
        console.log('No old file structure found to remove.');
      }
    } catch (err) {
      console.error('Error removing old file structure:', err);
    }
  } else {
    console.log('');
    console.log('To remove old files after migration, run with --remove-old flag.');
  }
  
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  db.close();
  console.log('Database connection closed.');
}