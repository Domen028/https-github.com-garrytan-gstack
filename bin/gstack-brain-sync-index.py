#!/usr/bin/env python3
"""Read-only verification of brain-sync's post-add index; never repairs it."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


class Refusal(Exception):
    pass


def git(root, *args, data=None):
    try:
        result = subprocess.run(
            ['git', '-C', str(root), *args], input=data,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Refusal('index verification could not read Git') from error
    if result.returncode:
        raise Refusal('index verification Git command failed')
    return result.stdout


def verify(root, requested_file, names_file):
    requested = set(Path(requested_file).read_text(encoding='utf-8').splitlines())
    requested.discard('')
    entries = {}
    for record in git(root, 'ls-files', '--stage', '-z').split(b'\0'):
        if not record:
            continue
        header, name = record.split(b'\t', 1)
        mode, oid, stage = header.split()
        name = name.decode('utf-8')
        if stage != b'0':
            raise Refusal('unmerged index entries; inspect the index')
        entries[name] = (mode, oid)
    changed = {p.decode('utf-8') for p in Path(names_file).read_bytes().split(b'\0') if p}
    if requested - entries.keys() or changed - requested:
        raise Refusal('requested/index path mismatch; inspect exact path spellings and unrelated staged entries')

    regular = []
    for name in sorted(requested):
        mode, oid = entries[name]
        file = root / name
        actual = file.lstat().st_mode
        if mode == b'120000' and stat.S_ISLNK(actual):
            hashed = git(root, 'hash-object', '--stdin', data=os.fsencode(os.readlink(file))).strip()
            if hashed != oid:
                raise Refusal('requested/index content mismatch')
        elif mode in (b'100644', b'100755') and stat.S_ISREG(actual):
            regular.append(name)
        else:
            raise Refusal('requested/index file type mismatch')
    if regular:
        # --stdin-paths applies the same clean filters/EOL conversion as add.
        # Quote each path as Git's C-style input (including quotes/backslashes).
        paths = ''.join(json.dumps(p, ensure_ascii=False) + '\n' for p in regular).encode('utf-8')
        hashes = git(root, 'hash-object', '--stdin-paths', data=paths).splitlines()
        if len(hashes) != len(regular) or any(entries[p][1] != oid for p, oid in zip(regular, hashes)):
            raise Refusal('requested/index content mismatch; queued content is not in the index')


if __name__ == '__main__':
    try:
        verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    except (Refusal, OSError, UnicodeError, ValueError, IndexError) as error:
        print('BRAIN_SYNC: staged artifact validation refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
