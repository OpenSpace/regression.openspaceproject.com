#!/usr/bin/env python3
"""
Remove all test runs of a specific hardware (across all applications).

The test runs are removed from the database and the image folders of the hardware are
deleted:
  data/tests/<application>/<hardware>

The reference images of the hardware are kept, so that future test runs of the hardware
are compared against them. Stop the server before running this script.

Usage:
  python scripts/remove_hardware.py windows-amd
  python scripts/remove_hardware.py windows-amd --dry-run
  python scripts/remove_hardware.py windows-amd --data-dir data
"""

import argparse
import re
import shutil
import sqlite3
from pathlib import Path

DATABASE_NAME = "testresults.db"

# The pattern that hardware names have to follow. Keep this in sync with the NamePattern
# in src/validation.ts. It rules out names like '..' that would point outside of the data
# folder
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def folder_size(folder: Path) -> int:
    """Return the total size in bytes of all files in the folder and its subfolders."""
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file())


def hardware_folders(tests: Path, hardware: str) -> list[Path]:
    """Return the folders of the hardware in all applications of the tests folder."""
    if not tests.is_dir():
        return []

    root = tests.resolve()
    folders = []
    for application in sorted(p for p in tests.iterdir() if p.is_dir()):
        folder = application / hardware
        if not folder.is_dir():
            continue
        # The name is validated, but make sure that symbolic links cannot redirect the
        # deletion to a folder outside of the tests folder
        resolved = folder.resolve()
        if resolved.parent.parent != root:
            raise SystemExit(f"ERROR: {folder} points outside of {tests}, refusing to delete")
        folders.append(folder)
    return folders


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove all test runs of a hardware from the regression server.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("hardware", help="The name of the hardware to remove")
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

    hardware: str = args.hardware
    if not NAME_PATTERN.match(hardware):
        raise SystemExit(
            f"ERROR: '{hardware}' is not a valid hardware name. Names must start with a "
            "letter or digit and only contain letters, digits, '.', '_', and '-'"
        )

    data_dir = Path(args.data_dir)
    db_path = data_dir / DATABASE_NAME
    if not db_path.is_file():
        raise SystemExit(
            f"ERROR: Database not found: {db_path}. Run scripts/1-migrate_to_sqlite.py first"
        )

    suffix = " [DRY RUN]" if args.dry_run else ""
    print(f"Removing all tests for hardware: {hardware}{suffix}")
    print(f"Data directory: {data_dir}")
    print()

    tests = data_dir / "tests"
    folders = hardware_folders(tests, hardware)

    connection = sqlite3.connect(db_path)
    try:
        (count,) = connection.execute(
            "SELECT COUNT(*) FROM test_runs WHERE hardware = ?", (hardware,)
        ).fetchone()

        if count == 0 and not folders:
            print(f"No tests found for hardware: {hardware}")
            print("Nothing to do.")
            return

        size = sum(folder_size(folder) for folder in folders)
        print(f"Found {count} test runs")
        for folder in folders:
            print(f"Found folder: {folder}")
        print(f"Total size: {size / 1024 / 1024:.2f} MB")
        print()

        if args.dry_run:
            print("Dry run complete. Re-run without --dry-run to remove the tests.")
            return

        print("Removing test runs from the database...")
        with connection:
            removed = connection.execute(
                "DELETE FROM test_runs WHERE hardware = ?", (hardware,)
            ).rowcount
        print(f"Removed {removed} test runs")
    finally:
        connection.close()

    print("Removing test files...")
    for folder in folders:
        shutil.rmtree(folder)
        print(f"Removed {folder}")

        # Remove the application folder if this was its last hardware
        application = folder.parent
        if not any(application.iterdir()):
            application.rmdir()
            print(f"Removed empty application folder {application}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()
