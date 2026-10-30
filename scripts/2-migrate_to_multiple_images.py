#!/usr/bin/env python3
"""
Migrate the regression server database to the schema that supports multiple images per
test run (from schema version 1 to version 2).

Before:
  test_runs         (one row per test run, including the results of its single image)

After:
  test_runs         (one row per test run)
  test_run_images   (one row per image of a test run)

All existing test runs become test runs with a single image. The image files and the
result URLs do not change, as the first image of a test run keeps its file names. Stop the
server before running this script.

All changes are made in a single transaction, so an interrupted run does not change the
database. Afterwards, the database file is compacted, which temporarily requires as much
free disk space as the size of the database.

Make a backup of the database before running this script without --dry-run.

Usage:
  python scripts/2-migrate_to_multiple_images.py --data-dir data
  python scripts/2-migrate_to_multiple_images.py --data-dir data --dry-run
"""

import argparse
import sqlite3
from pathlib import Path

DATABASE_NAME = "testresults.db"

# Keep this in sync with the schema in src/database.ts
SCHEMA = [
    """
    CREATE TABLE test_runs (
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
    )
    """,
    """
    CREATE TABLE test_run_images (
      run_id           INTEGER NOT NULL REFERENCES test_runs (id) ON DELETE CASCADE,
      image            INTEGER NOT NULL,
      pixel_error      REAL    NOT NULL,
      candidate_image  INTEGER NOT NULL,
      difference_image INTEGER NOT NULL,
      candidate_hash   TEXT,
      difference_hash  TEXT,
      PRIMARY KEY (run_id, image)
    ) WITHOUT ROWID
    """,
]

INDICES = [
    "CREATE INDEX test_run_images_candidate_hash ON test_run_images (candidate_hash)",
    "CREATE INDEX test_run_images_difference_hash ON test_run_images (difference_hash)",
]


def count_rows(connection: sqlite3.Connection, table: str) -> int:
    """Return the number of rows in the table."""
    (count,) = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    return count


def migrate(connection: sqlite3.Connection) -> None:
    """Move the results of the images into the test_run_images table."""
    columns = [row[1] for row in connection.execute("PRAGMA table_info(test_runs)")]
    # Databases from before the hashes were introduced do not have these columns. The
    # server computes the missing hashes when it starts
    candidate_hash = "candidate_hash" if "candidate_hash" in columns else "NULL"
    difference_hash = "difference_hash" if "difference_hash" in columns else "NULL"

    run_columns = (
        "id, application, hardware, group_name, name, timestamp, timing, n_errors, "
        "commit_hash, reference_image, log"
    )

    connection.execute("BEGIN IMMEDIATE")
    try:
        n_runs = count_rows(connection, "test_runs")

        connection.execute("ALTER TABLE test_runs RENAME TO test_runs_v1")
        for statement in SCHEMA:
            connection.execute(statement)
        connection.execute(
            f"INSERT INTO test_runs ({run_columns}) SELECT {run_columns} FROM test_runs_v1"
        )
        connection.execute(
            "INSERT INTO test_run_images (run_id, image, pixel_error, candidate_image, "
            "difference_image, candidate_hash, difference_hash) "
            "SELECT id, 1, pixel_error, candidate_image, difference_image, "
            f"{candidate_hash}, {difference_hash} FROM test_runs_v1"
        )

        if (
            count_rows(connection, "test_runs") != n_runs
            or count_rows(connection, "test_run_images") != n_runs
        ):
            raise SystemExit("ERROR: The number of rows does not match after the migration")

        connection.execute("DROP TABLE test_runs_v1")
        for statement in INDICES:
            connection.execute(statement)
        connection.execute("PRAGMA user_version = 2")
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate the database to support multiple images per test run.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--data-dir",
        default="data",
        help="Path to the server's data folder (default: data)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be migrated without changing anything",
    )
    args = parser.parse_args()

    db_path = Path(args.data_dir) / DATABASE_NAME
    if not db_path.is_file():
        raise SystemExit(
            f"ERROR: Database not found: {db_path}. Run scripts/1-migrate_to_sqlite.py first"
        )

    # Transactions are managed explicitly in the migrate function
    connection = sqlite3.connect(db_path, isolation_level=None)
    try:
        (version,) = connection.execute("PRAGMA user_version").fetchone()
        if version == 2:
            print("The database has already been migrated. Nothing to do.")
            return
        if version != 1:
            raise SystemExit(f"ERROR: Unsupported database schema version {version}")

        n_runs = count_rows(connection, "test_runs")
        if args.dry_run:
            print(f"Would migrate {n_runs} test runs in {db_path}")
            print("Dry run complete. Re-run without --dry-run to migrate the database.")
            return

        print(f"Migrating {n_runs} test runs in {db_path}")
        connection.execute("PRAGMA foreign_keys = OFF")
        migrate(connection)

        print("Compacting the database...")
        connection.execute("VACUUM")
    finally:
        connection.close()

    print("Done.")


if __name__ == "__main__":
    main()
