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
import type { TestData, TestImage, TestRecord } from './testrecords';

/**
 * The version of the database schema. It is stored in the `user_version` of the database
 * and has to be increased whenever the schema changes.
 */
const SchemaVersion = 2;

/**
 * The database schema. The `test_runs` table contains the values that apply to a whole
 * test run and the `test_run_images` table contains one row for each image of a test run,
 * which are numbered starting at 1. The `timestamp`, `candidate_image`, and
 * `difference_image` columns are stored as milliseconds since the Unix epoch. The
 * `candidate_image` and `difference_image` columns contain the timestamp of the test run
 * in whose folder the respective image is stored. The `candidate_hash` and
 * `difference_hash` columns contain the `pixelHash` of the respective image and are used to
 * find identical images. They are `NULL` for test runs that were migrated from the
 * file-based storage until the server has computed them at startup. Databases of earlier
 * versions are upgraded by scripts/2-migrate_to_multiple_images.py
 */
const Schema = `
CREATE TABLE IF NOT EXISTS test_runs (
  id              INTEGER PRIMARY KEY,
  application     TEXT    NOT NULL,
  hardware        TEXT    NOT NULL,
  group_name      TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  timestamp       INTEGER NOT NULL,
  timing          REAL    NOT NULL,
  n_errors        INTEGER NOT NULL,
  commit_hash     TEXT    NOT NULL,
  reference_image TEXT    NOT NULL,
  log             TEXT    NOT NULL,
  UNIQUE (application, hardware, group_name, name, timestamp)
);

CREATE TABLE IF NOT EXISTS test_run_images (
  run_id           INTEGER NOT NULL REFERENCES test_runs (id) ON DELETE CASCADE,
  image            INTEGER NOT NULL,
  pixel_error      REAL    NOT NULL,
  candidate_image  INTEGER NOT NULL,
  difference_image INTEGER NOT NULL,
  candidate_hash   TEXT,
  difference_hash  TEXT,
  PRIMARY KEY (run_id, image)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS test_run_images_candidate_hash
  ON test_run_images (candidate_hash);
CREATE INDEX IF NOT EXISTS test_run_images_difference_hash
  ON test_run_images (difference_hash);

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
 * The kinds of images whose hashes are stored in the database
 */
export type HashedImage = 'candidate' | 'difference';

/**
 * The columns of the `test_runs` table that are needed to create a TestData object
 */
const RunColumns = `
  id, application, hardware, group_name, name, timestamp, timing, n_errors, commit_hash,
  reference_image
`;

/**
 * The columns of the `test_run_images` table that are needed to create a TestData object
 */
const ImageColumns = 'image, pixel_error, candidate_image, difference_image';

/**
 * Test runs together with their images, which results in one row per image
 */
const RunsWithImages = 'test_runs JOIN test_run_images ON run_id = id';

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
 * A row of the `test_run_images` table as it is returned by queries that select
 * `ImageColumns`
 */
type ImageRow = {
  image: number;
  pixel_error: number;
  candidate_image: number;
  difference_image: number;
};

/**
 * A row as it is returned by queries that select `RunColumns` and `ImageColumns`
 */
type TestRunRow = TestKey &
  ImageRow & {
    id: number;
    timestamp: number;
    timing: number;
    n_errors: number;
    commit_hash: string;
    reference_image: string;
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
    insertRun: db.prepare<
      TestKey & {
        timestamp: number;
        timing: number;
        n_errors: number;
        commit_hash: string;
        reference_image: string;
        log: string;
      }
    >(`
      INSERT INTO test_runs (
        application, hardware, group_name, name, timestamp, timing, n_errors, commit_hash,
        reference_image, log
      )
      VALUES (
        @application, @hardware, @group_name, @name, @timestamp, @timing, @n_errors,
        @commit_hash, @reference_image, @log
      )
    `),
    insertImage: db.prepare<ImageRow & ImageHashes & { run_id: number | bigint }>(`
      INSERT INTO test_run_images (
        run_id, ${ImageColumns}, candidate_hash, difference_hash
      )
      VALUES (
        @run_id, @image, @pixel_error, @candidate_image, @difference_image,
        @candidate_hash, @difference_hash
      )
    `),
    runExists: db.prepare<TestKey & { timestamp: number }, { found: number }>(`
      SELECT 1 AS found FROM test_runs WHERE ${TestCondition} AND timestamp = @timestamp
    `),
    latestRun: db.prepare<TestKey & { before: number }, TestRunRow>(`
      SELECT ${RunColumns}, ${ImageColumns} FROM ${RunsWithImages}
      WHERE ${TestCondition} AND timestamp = (
        SELECT MAX(timestamp) FROM test_runs
        WHERE ${TestCondition} AND timestamp <= @before
      )
      ORDER BY image
    `),
    runLog: db.prepare<TestKey & { timestamp: number }, { log: string }>(`
      SELECT log FROM test_runs WHERE ${TestCondition} AND timestamp = @timestamp
    `),
    updateRunReference: db.prepare<
      TestKey & { timestamp: number; reference_image: string }
    >(`
      UPDATE test_runs SET reference_image = @reference_image
      WHERE ${TestCondition} AND timestamp = @timestamp
    `),
    updateRunImage: db.prepare<
      TestKey & ImageRow & { timestamp: number; difference_hash: string }
    >(`
      UPDATE test_run_images SET
        pixel_error = @pixel_error, candidate_image = @candidate_image,
        difference_image = @difference_image, difference_hash = @difference_hash
      WHERE image = @image AND run_id = (
        SELECT id FROM test_runs WHERE ${TestCondition} AND timestamp = @timestamp
      )
    `),
    candidateByHash: db.prepare<
      TestKey & { image: number; hash: string },
      { owner: number }
    >(`
      SELECT candidate_image AS owner FROM ${RunsWithImages}
      WHERE ${TestCondition} AND image = @image AND candidate_hash = @hash
      ORDER BY candidate_image LIMIT 1
    `),
    differenceByHash: db.prepare<
      TestKey & { image: number; hash: string },
      { owner: number }
    >(`
      SELECT difference_image AS owner FROM ${RunsWithImages}
      WHERE ${TestCondition} AND image = @image AND difference_hash = @hash
      ORDER BY difference_image LIMIT 1
    `),
    candidatesWithoutHash: db.prepare<[], TestKey & { image: number; owner: number }>(`
      SELECT DISTINCT application, hardware, group_name, name, image,
        candidate_image AS owner
      FROM ${RunsWithImages} WHERE candidate_hash IS NULL
    `),
    differencesWithoutHash: db.prepare<[], TestKey & { image: number; owner: number }>(`
      SELECT DISTINCT application, hardware, group_name, name, image,
        difference_image AS owner
      FROM ${RunsWithImages} WHERE difference_hash IS NULL
    `),
    setCandidateHash: db.prepare<
      TestKey & { image: number; owner: number; hash: string }
    >(`
      UPDATE test_run_images SET candidate_hash = @hash
      WHERE image = @image AND candidate_image = @owner AND run_id IN (
        SELECT id FROM test_runs WHERE ${TestCondition}
      )
    `),
    setDifferenceHash: db.prepare<
      TestKey & { image: number; owner: number; hash: string }
    >(`
      UPDATE test_run_images SET difference_hash = @hash
      WHERE image = @image AND difference_image = @owner AND run_id IN (
        SELECT id FROM test_runs WHERE ${TestCondition}
      )
    `),
    allTests: db.prepare<[], TestKey>(`
      SELECT DISTINCT application, hardware, group_name, name FROM test_runs
      ORDER BY application, hardware, group_name, name
    `),
    allRuns: db.prepare<[], TestRunRow>(`
      SELECT ${RunColumns}, ${ImageColumns} FROM ${RunsWithImages}
      ORDER BY application, hardware, group_name, name, timestamp, image
    `),
    latestRuns: db.prepare<{ count: number }, TestRunRow>(`
      SELECT ${RunColumns}, ${ImageColumns} FROM (
        SELECT ${RunColumns}, ROW_NUMBER() OVER (
          PARTITION BY application, hardware, group_name, name ORDER BY timestamp DESC
        ) AS position
        FROM test_runs
      )
      JOIN test_run_images ON run_id = id
      WHERE position <= @count
      ORDER BY application, hardware, group_name, name, timestamp, image
    `),
    history: db.prepare<TestKey, TestRunRow>(`
      SELECT ${RunColumns}, ${ImageColumns} FROM ${RunsWithImages}
      WHERE ${TestCondition} ORDER BY timestamp, image
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

  // This has to be checked first, as the tables must not be created in an older database
  const version = DB.pragma('user_version', { simple: true });
  if (version == 1) {
    DB.close();
    throw new Error(
      `The database ${path} has to be upgraded. Stop the server and run ` +
        'scripts/2-migrate_to_multiple_images.py to upgrade it.'
    );
  }
  if (version != 0 && version != SchemaVersion) {
    DB.close();
    throw new Error(`Unsupported database schema version ${version} in ${path}`);
  }

  DB.pragma('journal_mode = WAL');
  DB.pragma('foreign_keys = ON');
  DB.exec(Schema);
  if (version == 0) {
    DB.pragma(`user_version = ${SchemaVersion}`);
  }

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
 * Converts the rows of a single test run into a TestData object. There has to be one row
 * for each image of the test run, sorted by the number of the image.
 */
function toTestData(rows: TestRunRow[]): TestData {
  const row = rows[0]!;
  return {
    timeStamp: new Date(row.timestamp),
    timing: row.timing,
    nErrors: row.n_errors,
    commitHash: row.commit_hash,
    referenceImage: row.reference_image,
    images: rows.map((image) => ({
      image: image.image,
      pixelError: image.pixel_error,
      candidateImage: new Date(image.candidate_image),
      differenceImage: new Date(image.difference_image)
    }))
  };
}

/**
 * Collects consecutive rows that belong to the same test run. The rows have to be sorted
 * by the test run and the number of the image.
 */
function groupByRun(rows: TestRunRow[]): TestRunRow[][] {
  const runs: TestRunRow[][] = [];
  let current: TestRunRow[] | null = null;
  for (const row of rows) {
    if (current == null || current[0]!.id != row.id) {
      current = [];
      runs.push(current);
    }
    current.push(row);
  }
  return runs;
}

/**
 * Converts the rows of a single test run into a TestRun object.
 */
function toTestRun(rows: TestRunRow[]): TestRun {
  const row = rows[0]!;
  return {
    application: row.application,
    group: row.group_name,
    name: row.name,
    hardware: row.hardware,
    data: toTestData(rows)
  };
}

/**
 * Collects consecutive rows that belong to the same test into a single TestRecord. The
 * rows have to be sorted by test, timestamp, and the number of the image.
 */
function toTestRecords(rows: TestRunRow[]): TestRecord[] {
  const records: TestRecord[] = [];
  let current: TestRecord | null = null;
  for (const run of groupByRun(rows)) {
    const row = run[0]!;
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
    current.data.push(toTestData(run));
  }
  return records;
}

/**
 * Stores a new test run. A test run with the same timestamp must not exist for the test
 * yet; use `testRunExists` to check that beforehand. This has to be called inside a
 * transaction, see `inTransaction`.
 *
 * @param application The name of the application that generated the test run
 * @param group The name of the group to which the test run belongs
 * @param name The name of the test to which the test run belongs
 * @param hardware The hardware on which the test was run
 * @param data The results of the test run
 * @param log The contents of the log file of the test run
 * @param hashes The `pixelHash` values of the candidate and the difference image for each
 *        of the images in `data`, in the same order
 */
export function insertTestRun(
  application: string,
  group: string,
  name: string,
  hardware: string,
  data: TestData,
  log: string,
  hashes: { candidate: string; difference: string }[]
) {
  const { lastInsertRowid: runId } = Statements.insertRun.run({
    ...testKey(application, group, name, hardware),
    timestamp: data.timeStamp.getTime(),
    timing: data.timing,
    n_errors: data.nErrors,
    commit_hash: data.commitHash,
    reference_image: data.referenceImage,
    log: log
  });
  for (const [i, image] of data.images.entries()) {
    Statements.insertImage.run({
      run_id: runId,
      image: image.image,
      pixel_error: image.pixelError,
      candidate_image: image.candidateImage.getTime(),
      difference_image: image.differenceImage.getTime(),
      candidate_hash: hashes[i]!.candidate,
      difference_hash: hashes[i]!.difference
    });
  }
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
  const rows = Statements.latestRun.all({
    ...testKey(application, group, name, hardware),
    before: before ? before.getTime() : Number.MAX_SAFE_INTEGER
  });
  return rows.length > 0 ? toTestData(rows) : null;
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
 * Changes the reference image of an existing test run.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param timestamp The timestamp of the test run
 * @param referenceImage The file name of the new reference image
 */
export function updateRunReference(
  application: string,
  group: string,
  name: string,
  hardware: string,
  timestamp: Date,
  referenceImage: string
) {
  Statements.updateRunReference.run({
    ...testKey(application, group, name, hardware),
    timestamp: timestamp.getTime(),
    reference_image: referenceImage
  });
}

/**
 * Updates the results of one image of an existing test run. The pixel error, the candidate
 * image, and the difference image are updated.
 *
 * @param application The name of the application that generated the test
 * @param group The name of the group of the test
 * @param name The name of the test
 * @param hardware The hardware of the test
 * @param timestamp The timestamp of the test run
 * @param image The new results of the image, which is identified by its number
 * @param differenceHash The `pixelHash` of the new difference image
 */
export function updateRunImage(
  application: string,
  group: string,
  name: string,
  hardware: string,
  timestamp: Date,
  image: TestImage,
  differenceHash: string
) {
  Statements.updateRunImage.run({
    ...testKey(application, group, name, hardware),
    timestamp: timestamp.getTime(),
    image: image.image,
    pixel_error: image.pixelError,
    candidate_image: image.candidateImage.getTime(),
    difference_image: image.differenceImage.getTime(),
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
 * @param image The 1-based number of the image, only images at this position are searched
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
  image: number,
  hash: string
): Date | null {
  const statement =
    kind == 'candidate' ? Statements.candidateByHash : Statements.differenceByHash;
  const row = statement.get({
    ...testKey(application, group, name, hardware),
    image: image,
    hash: hash
  });
  return row ? new Date(row.owner) : null;
}

/**
 * Returns all candidate or difference images for which no hash has been stored yet.
 *
 * @param kind Whether the candidate or the difference images are returned
 * @returns The test, the number of the image, and the timestamp of the test run in whose
 *          folder each image is stored
 */
export function imagesWithoutHash(
  kind: HashedImage
): (TestKeyParts & { image: number; owner: Date })[] {
  const statement =
    kind == 'candidate'
      ? Statements.candidatesWithoutHash
      : Statements.differencesWithoutHash;
  return statement.all().map((row) => ({
    application: row.application,
    group: row.group_name,
    name: row.name,
    hardware: row.hardware,
    image: row.image,
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
 * @param image The 1-based number of the image
 * @param owner The timestamp of the test run in whose folder the image is stored
 * @param hash The `pixelHash` of the image
 */
export function setImageHash(
  kind: HashedImage,
  application: string,
  group: string,
  name: string,
  hardware: string,
  image: number,
  owner: Date,
  hash: string
) {
  const statement =
    kind == 'candidate' ? Statements.setCandidateHash : Statements.setDifferenceHash;
  statement.run({
    ...testKey(application, group, name, hardware),
    image: image,
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
  return groupByRun(Statements.allRuns.all()).map(toTestRun);
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
  const rows = Statements.history.all(testKey(application, group, name, hardware));
  return groupByRun(rows).map(toTestData);
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
