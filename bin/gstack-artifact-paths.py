#!/usr/bin/env python3
"""Portable path inspection and atomic identity claims; no index/config repair."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import secrets
from contextlib import contextmanager
import unicodedata

MAX_BYTES = 32 * 1024 * 1024
MAX_PATHS = 100000
MAX_DEPTH = 128
MAX_PREFIX_BYTES = 64 * 1024 * 1024
DEADLINE = time.monotonic() + 115


class Refusal(Exception):
    def __init__(self, code, paths=()):
        self.code, self.paths = code, sorted(set(paths))[:20]


def key(name):
    return unicodedata.normalize("NFC", name).casefold()


# Same repository-routing scrub as GBrain's official gitChildEnv. A shell's
# GIT_DIR/INDEX_FILE must never turn an inspection of ROOT into another repo.
LOCAL_GIT_ENV = set("GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_OBJECT_DIRECTORY GIT_DIR GIT_WORK_TREE GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_PREFIX GIT_SHALLOW_FILE GIT_COMMON_DIR GIT_NAMESPACE".split())

def git_env():
    return {**{k: v for k, v in os.environ.items() if k not in LOCAL_GIT_ENV and not re.fullmatch(r"GIT_CONFIG_(KEY|VALUE)_\d+", k)}, "GIT_OPTIONAL_LOCKS": "0"}

@contextmanager
def identity_lock(root):
    # Cooperate with the existing drain/init/restore lock. Never reclaim an
    # apparently stale owner: liveness sampling cannot authorize deleting it.
    root.mkdir(parents=True, exist_ok=True)
    lock = root / ".brain-sync.lock.d"
    token = os.environ.get("GSTACK_BRAIN_LOCK_TOKEN")
    owner_matches = False
    if token and not lock.is_symlink():
        try:
            owner_matches = not (lock / "owner").is_symlink() and (lock / "owner").read_text().strip() == token
        except OSError:
            pass
    if owner_matches:
        try:
            pid_text = (lock / "pid").read_text().strip()
            if (lock / "pid").is_symlink() or not pid_text.isdigit() or int(pid_text) <= 0:
                raise Refusal("ARTIFACT_IDENTITY_OWNER_UNVERIFIED")
            os.kill(int(pid_text), 0)
        except (OSError, OverflowError):
            raise Refusal("ARTIFACT_IDENTITY_OWNER_UNVERIFIED")
        # A shared token is not a mutex between siblings. Only established
        # exact identities may be checked here; the owner must claim first.
        yield False
        return
    deadline = time.monotonic() + 5
    while True:
        try:
            lock.mkdir(mode=0o700)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise Refusal("ARTIFACT_IDENTITY_LOCK_BUSY")
            time.sleep(0.02)
    owned = lock.stat()
    mine = str(os.getpid()) + "-" + secrets.token_hex(16)
    try:
        (lock / "pid").write_text(str(os.getpid()) + "\n")
        (lock / "owner").write_text(mine + "\n")
        yield True
    finally:
        try:
            now = lock.lstat()
            if (now.st_dev, now.st_ino) != (owned.st_dev, owned.st_ino):
                raise Refusal("ARTIFACT_IDENTITY_LOCK_OWNERSHIP_CHANGED")
            (lock / "owner").unlink(missing_ok=True)
            (lock / "pid").unlink(missing_ok=True)
            lock.rmdir()
        except OSError:
            raise Refusal("ARTIFACT_IDENTITY_LOCK_RELEASE_FAILED")

def claim_slug(root, slug):
    with identity_lock(root) as own_lock:
        check_slug(root, slug)
        project = root / "projects" / slug
        if not own_lock and not project.exists():
            raise Refusal("ARTIFACT_IDENTITY_OWNER_MUST_CLAIM_FIRST")
        if own_lock:
            project.mkdir(parents=True, exist_ok=True)
        check_slug(root, slug)


def git(root, args, allow_unborn=False):
    # Optional Git locks are disabled: an inspection must not refresh the index.
    try:
        process = subprocess.Popen(["git", "-C", str(root), *args],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=git_env())
    except OSError:
        raise Refusal("ARTIFACT_GIT_UNAVAILABLE")
    expired = threading.Event()
    def timeout():
        expired.set()
        try:
            process.kill()
        except ProcessLookupError:
            pass
    timer = threading.Timer(max(0.001, DEADLINE - time.monotonic()), timeout)
    timer.start()
    try:
        output = process.stdout.read(MAX_BYTES + 1)
        if len(output) > MAX_BYTES:
            process.kill()
            raise Refusal("ARTIFACT_PATH_LIMIT")
        process.wait()
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
    if expired.is_set():
        raise Refusal("ARTIFACT_GIT_UNAVAILABLE")
    if process.returncode:
        if allow_unborn and process.returncode == 1:
            return b""
        raise Refusal("ARTIFACT_GIT_READ_FAILED")
    return output


def decode(raw):
    try:
        paths = [p.decode("utf-8", "strict") for p in raw.split(b"\0") if p]
    except UnicodeDecodeError:
        raise Refusal("ARTIFACT_PATH_ENCODING")
    if len(paths) > MAX_PATHS:
        raise Refusal("ARTIFACT_PATH_LIMIT")
    for p in paths:
        bits = p.split("/")
        if len(bits) > MAX_DEPTH or any(b in ("", ".", "..") for b in bits):
            raise Refusal("ARTIFACT_PATH_INVALID", [p])
    return paths


def collisions(paths):
    # Inspect every prefix, not only identical leaf names: Foo/a and foo/b
    # are incompatible project identities on a case-insensitive filesystem.
    groups = {}
    prefix_bytes = 0
    for p in paths:
        prefix = []
        for part in p.split("/"):
            prefix.append(part)
            original = "/".join(prefix)
            prefix_bytes += len(original.encode("utf-8"))
            if prefix_bytes > MAX_PREFIX_BYTES:
                raise Refusal("ARTIFACT_PATH_LIMIT")
            groups.setdefault(key(original), set()).add(original)
    return sorted({p for names in groups.values() if len(names) > 1 for p in names})


def index_paths(root):
    return decode(git(root, ["ls-files", "-z"]))


def check_index(root, include_head=False):
    indexed = index_paths(root)
    found = collisions(indexed)
    if include_head and git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], True):
        found += collisions(decode(git(root, ["ls-tree", "-rz", "--name-only", "HEAD"])))
    if found:
        raise Refusal("ARTIFACT_CASE_COLLISION", found)
    return indexed


def check_staged(root, requested_file, names_file=None):
    indexed = set(check_index(root))
    try:
        names = Path(requested_file).read_bytes().decode("utf-8", "strict").split("\n")
        if names and names[-1] == "":
            names.pop()
        requested = set(names)
    except UnicodeDecodeError:
        raise Refusal("ARTIFACT_PATH_ENCODING")
    missing = requested - indexed
    changed = set(decode(Path(names_file).read_bytes() if names_file else git(root, ["diff", "--cached", "--name-only", "-z"])))
    unexpected = changed - requested
    if missing or unexpected:
        raise Refusal("ARTIFACT_STAGED_PATH_MISMATCH", missing | unexpected)


def check_slug(root, slug):
    if not re.fullmatch(r"[a-zA-Z0-9._-]+", slug) or slug in (".", ".."):
        raise Refusal("ARTIFACT_SLUG_INVALID")
    if root.exists():
        aliases = [entry.name for entry in os.scandir(root) if key(entry.name) == "projects"]
        if any(name != "projects" for name in aliases):
            raise Refusal("ARTIFACT_CASE_COLLISION", aliases + ["projects"])
    projects = root / "projects"
    if projects.is_symlink():
        raise Refusal("ARTIFACT_PROJECT_SYMLINK", ["projects"])
    names = {slug}
    if projects.exists():
        for entry in os.scandir(projects):
            if key(entry.name) == key(slug):
                if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                    raise Refusal("ARTIFACT_PROJECT_SYMLINK", ["projects/" + entry.name])
                names.add(entry.name)
    if (root / ".git").exists():
        for p in index_paths(root):
            bits = p.split("/")
            if len(bits) > 1 and key(bits[0]) == "projects" and key(bits[1]) == key(slug):
                if bits[0] != "projects":
                    raise Refusal("ARTIFACT_CASE_COLLISION", [bits[0], "projects"])
                names.add(bits[1])
    if len(names) > 1:
        raise Refusal("ARTIFACT_CASE_COLLISION", ["projects/" + n for n in names])


def main(argv):
    if len(argv) not in (3, 4, 5) or argv[1] not in ("slug", "claim", "index", "outgoing", "staged"):
        print("usage: gstack-artifact-paths.py slug ROOT SLUG | index ROOT | outgoing ROOT | staged ROOT PATHS_FILE", file=sys.stderr)
        return 2
    try:
        root = Path(argv[2])
        if argv[1] in ("slug", "claim", "staged"):
            if len(argv) not in ((4,) if argv[1] in ("slug", "claim") else (4, 5)):
                return 2
            if argv[1] in ("slug", "claim"):
                (claim_slug if argv[1] == "claim" else check_slug)(root, argv[3])
            else:
                check_staged(root, argv[3], argv[4] if len(argv) == 5 else None)
        else:
            if len(argv) != 3:
                return 2
            check_index(root, argv[1] == "outgoing")
    except Refusal as error:
        print(json.dumps({"code": error.code, "state": "refused", "paths": error.paths,
                          "artifact_content_changed": False,
                          "next_action": "Preserve both spellings and inspect project identity; do not force-add or discard. Repair the conflicting tree before retrying."}), file=sys.stderr)
        return 3
    except OSError:
        print(json.dumps({"code": "ARTIFACT_PATH_UNREADABLE", "state": "refused",
                          "artifact_content_changed": False}), file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
