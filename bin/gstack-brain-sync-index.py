#!/usr/bin/env python3
"""Read-only verification of brain-sync's post-add index; never repairs it."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import unicodedata


class Refusal(Exception):
    pass


def git(root, *args, data=None, allow_missing=False):
    try:
        result = subprocess.run(
            ['git', '-C', str(root), *args], input=data,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Refusal('index verification could not read Git') from error
    if result.returncode == 1 and allow_missing:
        return b''
    if result.returncode:
        raise Refusal('index verification Git command failed')
    return result.stdout


def prefixes(paths):
    groups = {}
    for path in paths:
        parts = path.split('/')
        for i in range(1, len(parts) + 1):
            spelling = '/'.join(parts[:i])
            key = unicodedata.normalize('NFC', spelling).casefold()
            groups.setdefault(key, set()).add(spelling)
    return groups


def refuse_new_collisions(root, paths, baseline='HEAD'):
    # Compare complete component prefixes: Foo/a and foo/b collide too.
    # Existing aliases are historical data; this check does not migrate them
    # or block unrelated writes, but it refuses any additional spelling.
    head = git(root, 'ls-tree', '-rz', '--name-only', baseline) if baseline else b''
    previous = prefixes(p.decode('utf-8') for p in head.split(b'\0') if p)
    for key, spellings in prefixes(paths).items():
        if len(spellings) > 1 and not spellings <= previous.get(key, set()):
            raise Refusal('new casefold path collision; inspect path spellings before retrying')


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
    refuse_new_collisions(root, set(entries) | requested)
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


def outgoing(root):
    branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').decode('utf-8').strip()
    remote = 'refs/remotes/origin/' + branch
    baseline = remote if git(root, 'rev-parse', '--verify', '--quiet', remote, allow_missing=True) else None
    head = git(root, 'ls-tree', '-rz', '--name-only', 'HEAD')
    refuse_new_collisions(root, (p.decode('utf-8') for p in head.split(b'\0') if p), baseline)


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--outgoing':
            outgoing(Path(sys.argv[2]))
        else:
            verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    except (Refusal, OSError, UnicodeError, ValueError, IndexError) as error:
        print('BRAIN_SYNC: staged artifact validation refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
