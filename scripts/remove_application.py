#!/usr/bin/env python3
"""
Remove all images and test runs of a specific application (across all hardwares).

The test runs and reference pointers are removed from the database and the image folders
of the application are deleted:
  data/tests/<application>
  data/reference/<application>

This includes the reference images, which cannot be recreated. Stop the server before
running this script.

Usage:
  python scripts/remove_application.py openspace
  python scripts/remove_application.py openspace --dry-run
  python scripts/remove_application.py openspace --data-dir data
"""

import argparse
import re
import shutil
import sqlite3
from pathlib import Path

DATABASE_NAME = "testresults.db"

# The database schema version that this script supports. Keep this in sync with the
# SchemaVersion in src/database.ts
SCHEMA_VERSION = 2

# The pattern that application names have to follow. Keep this in sync with the
# NamePattern in src/validation.ts. It rules out names like '..' that would point outside
# of the data folder
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def folder_size(folder: Path) -> int:
    """Return the total size in bytes of all files in the folder and its subfolders."""
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file())


def application_folders(data_dir: Path, application: str) -> list[Path]:
    """Return the existing tests and reference folders of the application."""
    folders = []
    for parent in (data_dir / "tests", data_dir / "reference"):
        folder = parent / application
        if not folder.is_dir():
            continue
        # The name is validated, but make sure that symbolic links cannot redirect the
        # deletion to a folder outside of the parent folder
        if folder.resolve().parent != parent.resolve():
            raise SystemExit(f"ERROR: {folder} points outside of {parent}, refusing to delete")
        folders.append(folder)
    return folders


def count_rows(connection: sqlite3.Connection, application: str) -> tuple[int, int, int]:
    """Return the number of test runs, images, and reference pointers of the application."""
    (runs,) = connection.execute(
        "SELECT COUNT(*) FROM test_runs WHERE application = ?", (application,)
    ).fetchone()
    (images,) = connection.execute(
        "SELECT COUNT(*) FROM test_run_images WHERE run_id IN "
        "(SELECT id FROM test_runs WHERE application = ?)",
        (application,),
    ).fetchone()
    (pointers,) = connection.execute(
        "SELECT COUNT(*) FROM reference_pointers WHERE application = ?", (application,)
    ).fetchone()
    return runs, images, pointers


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove all images and test runs of an application from the regression server.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("application", help="The name of the application to remove")
    parser.add_argument(
        "--data-dir",
        default="data",
        help="Path to the server's data folder (default: data)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without deleting anything",
    )
    args = parser.parse_args()

    application: str = args.application
    if not NAME_PATTERN.match(application):
        raise SystemExit(
            f"ERROR: '{application}' is not a valid application name. Names must start with "
            "a letter or digit and only contain letters, digits, '.', '_', and '-'"
        )

    data_dir = Path(args.data_dir)
    db_path = data_dir / DATABASE_NAME
    if not db_path.is_file():
        raise SystemExit(
            f"ERROR: Database not found: {db_path}. Run scripts/1-migrate_to_sqlite.py first"
        )

    suffix = " [DRY RUN]" if args.dry_run else ""
    print(f"Removing all data for application: {application}{suffix}")
    print(f"Data directory: {data_dir}")
    print()

    folders = application_folders(data_dir, application)

    connection = sqlite3.connect(db_path)
    try:
        (version,) = connection.execute("PRAGMA user_version").fetchone()
        if version != SCHEMA_VERSION:
            raise SystemExit(
                f"ERROR: Unsupported database schema version {version}, expected "
                f"{SCHEMA_VERSION}. Run the migration scripts first"
            )

        runs, images, pointers = count_rows(connection, application)

        if runs == 0 and pointers == 0 and not folders:
            print(f"No data found for application: {application}")
            print("Nothing to do.")
            return

        size = sum(folder_size(folder) for folder in folders)
        print(f"Found {runs} test runs with {images} images")
        print(f"Found {pointers} reference pointers")
        for folder in folders:
            print(f"Found folder: {folder}")
        print(f"Total size: {size / 1024 / 1024:.2f} MB")
        print()

        if args.dry_run:
            print("Dry run complete. Re-run without --dry-run to remove the application.")
            return

        print("Removing the application from the database...")
        with connection:
            # The foreign keys are not enforced on this connection, so deleting the test
            # runs does not cascade to their images
            connection.execute(
                "DELETE FROM test_run_images WHERE run_id IN "
                "(SELECT id FROM test_runs WHERE application = ?)",
                (application,),
            )
            connection.execute("DELETE FROM test_runs WHERE application = ?", (application,))
            connection.execute(
                "DELETE FROM reference_pointers WHERE application = ?", (application,)
            )
        print(f"Removed {runs} test runs and {pointers} reference pointers")
    finally:
        connection.close()

    print("Removing image files...")
    for folder in folders:
        shutil.rmtree(folder)
        print(f"Removed {folder}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()
