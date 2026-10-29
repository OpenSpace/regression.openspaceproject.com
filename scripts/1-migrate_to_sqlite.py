#!/usr/bin/env python3
"""
Migrate the small files of the regression server data folder into an SQLite database.

Before:
  data/tests/<application>/<hardware>/<group>/<name>/<timestamp>/data.json
  data/tests/<application>/<hardware>/<group>/<name>/<timestamp>/log.txt
  data/reference/<application>/<hardware>/<group>/<name>/ref.txt

After:
  data/testresults.db   (contains the test runs, their logs, and the reference pointers)

The images (candidate, difference, reference, and their thumbnails) stay where they are.
The data folder must already be in the application-based layout, so run
0-migrate_to_applications.py first if necessary. The audit.txt and the temporary folder
are not touched. Stop the server before running this script.

The database is written to a temporary file and only renamed to testresults.db once all
data has been inserted and verified. Afterwards, the migrated data.json, log.txt, and
ref.txt files are deleted and the run folders that end up empty are removed. If the
script is interrupted while deleting files, running it again checks the remaining files
against the database and finishes the cleanup.

Make a backup of the data folder before running this script without --dry-run.

Usage:
  python scripts/1-migrate_to_sqlite.py --data-dir data
  python scripts/1-migrate_to_sqlite.py --data-dir data --dry-run
  python scripts/1-migrate_to_sqlite.py --data-dir data --keep-files
"""

import argparse
import json
import math
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATABASE_NAME = "testresults.db"

# The shape of a run folder name as it is created by the server, e.g. 20260407T084341145Z
FOLDER_TIMESTAMP = re.compile(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$")

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

# Keep this in sync with the schema in src/database.ts. The candidate_hash and
# difference_hash columns are left empty by this script; the server computes them from the
# images when it starts
SCHEMA = """
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

CREATE INDEX IF NOT EXISTS test_runs_candidate_hash
  ON test_runs (application, hardware, group_name, name, candidate_hash);
CREATE INDEX IF NOT EXISTS test_runs_difference_hash
  ON test_runs (application, hardware, group_name, name, difference_hash);

CREATE TABLE IF NOT EXISTS reference_pointers (
  application     TEXT NOT NULL,
  hardware        TEXT NOT NULL,
  group_name      TEXT NOT NULL,
  name            TEXT NOT NULL,
  reference_image TEXT NOT NULL,
  PRIMARY KEY (application, hardware, group_name, name)
) WITHOUT ROWID;

PRAGMA user_version = 1;
"""

RUN_COLUMNS = (
    "application, hardware, group_name, name, timestamp, pixel_error, timing, n_errors, "
    "commit_hash, reference_image, candidate_image, difference_image, log"
)


def to_milliseconds(date: datetime) -> int:
    """Return the number of milliseconds since the Unix epoch for an aware datetime."""
    return (date - EPOCH) // timedelta(milliseconds=1)


def folder_to_milliseconds(folder_name: str) -> int | None:
    """Parse a run folder name, returning milliseconds since the epoch or None."""
    match = FOLDER_TIMESTAMP.match(folder_name)
    if match is None:
        return None
    y, mo, d, h, mi, s, ms = (int(v) for v in match.groups())
    return to_milliseconds(datetime(y, mo, d, h, mi, s, ms * 1000, tzinfo=timezone.utc))


def parse_date(value) -> int | None:
    """Parse a date as stored in data.json, returning milliseconds since the epoch or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str):
        return None
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    return to_milliseconds(date)


def is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def read_text(path: Path) -> str:
    """Read a text file exactly as the server would, without newline translation."""
    return path.read_bytes().decode("utf-8", errors="replace")


def subdirectories(folder: Path) -> list[Path]:
    return sorted(d for d in folder.iterdir() if d.is_dir())


def find_run_folders(tests: Path) -> list[tuple[str, str, str, str, Path]]:
    """Return (application, hardware, group, name, folder) for every run folder.

    Raises SystemExit if the folder layout is not the application-based layout.
    """
    runs = []
    for app_dir in subdirectories(tests):
        for hw_dir in subdirectories(app_dir):
            for group_dir in subdirectories(hw_dir):
                for name_dir in subdirectories(group_dir):
                    if FOLDER_TIMESTAMP.match(name_dir.name):
                        raise SystemExit(
                            f"ERROR: {name_dir} looks like a test run folder, but it is one "
                            "level too shallow. The data folder seems to be in the old "
                            "layout; run scripts/0-migrate_to_applications.py first."
                        )
                    for run_dir in subdirectories(name_dir):
                        if not FOLDER_TIMESTAMP.match(run_dir.name):
                            raise SystemExit(
                                f"ERROR: unexpected folder {run_dir}. Expected the layout "
                                "tests/<application>/<hardware>/<group>/<name>/<timestamp>"
                            )
                        runs.append(
                            (app_dir.name, hw_dir.name, group_dir.name, name_dir.name, run_dir)
                        )
    return runs


def find_reference_pointers(reference: Path) -> list[tuple[str, str, str, str, Path]]:
    """Return (application, hardware, group, name, ref.txt path) for every pointer file."""
    pointers = []
    for ref in sorted(reference.glob("*/*/*/*/ref.txt")):
        name_dir = ref.parent
        group_dir = name_dir.parent
        hw_dir = group_dir.parent
        app_dir = hw_dir.parent
        pointers.append((app_dir.name, hw_dir.name, group_dir.name, name_dir.name, ref))
    return pointers


def parse_run(key: tuple[str, str, str, str], folder: Path, errors: list[str]):
    """Read and validate the data.json and log.txt of a run folder.

    Returns the database row or None if the run is invalid (the problems are appended to
    `errors`).
    """
    if not (folder / "log.txt").is_file():
        errors.append(f"{folder}: missing log.txt")
        return None
    data = parse_data(key, folder, errors)
    if data is None:
        return None
    return data + (read_text(folder / "log.txt"),)


def parse_data(key: tuple[str, str, str, str], folder: Path, errors: list[str]):
    """Read and validate the data.json of a run folder.

    The validation mirrors the rules that the server used when loading data.json files.
    Returns the database row without the trailing log column or None if the data is
    invalid (the problems are appended to `errors`).
    """
    data_file = folder / "data.json"
    if not data_file.is_file():
        errors.append(f"{folder}: missing data.json")
        return None

    try:
        data = json.loads(data_file.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        errors.append(f"{data_file}: invalid JSON ({e})")
        return None
    if not isinstance(data, dict):
        errors.append(f"{data_file}: expected a JSON object")
        return None

    problems = []
    pixel_error = data.get("pixelError")
    if not is_number(pixel_error) or not 0 <= pixel_error <= 1:
        problems.append(f"pixelError must be a number between 0 and 1, got {pixel_error!r}")
    timing = data.get("timing")
    if not is_number(timing) or timing < 0:
        problems.append(f"timing must be a non-negative number, got {timing!r}")
    n_errors = data.get("nErrors")
    if not isinstance(n_errors, int) or isinstance(n_errors, bool) or n_errors < 0:
        problems.append(f"nErrors must be a non-negative integer, got {n_errors!r}")
    commit_hash = data.get("commitHash")
    if not isinstance(commit_hash, str) or commit_hash == "":
        problems.append(f"commitHash must be a non-empty string, got {commit_hash!r}")
    reference_image = data.get("referenceImage")
    if not isinstance(reference_image, str) or reference_image == "":
        problems.append(f"referenceImage must be a non-empty string, got {reference_image!r}")

    dates = {}
    for field in ("timeStamp", "candidateImage", "differenceImage"):
        dates[field] = parse_date(data.get(field))
        if dates[field] is None:
            problems.append(f"{field} must be a date, got {data.get(field)!r}")

    folder_time = folder_to_milliseconds(folder.name)
    if dates["timeStamp"] is not None and dates["timeStamp"] != folder_time:
        problems.append(
            f"timeStamp {data.get('timeStamp')!r} does not match the folder name {folder.name}"
        )

    if problems:
        errors.extend(f"{data_file}: {p}" for p in problems)
        return None

    application, hardware, group, name = key
    return (
        application,
        hardware,
        group,
        name,
        folder_time,
        float(pixel_error),
        float(timing),
        n_errors,
        commit_hash,
        reference_image,
        dates["candidateImage"],
        dates["differenceImage"],
    )


def abort_on_errors(errors: list[str]) -> None:
    if not errors:
        return
    print(f"Found {len(errors)} problem(s):")
    for error in errors[:100]:
        print(f"  {error}")
    if len(errors) > 100:
        print(f"  ... and {len(errors) - 100} more")
    raise SystemExit("ERROR: aborting, nothing was changed")


def remove_empty_folders(root: Path) -> int:
    """Remove all empty folders below `root` (but never `root` itself), bottom-up.

    Returns the number of removed folders.
    """
    removed = 0
    for current, _, _ in os.walk(root, topdown=False):
        folder = Path(current)
        if folder != root and not any(folder.iterdir()):
            folder.rmdir()
            removed += 1
    return removed


def migrate(data_dir: Path, db_path: Path, dry_run: bool, keep_files: bool) -> None:
    tests = data_dir / "tests"
    reference = data_dir / "reference"

    print("Scanning test runs...")
    runs = find_run_folders(tests)
    pointers = find_reference_pointers(reference)
    print(f"  {len(runs)} test run folder(s), {len(pointers)} reference pointer(s)")

    print("Reading and validating files...")
    errors: list[str] = []
    rows = []
    for application, hardware, group, name, folder in runs:
        row = parse_run((application, hardware, group, name), folder, errors)
        if row is not None:
            rows.append(row)
    pointer_rows = []
    for application, hardware, group, name, ref in pointers:
        content = read_text(ref).strip()
        if content == "":
            errors.append(f"{ref}: empty reference pointer")
        pointer_rows.append((application, hardware, group, name, content))
    abort_on_errors(errors)

    if dry_run:
        print(f"Would write {len(rows)} test run(s) and {len(pointer_rows)} reference")
        print(f"pointer(s) to {db_path}")
        if not keep_files:
            # The run folders that are empty once data.json and log.txt are gone
            empty_runs = sum(
                1
                for *_, folder in runs
                if all(f.name in ("data.json", "log.txt") for f in folder.iterdir())
            )
            print(f"Would delete {2 * len(rows) + len(pointer_rows)} file(s) and remove")
            print(f"{empty_runs} run folder(s) that only contain data.json and log.txt")
        return

    tmp_path = db_path.with_name(db_path.name + ".tmp")
    if tmp_path.exists():
        print(f"Removing leftover {tmp_path} from a previous, interrupted run")
        tmp_path.unlink()

    print(f"Writing {tmp_path}...")
    connection = sqlite3.connect(tmp_path)
    try:
        connection.executescript(SCHEMA)
        with connection:
            connection.executemany(
                f"INSERT INTO test_runs ({RUN_COLUMNS}) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            connection.executemany(
                "INSERT INTO reference_pointers "
                "(application, hardware, group_name, name, reference_image) "
                "VALUES (?, ?, ?, ?, ?)",
                pointer_rows,
            )

        (n_runs,) = connection.execute("SELECT COUNT(*) FROM test_runs").fetchone()
        (n_pointers,) = connection.execute("SELECT COUNT(*) FROM reference_pointers").fetchone()
        (check,) = connection.execute("PRAGMA integrity_check").fetchone()
    finally:
        connection.close()

    if n_runs != len(runs) or n_pointers != len(pointers) or check != "ok":
        raise SystemExit(
            f"ERROR: verification failed (runs {n_runs}/{len(runs)}, pointers "
            f"{n_pointers}/{len(pointers)}, integrity check '{check}'). The original files "
            f"were not touched; {tmp_path} was left for inspection."
        )

    tmp_path.rename(db_path)
    print(f"Wrote {n_runs} test run(s) and {n_pointers} reference pointer(s) to {db_path}")

    if keep_files:
        print("Keeping the original files (--keep-files)")
        return

    cleanup(data_dir)


def cleanup(data_dir: Path) -> None:
    """Delete the migrated data.json, log.txt, and ref.txt files and empty run folders."""
    files = (
        list((data_dir / "tests").glob("*/*/*/*/*/data.json"))
        + list((data_dir / "tests").glob("*/*/*/*/*/log.txt"))
        + list((data_dir / "reference").glob("*/*/*/*/ref.txt"))
    )
    print(f"Deleting {len(files)} migrated file(s)...")
    for file in files:
        file.unlink()
    removed = remove_empty_folders(data_dir / "tests")
    removed += remove_empty_folders(data_dir / "reference")
    print(f"Removed {removed} empty folder(s)")


def resume(data_dir: Path, db_path: Path, dry_run: bool, keep_files: bool) -> None:
    """Finish the cleanup of a previous migration.

    All leftover data.json, log.txt, and ref.txt files are compared against the database
    and only deleted if the database contains exactly the same information.
    """
    tests = data_dir / "tests"
    reference = data_dir / "reference"

    data_files = sorted(tests.glob("*/*/*/*/*/data.json"))
    log_files = sorted(tests.glob("*/*/*/*/*/log.txt"))
    ref_files = sorted(reference.glob("*/*/*/*/ref.txt"))
    leftovers = len(data_files) + len(log_files) + len(ref_files)
    if leftovers == 0:
        print(f"{db_path} exists and no files are left to migrate. Already migrated.")
        return

    print(f"{db_path} already exists, but {leftovers} file(s) are left from a previous")
    print("migration. Comparing them with the database...")

    connection = sqlite3.connect(db_path)
    errors: list[str] = []
    try:
        for data_file in data_files:
            folder = data_file.parent
            key = tuple(p.name for p in folder.parents[3::-1])
            row = db_run(connection, key, folder)
            if row is None:
                errors.append(f"{data_file}: no matching row in the database")
                continue
            expected = parse_data(key, folder, errors)
            if expected is not None and expected != row[:-1]:
                errors.append(f"{data_file}: content differs from the database")

        for log_file in log_files:
            folder = log_file.parent
            key = tuple(p.name for p in folder.parents[3::-1])
            row = db_run(connection, key, folder)
            if row is None:
                errors.append(f"{log_file}: no matching row in the database")
            elif read_text(log_file) != row[-1]:
                errors.append(f"{log_file}: content differs from the database")

        for ref_file in ref_files:
            application, hardware, group, name = (p.name for p in ref_file.parents[3::-1])
            result = connection.execute(
                "SELECT reference_image FROM reference_pointers WHERE application = ? AND "
                "hardware = ? AND group_name = ? AND name = ?",
                (application, hardware, group, name),
            ).fetchone()
            if result is None or result[0] != read_text(ref_file).strip():
                errors.append(f"{ref_file}: content differs from the database")
    finally:
        connection.close()

    if errors:
        print(f"Found {len(errors)} problem(s):")
        for error in errors[:100]:
            print(f"  {error}")
        raise SystemExit(
            "ERROR: the leftover files do not match the database. Restore the data folder "
            f"from a backup, delete {db_path}, and run the migration again."
        )

    print("All leftover files match the database")
    if dry_run:
        print(f"Would delete {leftovers} file(s)")
    elif keep_files:
        print("Keeping the original files (--keep-files)")
    else:
        cleanup(data_dir)


def db_run(connection: sqlite3.Connection, key: tuple, folder: Path):
    """Return the database row for the run stored in `folder` or None."""
    application, hardware, group, name = key
    return connection.execute(
        f"SELECT {RUN_COLUMNS} FROM test_runs WHERE application = ? AND hardware = ? AND "
        "group_name = ? AND name = ? AND timestamp = ?",
        (application, hardware, group, name, folder_to_milliseconds(folder.name)),
    ).fetchone()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate regression server data files into an SQLite database.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--data-dir",
        required=True,
        help="Path to the server's data folder (must contain 'tests' and 'reference')",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and validate all files and report what would happen, without changes",
    )
    parser.add_argument(
        "--keep-files",
        action="store_true",
        help="Do not delete the migrated data.json, log.txt, and ref.txt files",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    if not data_dir.is_dir():
        raise SystemExit(f"ERROR: data dir {data_dir} does not exist")
    for tree in (data_dir / "tests", data_dir / "reference"):
        if not tree.is_dir():
            raise SystemExit(f"ERROR: {tree} does not exist")

    suffix = " [DRY RUN]" if args.dry_run else ""
    print(f"Migrating {data_dir} to SQLite{suffix}")

    db_path = data_dir / DATABASE_NAME
    if db_path.exists():
        resume(data_dir, db_path, args.dry_run, args.keep_files)
    else:
        migrate(data_dir, db_path, args.dry_run, args.keep_files)

    if args.dry_run:
        print("Dry run complete. Re-run without --dry-run to perform the migration.")
    else:
        print("Migration complete. The server can now be started.")


if __name__ == "__main__":
    main()
