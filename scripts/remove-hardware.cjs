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
 * Remove all tests for a specific hardware ID
 * Run with: node scripts/remove-hardware.cjs <hardware-id> [--dry-run]
 *   <hardware-id>: The hardware ID to remove tests for
 *   --dry-run: Show what would be deleted without actually deleting
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || 'data';

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Usage: node scripts/remove-hardware.cjs <hardware-id> [--dry-run]');
  console.error('');
  console.error('Example:');
  console.error('  node scripts/remove-hardware.cjs windows-amd');
  console.error('  node scripts/remove-hardware.cjs windows-amd --dry-run');
  process.exit(1);
}

const hardwareId = args[0];
const isDryRun = args.includes('--dry-run');

console.log(`Removing all tests for hardware: ${hardwareId}`);
console.log(`Data directory: ${DATA_DIR}`);
console.log(`Dry run: ${isDryRun}`);
console.log('');

const testsDir = path.join(DATA_DIR, 'tests', hardwareId);

if (!fs.existsSync(testsDir)) {
  console.log(`No tests found for hardware: ${hardwareId}`);
  console.log('Nothing to do.');
  process.exit(0);
}

// Count tests to be removed
let totalTests = 0;
let totalGroups = 0;
let totalSize = 0;

function countTests(dir) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);
    
    if (stat.isDirectory()) {
      if (itemPath === dir) continue;
      
      if (fs.existsSync(path.join(itemPath, 'data.json'))) {
        // This is a test run folder
        totalTests++;
        totalSize += stat.size;
      } else {
        // This might be a group or name folder
        countTests(itemPath);
      }
    } else {
      totalSize += stat.size;
    }
  }
}

console.log('Scanning tests...');
countTests(testsDir);

console.log(`Found ${totalTests} test runs`);
console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
console.log('');

if (isDryRun) {
  console.log('DRY RUN - No files will be deleted.');
  console.log('');
  console.log('To actually remove the tests, run without --dry-run:');
  console.log(`  node scripts/remove-hardware.cjs ${hardwareId}`);
} else {
  console.log('Removing test files...');
  
  // Remove all files in the hardware directory
  fs.rmSync(testsDir, { recursive: true, force: true });
  
  console.log('Test files removed successfully.');
  
  // Check if the tests directory is now empty
  const hardwareTestsDir = path.dirname(testsDir);
  const remainingHardware = fs.readdirSync(hardwareTestsDir);
  
  if (remainingHardware.length === 0) {
    fs.rmSync(hardwareTestsDir, { recursive: true, force: true });
    console.log('Empty hardware directory removed.');
  }
}

console.log('');
console.log('Done.');