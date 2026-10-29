#!/usr/bin/env python3
"""
Migrate the regression server data folder to the application-based layout.

Old layout:
  data/tests/<hardware>/<group>/<name>/<timestamp>/
  data/reference/<hardware>/<group>/<name>/

New layout:
  data/tests/<application>/<hardware>/<group>/<name>/<timestamp>/
  data/reference/<application>/<hardware>/<group>/<name>/

All existing data is moved under a single application (default: "openspace").
Only folders are renamed; file contents are not touched, so the migration is
safe and fast.

The script is idempotent: running it a second time detects that the data is
already in the new layout and exits without doing anything.

Usage:
  python scripts/0-migrate_to_applications.py --data-dir data
  python scripts/0-migrate_to_applications.py --data-dir data --application openspace
  python scripts/0-migrate_to_applications.py --data-dir data --dry-run
"""

import argparse
import shutil
import sys
from pathlib import Path


def count_entries(root: Path) -> int:
    """Count all files and directories under root (0 if root does not exist)."""
    if not root.is_dir():
        return 0
    return sum(1 for _ in root.rglob("*"))


def migrate_tree(tree: Path, application: str, dry_run: bool) -> int:
    """Move every top-level directory of `tree` under tree/<application>/.

    Returns the number of hardware folders moved.
    """
    app_dir = tree / application
    top_level = sorted(d for d in tree.iterdir() if d.is_dir())

    if app_dir.exists():
        others = [d for d in top_level if d != app_dir]
        if others:
            names = ", ".join(d.name for d in others)
            raise SystemExit(
                f"ERROR: {tree} contains the application folder '{application}' "
                f"as well as other folders ({names}). This is an ambiguous "
                f"layout (partially migrated, or a hardware folder named "
                f"'{application}'). Refusing to migrate; fix it by hand."
            )
        print(f"  {tree}: already in the new layout, nothing to do")
        return 0

    if not top_level:
        print(f"  {tree}: empty, nothing to do")
        return 0

    print(f"  {tree}: creating {app_dir}")
    if not dry_run:
        app_dir.mkdir(parents=True)

    moved = 0
    for d in top_level:
        dest = app_dir / d.name
        if dest.exists():
            raise SystemExit(f"ERROR: destination {dest} already exists, aborting")
        print(f"    move {d} -> {dest}")
        if not dry_run:
            shutil.move(str(d), str(dest))
        moved += 1
    return moved


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate regression server data to the application-based layout.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--data-dir",
        required=True,
        help="Path to the server's data folder (must contain 'tests' and 'reference')",
    )
    parser.add_argument(
        "--application",
        default="openspace",
        help="Application name to migrate the existing data under (default: openspace)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the moves without performing them",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    if not data_dir.is_dir():
        raise SystemExit(f"ERROR: data dir {data_dir} does not exist")

    trees = [data_dir / "tests", data_dir / "reference"]
    for tree in trees:
        if not tree.is_dir():
            raise SystemExit(f"ERROR: {tree} does not exist")

    suffix = " [DRY RUN]" if args.dry_run else ""
    print(f"Migrating {data_dir} to application '{args.application}'{suffix}")
    before = count_entries(data_dir)

    total = 0
    for tree in trees:
        print(f"{tree}:")
        total += migrate_tree(tree, args.application, args.dry_run)

    after = count_entries(data_dir)
    print(f"Moved {total} hardware folder(s). Entries before: {before}, after: {after}")

    if args.dry_run:
        print("Dry run complete. Re-run without --dry-run to perform the migration.")
    else:
        print("Migration complete.")
        print("Make sure config.json lists the applications (e.g. 'openspace' and 'sgct'),")
        print("then start the server.")


if __name__ == "__main__":
    main()
