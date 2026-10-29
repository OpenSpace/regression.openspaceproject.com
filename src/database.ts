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

import Database from 'better-sqlite3';
import fs from 'fs';

import { printAudit } from './audit';
import { DataFolder } from './paths';
import type { TestData, TestRecord } from './testrecords';

/**
 * The version of the database schema. It is stored in the `user_version` of the database
 * and has to be increased whenever the schema changes.
 */
const SchemaVersion = 1;

/**
 * The database schema. The `timestamp`, `candidate_image`, and `difference_image` columns
 * are stored as milliseconds since the Unix epoch. The `candidate_image` and
 * `difference_image` columns contain the timestamp of the test run in whose folder the
 * respective image is stored. The `candidate_hash` and `difference_hash` columns contain
 * the `pixelHash` of the respective image and are used to find identical images. They are
 * `NULL` for test runs that were migrated from the file-based storage until the server has
 * computed them at startup. Keep this in sync with the schema in
 * scripts/1-migrate_to_sqlite.py
 */
const Schema = `
CREATE TABLE IF NOT EXISTS test_runs (
  id               INTEGER PRIMARY KEY,
  application      TEXT    NOT NULL,
  hardware         TEXT    NOT NULL,
  group_name       TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  timestamp        INTEGER NOT NULL,
  pixel_error      REAL    NOT NULL,
  timing           REAL    NOT NULL,
  n_errors         INTEGER NOT NULL,
  commit_hash      TEXT    NOT NULL,
  reference_image  TEXT    NOT NULL,
  candidate_image  INTEGER NOT NULL,
  difference_image INTEGER NOT NULL,
  log              TEXT    NOT NULL,
  candidate_hash   TEXT,
  difference_hash  TEXT,
  UNIQUE (application, hardware, group_name, name, timestamp)
);

CREATE TABLE IF NOT EXISTS reference_pointers (
  application     TEXT NOT NULL,
  hardware        TEXT NOT NULL,
  group_name      TEXT NOT NULL,
  name            TEXT NOT NULL,
  reference_image TEXT NOT NULL,
  PRIMARY KEY (application, hardware, group_name, name)
) WITHOUT ROWID;
`;

/**
 * The indices that are used to find identical images. They are created separately from
 * the tables, as the hash columns might have to be added to an existing table first.
 */
const Indices = `
CREATE INDEX IF NOT EXISTS test_runs_candidate_hash
  ON test_runs (application, hardware, group_name, name, candidate_hash);
CREATE INDEX IF NOT EXISTS test_runs_difference_hash
  ON test_runs (application, hardware, group_name, name, difference_hash);
`;

/**
 * The kinds of images whose hashes are stored in the database
 */
export type HashedImage = 'candidate' | 'difference';

/**
 * The columns of the `test_runs` table that are needed to create a TestData object
 */
const RunColumns = `
  application, hardware, group_name, name, timestamp, pixel_error, timing, n_errors,
  commit_hash, reference_image, candidate_image, difference_image
`;

/**
 * The SQL condition that identifies a single test, using named parameters
 */
const TestCondition = `
  application = @application AND hardware = @hardware AND group_name = @group_name AND
  name = @name
`;

/**
 * The named parameters that identify a single test
 */
type TestKey = {
  application: string;
  hardware: string;
  group_name: string;
  name: string;
};

/**
 * A row of the `test_runs` table as it is returned by queries that select `RunColumns`
 */
type TestRunRow = TestKey & {
  timestamp: number;
  pixel_error: number;
  timing: number;
  n_errors: number;
  commit_hash: string;
  reference_image: string;
  candidate_image: number;
  difference_image: number;
};

/**
 * The named parameters for the hashes of the candidate and difference images
 */
type ImageHashes = {
  candidate_hash: string;
  difference_hash: string;
};

/**
 * The values that identify a single test
 */
export type TestKeyParts = {
  application: string;
  group: string;
  name: string;
  hardware: string;
};

/**
 * A single test run together with the test it belongs to
 */
export type TestRun = {
  application: string;
  group: string;
  name: string;
  hardware: string;
  data: TestData;
};

/**
 * A reference pointer that names the currently active reference image of a test
 */
export type ReferencePointer = {
  application: string;
  group: string;
  name: string;
  hardware: string;
  referenceImage: string;
};

/**
 * Creates all of the prepared statements that are used to access the database.
 *
 * @param db The database for which the statements are prepared
 * @returns The prepared statements
 */
function prepareStatements(db: Database.Database) {
  return {
    insertRun: db.prepare<TestRunRow & ImageHashes & { log: string }>(`
      INSERT INTO test_runs (${RunColumns}, log, candidate_hash, difference_hash)
      VALUES (
        @application, @hardware, @group_name, @name, @timestamp, @pixel_error, @timing,
        @n_errors, @commit_hash, @reference_image, @candidate_image, @difference_image, @log,
        @candidate_hash, @difference_hash
      )
    `),
    runExists: db.prepare<TestKey & { timestamp: number }, { found: number }>(`
      SELECT 1 AS found FROM test_runs WHERE ${TestCondition} AND timestamp = @timestamp
    `),
    latestRun: db.prepare<TestKey & { before: number }, TestRunRow>(`
      SELECT ${RunColumns} FROM test_runs
      WHERE ${TestCondition} AND timestamp <= @before
      ORDER BY timestamp DESC LIMIT 1
    `),
    runLog: db.prepare<TestKey & { timestamp: number }, { log: string }>(`
      SELECT log FROM test_runs WHERE ${TestCondition} AND timestamp = @timestamp
    `),
    updateRun: db.prepare<
      Omit<TestRunRow, 'timing' | 'n_errors' | 'commit_hash'> & {
        difference_hash: string;
      }
    >(`
      UPDATE test_runs SET
        pixel_error = @pixel_error, reference_image = @reference_image,
        candidate_image = @candidate_image, difference_image = @difference_image,
        difference_hash = @difference_hash
      WHERE ${TestCondition} AND timestamp = @timestamp
    `),
    candidateByHash: db.prepare<TestKey & { hash: string }, { owner: number }>(`
      SELECT candidate_image AS owner FROM test_runs
      WHERE ${TestCondition} AND candidate_hash = @hash
      ORDER BY candidate_image LIMIT 1
    `),
    differenceByHash: db.prepare<TestKey & { hash: string }, { owner: number }>(`
      SELECT difference_image AS owner FROM test_runs
      WHERE ${TestCondition} AND difference_hash = @hash
      ORDER BY difference_image LIMIT 1
    `),
    candidatesWithoutHash: db.prepare<[], TestKey & { owner: number }>(`
      SELECT DISTINCT application, hardware, group_name, name, candidate_image AS owner
      FROM test_runs WHERE candidate_hash IS NULL
    `),
    differencesWithoutHash: db.prepare<[], TestKey & { owner: number }>(`
      SELECT DISTINCT application, hardware, group_name, name, difference_image AS owner
      FROM test_runs WHERE difference_hash IS NULL
    `),
    setCandidateHash: db.prepare<TestKey & { owner: number; hash: string }>(`
      UPDATE test_runs SET candidate_hash = @hash
      WHERE ${TestCondition} AND candidate_image = @owner
    `),
    setDifferenceHash: db.prepare<TestKey & { owner: number; hash: string }>(`
      UPDATE test_runs SET difference_hash = @hash
      WHERE ${TestCondition} AND difference_image = @owner
    `),
    allTests: db.prepare<[], TestKey>(`
      SELECT DISTINCT application, hardware, group_name, name FROM test_runs
      ORDER BY application, hardware, group_name, name
    `),
    allRuns: db.prepare<[], TestRunRow>(`
      SELECT ${RunColumns} FROM test_runs
      ORDER BY application, hardware, group_name, name, timestamp
    `),
    latestRuns: db.prepare<{ count: number }, TestRunRow>(`
      SELECT ${RunColumns} FROM (
        SELECT ${RunColumns}, ROW_NUMBER() OVER (
          PARTITION BY application, hardware, group_name, name ORDER BY timestamp DESC
        ) AS position
        FROM test_runs
      )
      WHERE position <= @count
      ORDER BY application, hardware, group_name, name, timestamp
    `),
    history: db.prepare<TestKey, TestRunRow>(`
      SELECT ${RunColumns} FROM test_runs WHERE ${TestCondition} ORDER BY timestamp
    `),
    referencePointer: db.prepare<TestKey, { reference_image: string }>(`
      SELECT reference_image FROM reference_pointers WHERE ${TestCondition}
    `),
    setReferencePointer: db.prepare<TestKey & { reference_image: string }>(`
      INSERT INTO reference_pointers (application, hardware, group_name, name, reference_image)
      VALUES (@application, @hardware, @group_name, @name, @reference_image)
      ON CONFLICT (application, hardware, group_name, name) DO UPDATE SET
        reference_image = excluded.reference_image
    `),
    allReferencePointers: db.prepare<[], TestKey & { reference_image: string }>(`
      SELECT application, hardware, group_name, name, reference_image
      FROM reference_pointers
      ORDER BY application, hardware, group_name, name
    `)
  };
}

/**
 * The connection to the database. It is created in the `openDatabase` function
 */
let DB: Database.Database;

/**
 * The prepared statements used to access the database. They are created in the
 * `openDatabase` function
 */
let Statements: ReturnType<typeof prepareStatements>;

/**
 * Returns whether the folder or any of its subfolders contains a file with one of the
 * provided `names`.
 *
 * @param folder The folder that should be searched
 * @param names The file names that are searched for
 * @returns `true` if any of the files was found, `false` otherwise
 */
function containsFile(folder: string, names: string[]): boolean {
  if (!fs.existsSync(folder)) {
    return false;
  }

  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && names.includes(entry.name)) {
      return true;
    }
    if (entry.isDirectory() && containsFile(`${folder}/${entry.name}`, names)) {
      return true;
    }
  }
  return false;
}

/**
 * Opens the database that stores the test runs, their logs, and the reference pointers.
 * If the database does not exist yet, it is created. If the data folder still contains
 * the files from before the database was introduced, the database is not created and an
 * error is thrown instead, as the data has to be migrated first.
 */
export function openDatabase() {
  const path = `${DataFolder}/testresults.db`;

  if (!fs.existsSync(path)) {
    const hasLegacyFiles =
      containsFile(`${DataFolder}/tests`, ['data.json', 'log.txt']) ||
      containsFile(`${DataFolder}/reference`, ['ref.txt']);
    if (hasLegacyFiles) {
      throw new Error(
        `The data folder contains test results, but no database (${path}). Stop the ` +
          'server and run scripts/1-migrate_to_sqlite.py to move the test results into ' +
          'the database.'
      );
    }

    printAudit(`Creating database ${path}`);
  }

  DB = new Database(path);
  DB.pragma('journal_mode = WAL');
  DB.exec(Schema);

  const version = DB.pragma('user_version', { simple: true });
  if (version == 0) {
    DB.pragma(`user_version = ${SchemaVersion}`);
  } else if (version != SchemaVersion) {
    throw new Error(`Unsupported database schema version ${version} in ${path}`);
  }

  // Databases that were created before the image hashes were introduced do not have the
  // hash columns yet
  const columns = DB.prepare<[], { name: string }>(`PRAGMA table_info(test_runs)`)
    .all()
    .map((column) => column.name);
  for (const column of ['candidate_hash', 'difference_hash']) {
    if (!columns.includes(column)) {
      printAudit(`Adding column ${column} to the database`);
      DB.exec(`ALTER TABLE test_runs ADD COLUMN ${column} TEXT`);
    }
  }
  DB.exec(Indices);

  Statements = prepareStatements(DB);
}

/**
 * Closes the database. This writes all outstanding changes from the write-ahead log into
 * the database file. No other function of this file can be called afterwards.
 */
export function closeDatabase() {
  if (DB != null && DB.open) {
    DB.close();
  }
}

/**
 * Checks whether the database can be queried.
 *
 * @returns `true` if the database is open and answers queries, `false` otherwise
 */
export function databaseIsHealthy(): boolean {
  try {
    return DB.prepare<[], { ok: number }>('SELECT 1 AS ok').get()?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * Runs the provided function inside a single database transaction. If the function
 * throws, none of the changes made inside the function are stored.
 *
 * @param fn The function that should be run inside the transaction
 * @returns The value returned by the function
 */
export function inTransaction<T>(fn: () => T): T {
  return DB.transaction(fn)();
}

/**
 * Creates the named parameters that identify a single test.
 */
function testKey(
  application: string,
  group: string,
  name: string,
  hardware: string
): TestKey {
  return { application: application, hardware: hardware, group_name: group, name: name };
}

/**
 * Converts a row of the `test_runs` table into a TestData object.
 */
function toTestData(row: TestRunRow): TestData {
  return {
    pixelError: row.pixel_error,
    timeStamp: new Date(row.timestamp),
    timing: row.timing,
    nErrors: row.n_errors,
    commitHash: row.commit_hash,
    referenceImage: row.reference_image,
    candidateImage: new Date(row.candidate_image),
    differenceImage: new Date(row.difference_image)
  };
}

/**
 * Converts a row of the `test_runs` table into a TestRun object.
 */
function toTestRun(row: TestRunRow): TestRun {
  return {
    application: row.application,
    group: row.group_name,
    name: row.name,
    hardware: row.hardware,
    data: toTestData(row)
  };
}

/**
 * Collects consecutive rows that belong to the same test into a single TestRecord. The
 * rows have to be sorted by test and timestamp.
 */
function toTestRecords(rows: TestRunRow[]): TestRecord[] {
  const records: TestRecord[] = [];
  let current: TestRecord | null = null;
  for (const row of rows) {
    if (
      current == null ||
      current.application != row.application ||
      current.group != row.group_name ||
      current.name != row.name ||
      current.hardware != row.hardware
    ) {
      current = {
        application: row.application,
        group: row.group_name,
        name: row.name,
        hardware: row.hardware,
        data: []
      };
      records.push(current);
    }
    current.data.push(toTestData(row));
  }
  return records;
}

/**
 * Stores a new test run. A test run with the same timestamp must not exist for the test
 * yet; use `testRunExists` to check that beforehand.
 *
 * @param application The name of the application that generated the test run
 * @param group The name of the group to which the test run belongs
 * @param name The name of the test to which the test run belongs
 * @param hardware The hardware on which the test was run
 * @param data The results of the test run
 * @param log The contents of the log file of the test run
 * @param hashes The `pixelHash` values of the candidate and the difference image
 */
export function insertTestRun(
  application: string,
  group: string,
  name: string,
  hardware: string,
  data: TestData,
  log: string,
  hashes: { candidate: string; difference: string }
) {
  Statements.insertRun.run({
    ...testKey(application, group, name, hardware),
    timestamp: data.timeStamp.getTime(),
    pixel_error: data.pixelError,
    timing: data.timing,
    n_errors: data.nErrors,
    commit_hash: data.commitHash,
    reference_image: data.referenceImage,
    candidate_image: data.candidateImage.getTime(),
    difference_image: data.differenceImage.getTime(),
    log: log,
    candidate_hash: hashes.candidate,
    difference_hash: hashes.difference
  });
}

/**
 * Returns whether a test run exists for the test identified by `application`, `group`,
 * `name`, and `hardware` at exactly the provided `timestamp`.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param timestamp The timestamp of the test run
 * @returns `true` if the test run exists, `false` otherwise
 */
export function testRunExists(
  application: string,
  group: string,
  name: string,
  hardware: string,
  timestamp: Date
): boolean {
  const row = Statements.runExists.get({
    ...testKey(application, group, name, hardware),
    timestamp: timestamp.getTime()
  });
  return row != null;
}

/**
 * Returns the latest test run for the test identified by `application`, `group`, `name`,
 * and `hardware`. If the `before` date is provided, the latest test run at or before that
 * date is returned instead.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param before If provided, only test runs at or before this date are considered
 * @returns The results of the test run or `null` if no such test run exists
 */
export function latestTestRun(
  application: string,
  group: string,
  name: string,
  hardware: string,
  before?: Date
): TestData | null {
  const row = Statements.latestRun.get({
    ...testKey(application, group, name, hardware),
    before: before ? before.getTime() : Number.MAX_SAFE_INTEGER
  });
  return row ? toTestData(row) : null;
}

/**
 * Returns the log of the test run identified by `application`, `group`, `name`,
 * `hardware`, and `timestamp`.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param timestamp The timestamp of the test run
 * @returns The contents of the log or `null` if no such test run exists
 */
export function testRunLog(
  application: string,
  group: string,
  name: string,
  hardware: string,
  timestamp: Date
): string | null {
  const row = Statements.runLog.get({
    ...testKey(application, group, name, hardware),
    timestamp: timestamp.getTime()
  });
  return row ? row.log : null;
}

/**
 * Updates the results of an existing test run, which is identified by the timestamp of
 * the provided `data`. The pixel error, the reference image, the candidate image, and the
 * difference image are updated; all other values of the test run stay unchanged.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param data The new results of the test run
 * @param differenceHash The `pixelHash` of the new difference image
 */
export function updateTestRun(
  application: string,
  group: string,
  name: string,
  hardware: string,
  data: TestData,
  differenceHash: string
) {
  Statements.updateRun.run({
    ...testKey(application, group, name, hardware),
    timestamp: data.timeStamp.getTime(),
    pixel_error: data.pixelError,
    reference_image: data.referenceImage,
    candidate_image: data.candidateImage.getTime(),
    difference_image: data.differenceImage.getTime(),
    difference_hash: differenceHash
  });
}

/**
 * Searches the test identified by `application`, `group`, `name`, and `hardware` for a
 * candidate or difference image with the provided `pixelHash`.
 *
 * @param kind Whether a candidate or a difference image is searched
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param hash The `pixelHash` of the image that is searched
 * @returns The timestamp of the test run in whose folder the image is stored or `null` if
 *          the test does not use an image with this hash
 */
export function findImageByHash(
  kind: HashedImage,
  application: string,
  group: string,
  name: string,
  hardware: string,
  hash: string
): Date | null {
  const statement =
    kind == 'candidate' ? Statements.candidateByHash : Statements.differenceByHash;
  const row = statement.get({
    ...testKey(application, group, name, hardware),
    hash: hash
  });
  return row ? new Date(row.owner) : null;
}

/**
 * Returns all candidate or difference images for which no hash has been stored yet.
 *
 * @param kind Whether the candidate or the difference images are returned
 * @returns The test and the timestamp of the test run in whose folder each image is stored
 */
export function imagesWithoutHash(kind: HashedImage): (TestKeyParts & { owner: Date })[] {
  const statement =
    kind == 'candidate'
      ? Statements.candidatesWithoutHash
      : Statements.differencesWithoutHash;
  return statement.all().map((row) => ({
    application: row.application,
    group: row.group_name,
    name: row.name,
    hardware: row.hardware,
    owner: new Date(row.owner)
  }));
}

/**
 * Stores the hash of a candidate or difference image for all test runs that use it.
 *
 * @param kind Whether the hash belongs to a candidate or a difference image
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param owner The timestamp of the test run in whose folder the image is stored
 * @param hash The `pixelHash` of the image
 */
export function setImageHash(
  kind: HashedImage,
  application: string,
  group: string,
  name: string,
  hardware: string,
  owner: Date,
  hash: string
) {
  const statement =
    kind == 'candidate' ? Statements.setCandidateHash : Statements.setDifferenceHash;
  statement.run({
    ...testKey(application, group, name, hardware),
    owner: owner.getTime(),
    hash: hash
  });
}

/**
 * Returns all tests for which at least one test run exists.
 *
 * @returns The application, group, name, and hardware of every test
 */
export function allTests(): TestKeyParts[] {
  return Statements.allTests.all().map((row) => ({
    application: row.application,
    group: row.group_name,
    name: row.name,
    hardware: row.hardware
  }));
}

/**
 * Returns all test runs, sorted by test and timestamp.
 *
 * @returns All test runs that are stored in the database
 */
export function allTestRuns(): TestRun[] {
  return Statements.allRuns.all().map(toTestRun);
}

/**
 * Returns a record for each test that contains only the latest `count` test runs.
 *
 * @param count The maximum number of test runs that are returned for each test
 * @returns The test records containing the latest test runs, sorted by timestamp
 */
export function latestTestRecords(count: number): TestRecord[] {
  return toTestRecords(Statements.latestRuns.all({ count: count }));
}

/**
 * Returns all test runs for the test identified by `application`, `group`, `name`, and
 * `hardware`, sorted by timestamp.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @returns All test runs of the test, which might be empty if the test does not exist
 */
export function testHistory(
  application: string,
  group: string,
  name: string,
  hardware: string
): TestData[] {
  return Statements.history
    .all(testKey(application, group, name, hardware))
    .map(toTestData);
}

/**
 * Returns the file name of the currently active reference image for the test identified
 * by `application`, `group`, `name`, and `hardware`.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @returns The file name of the reference image or `null` if there is none
 */
export function referencePointer(
  application: string,
  group: string,
  name: string,
  hardware: string
): string | null {
  const row = Statements.referencePointer.get(
    testKey(application, group, name, hardware)
  );
  return row ? row.reference_image : null;
}

/**
 * Sets the currently active reference image for the test identified by `application`,
 * `group`, `name`, and `hardware`.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param referenceImage The file name of the new reference image
 */
export function setReferencePointer(
  application: string,
  group: string,
  name: string,
  hardware: string,
  referenceImage: string
) {
  Statements.setReferencePointer.run({
    ...testKey(application, group, name, hardware),
    reference_image: referenceImage
  });
}

/**
 * Returns all reference pointers.
 *
 * @returns All reference pointers that are stored in the database
 */
export function allReferencePointers(): ReferencePointer[] {
  return Statements.allReferencePointers.all().map((row) => ({
    application: row.application,
    group: row.group_name,
    name: row.name,
    hardware: row.hardware,
    referenceImage: row.reference_image
  }));
}
