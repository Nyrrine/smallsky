#!/usr/bin/env python3
"""Bump SmallSky's version in both manifest.json and version.json.

Usage:
    python3 tools/bump-version.py <new-version> [change ...]

Examples:
    python3 tools/bump-version.py 1.1.0 "Added ⌘K palette" "Fixed dark mode toast"
    python3 tools/bump-version.py 1.0.1

After running, don't forget to:
    git add manifest.json version.json
    git commit -m "Release vX.Y.Z"
    git tag vX.Y.Z
    git push origin main --tags
    gh release create vX.Y.Z --title "SmallSky vX.Y.Z" --notes "<changelog>"
"""

import json
import sys
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    new_version = sys.argv[1]
    changes = sys.argv[2:]
    today = datetime.date.today().isoformat()

    # Update manifest.json
    manifest_path = ROOT / 'manifest.json'
    with open(manifest_path) as f:
        manifest = json.load(f)
    old_version = manifest.get('version', '?')
    manifest['version'] = new_version
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    # Update version.json
    version_path = ROOT / 'version.json'
    with open(version_path) as f:
        version_info = json.load(f)
    version_info['version'] = new_version
    version_info['released'] = today
    if changes:
        version_info['changes'] = changes
    with open(version_path, 'w') as f:
        json.dump(version_info, f, indent=2)
        f.write('\n')

    print(f'  manifest.json: {old_version} → {new_version}')
    print(f'  version.json:  released {today}')
    if changes:
        print(f'  changelog ({len(changes)} item{"s" if len(changes) != 1 else ""}):')
        for c in changes:
            print(f'    · {c}')
    print()
    print('Next steps:')
    print(f'  git add manifest.json version.json')
    print(f'  git commit -m "Release v{new_version}"')
    print(f'  git push')

if __name__ == '__main__':
    main()
