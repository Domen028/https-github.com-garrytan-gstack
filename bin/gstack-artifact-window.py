#!/usr/bin/env python3
"""Cooperative, per-project writer admission. Never reclaims an unknown owner.

This is not an OS security boundary: direct file writers must participate too.
The short metadata lock only changes admission; a writer's durable lease spans
its entire read/modify/write operation. A pending window denies new admissions
and becomes exclusive only after every previously admitted lease is released.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import re
import stat
import subprocess
import sys
import time
import unicodedata


class Refusal(Exception):
    pass


def regular(path):
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode):
        raise Refusal("ARTIFACT_WINDOW_UNSAFE_METADATA")
    return value


def flush_directory(path):
    # Windows has no directory-fsync handle; the initial qualification target
    # for maintenance windows is POSIX. Ordinary leases still use fsynced files.
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def directory(path):
    created = False
    try:
        path.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        pass
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise Refusal("ARTIFACT_WINDOW_UNSAFE_DIRECTORY")
    if created:
        flush_directory(path.parent)


def scope(root, slug):
    if not slug or slug in (".", "..") or any(c in slug for c in "/\\\0"):
        raise Refusal("ARTIFACT_WINDOW_INVALID_SCOPE")
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    root = root.resolve(strict=True)
    normalized = unicodedata.normalize("NFC", slug).casefold()
    identity = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    base = root / ".artifact-coordination"
    directory(base)
    base = base / identity
    directory(base)
    directory(base / "writers")
    return base, normalized


def publish(path, value):
    # Call only under the metadata lock; never truncate an existing record.
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    flush_directory(path.parent)


def read(path):
    regular(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise Refusal("ARTIFACT_WINDOW_UNSAFE_METADATA")
    return value


@contextmanager
def metadata_lock(base):
    lock = base / "admission.lock"
    end = time.monotonic() + 5
    while True:
        try:
            lock.mkdir(mode=0o700)
            flush_directory(base)
            break
        except FileExistsError:
            if time.monotonic() >= end:
                raise Refusal("ARTIFACT_WINDOW_ADMISSION_BUSY")
            time.sleep(0.01)
    inode = lock.lstat()
    token = secrets.token_hex(24)
    initialized = False
    try:
        publish(lock / "owner.json", {"pid": os.getpid(), "id": token})
        initialized = True
        yield
    finally:
        # No stale-owner removal, elapsed-time reclaim or blind recursive rm.
        now = lock.lstat()
        if (now.st_dev, now.st_ino) != (inode.st_dev, inode.st_ino):
            raise Refusal("ARTIFACT_WINDOW_LOCK_CHANGED")
        if initialized and read(lock / "owner.json").get("id") == token:
            (lock / "owner.json").unlink()
            flush_directory(lock)
            lock.rmdir()
            flush_directory(base)


def writer_records(base):
    result = []
    for path in sorted((base / "writers").iterdir()):
        record = read(path)
        if record.get("id") != path.name or record.get("kind") != "writer":
            raise Refusal("ARTIFACT_WINDOW_UNKNOWN_WRITER")
        result.append(record)
    return result


def acquire(root, slug, pid, session=None, inherit_holder=False):
    if pid <= 0:
        raise Refusal("ARTIFACT_WINDOW_INVALID_OWNER")
    base, normalized = scope(root, slug)
    with metadata_lock(base):
        if os.path.lexists(base / "window.json"):
            # Only an already-admitted holder can introduce a nested operation.
            # It receives a separate lease: a background child cannot outlive
            # its parent's admission unnoticed. New workflows never opt in.
            parent = os.environ.get("GSTACK_ARTIFACT_WRITER_ID", "")
            parent_pid = os.environ.get("GSTACK_ARTIFACT_WRITER_PID", "")
            if not inherit_holder or not re.fullmatch(r"[0-9a-f]{48}", parent) or not parent_pid.isdigit():
                raise Refusal("ARTIFACT_WINDOW_HELD")
            record = read(base / "writers" / parent)
            if record.get("kind") != "writer" or record.get("id") != parent or record.get("scope") != normalized or record.get("pid") != int(parent_pid):
                raise Refusal("ARTIFACT_WINDOW_HELD")
            process_alive(int(parent_pid))
        token = secrets.token_hex(24)
        value = {"version": 1, "kind": "writer", "id": token,
                 "scope": normalized, "pid": pid, "created": time.time()}
        if session is not None:
            value["session"] = session
            sessions = base.parent / "sessions"
            directory(sessions)
            if os.path.lexists(sessions / session):
                raise Refusal("ARTIFACT_WINDOW_SESSION_EXISTS")
        publish(base / "writers" / token, value)
        if session is not None:
            publish(sessions / session, value)
    return value


def release(root, slug, token):
    base, normalized = scope(root, slug)
    with metadata_lock(base):
        path = base / "writers" / token
        value = read(path)
        if value.get("id") != token or value.get("scope") != normalized:
            raise Refusal("ARTIFACT_WINDOW_WRITER_CHANGED")
        path.unlink()
        flush_directory(path.parent)


def process_alive(pid):
    if pid <= 0:
        raise Refusal("ARTIFACT_WINDOW_INVALID_OWNER")
    if os.name != "nt":
        os.kill(pid, 0)
        return
    # On Windows os.kill(pid, 0) is not a POSIX liveness probe. Query a
    # SYNCHRONIZE-only handle; never send a console event or termination signal.
    if pid > 0xffffffff:
        raise Refusal("ARTIFACT_WINDOW_INVALID_OWNER")
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        raise Refusal("ARTIFACT_WINDOW_OWNER_UNVERIFIED")
    try:
        if kernel.WaitForSingleObject(handle, 0) != 0x102:
            raise Refusal("ARTIFACT_WINDOW_OWNER_UNVERIFIED")
    finally:
        if not kernel.CloseHandle(handle):
            raise Refusal("ARTIFACT_WINDOW_OWNER_UNVERIFIED")


def check_writer(root, slug, token, pid):
    base, normalized = scope(root, slug)
    with metadata_lock(base):
        value = read(base / "writers" / token)
        if value.get("id") != token or value.get("scope") != normalized or value.get("pid") != pid:
            raise Refusal("ARTIFACT_WINDOW_WRITER_CHANGED")
        process_alive(pid)
        return value


def begin(root, slug, pid, seconds):
    if os.name == "nt":
        raise Refusal("ARTIFACT_WINDOW_POSIX_QUALIFICATION_REQUIRED")
    if pid <= 0 or not 1 <= seconds <= 900:
        raise Refusal("ARTIFACT_WINDOW_INVALID_BOUND")
    base, normalized = scope(root, slug)
    with metadata_lock(base):
        if os.path.lexists(base / "window.json"):
            raise Refusal("ARTIFACT_WINDOW_HELD")
        writers = writer_records(base)
        value = {"version": 1, "kind": "window", "id": secrets.token_hex(24),
                 "scope": normalized, "pid": pid, "deadline": time.time() + seconds}
        publish(base / "window.json", value)
        return {**value, "state": "draining" if writers else "exclusive",
                "writers": writers}


def read_window(base, normalized, token):
    value = read(base / "window.json")
    if value.get("id") != token or value.get("scope") != normalized:
        raise Refusal("ARTIFACT_WINDOW_OWNER_CHANGED")
    if (set(value) != {"version", "kind", "id", "scope", "pid", "deadline"}
            or value.get("version") != 1 or value.get("kind") != "window"
            or type(value.get("pid")) is not int or value["pid"] <= 0
            or type(value.get("deadline")) not in (int, float)
            or not math.isfinite(value["deadline"])):
        raise Refusal("ARTIFACT_WINDOW_UNSAFE_METADATA")
    return value


def status(root, slug, token, exclusive=False):
    base, normalized = scope(root, slug)
    with metadata_lock(base):
        value = read_window(base, normalized, token)
        writers = writer_records(base)
        expired = time.time() >= value["deadline"]
        result = {**value, "state": "expired" if expired else "draining" if writers else "exclusive",
                  "writers": writers}
        if exclusive and result["state"] != "exclusive":
            raise Refusal("ARTIFACT_WINDOW_NOT_EXCLUSIVE")
        return result


def release_window(root, slug, token):
    base, normalized = scope(root, slug)
    with metadata_lock(base):
        path = base / "window.json"
        read_window(base, normalized, token)
        path.unlink()
        flush_directory(base)


def release_session(root, session):
    root = Path(root).resolve(strict=True)
    path = root / ".artifact-coordination" / "sessions" / session
    if not os.path.lexists(path):
        return {"status": "not_registered"}
    value = read(path)
    if value.get("session") != session or value.get("kind") != "writer":
        raise Refusal("ARTIFACT_WINDOW_SESSION_CHANGED")
    release(root, value["scope"], value["id"])
    path.unlink()
    flush_directory(path.parent)
    return {"status": "released"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["acquire", "check", "release", "begin", "status", "assert", "end", "run", "session-release"])
    parser.add_argument("root")
    parser.add_argument("slug")
    parser.add_argument("--id")
    parser.add_argument("--owner-pid", type=int, default=os.getppid())
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--session-id")
    parser.add_argument("--token-only", action="store_true")
    parser.add_argument("--inherit-holder", action="store_true")
    argv = sys.argv[1:]
    divider = argv.index("--") if "--" in argv else len(argv)
    command = argv[divider + 1:]
    args = parser.parse_args(argv[:divider])
    if args.token_only and args.action != "acquire":
        raise Refusal("ARTIFACT_WINDOW_INVALID_FORMAT")
    if args.session_id is not None and not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", args.session_id):
        raise Refusal("ARTIFACT_WINDOW_INVALID_SESSION")
    if args.id is not None and (len(args.id) != 48 or any(c not in "0123456789abcdef" for c in args.id)):
        raise Refusal("ARTIFACT_WINDOW_INVALID_ID")
    if args.action in ("check", "release", "status", "assert", "end") and args.id is None:
        raise Refusal("ARTIFACT_WINDOW_INVALID_ID")
    if args.action == "run":
        if not command:
            raise Refusal("ARTIFACT_WINDOW_COMMAND_REQUIRED")
        lease = acquire(args.root, args.slug, os.getpid(), inherit_holder=True)
        try:
            child_env = {**os.environ, "GSTACK_ARTIFACT_WRITER_ID": lease["id"],
                         "GSTACK_ARTIFACT_WRITER_PID": str(os.getpid())}
            child = subprocess.Popen(command, env=child_env)
            return child.wait()
        finally:
            # KeyboardInterrupt/timeout may leave a live child after the holder
            # exits. Its operation is still admitted: keep the durable lease.
            if "child" not in locals() or child.poll() is not None:
                release(args.root, args.slug, lease["id"])
    if command:
        raise Refusal("ARTIFACT_WINDOW_UNEXPECTED_ARGUMENT")
    if args.action == "acquire":
        result = acquire(args.root, args.slug, args.owner_pid, args.session_id, args.inherit_holder and args.session_id is None)
    elif args.action == "session-release":
        if not args.session_id:
            raise Refusal("ARTIFACT_WINDOW_INVALID_SESSION")
        result = release_session(args.root, args.session_id)
    elif args.action == "begin":
        result = begin(args.root, args.slug, args.owner_pid, args.seconds)
    elif args.action == "check":
        result = check_writer(args.root, args.slug, args.id, args.owner_pid)
    elif args.action in ("status", "assert"):
        result = status(args.root, args.slug, args.id, args.action == "assert")
    elif args.action == "release":
        release(args.root, args.slug, args.id)
        result = {"status": "released"}
    else:
        release_window(args.root, args.slug, args.id)
        result = {"status": "released"}
    if args.token_only:
        if args.action != "acquire":
            raise Refusal("ARTIFACT_WINDOW_INVALID_FORMAT")
        print(result["id"])
    else:
        print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('{"status":"refused","code":"ARTIFACT_WINDOW_INTERRUPTED_OWNER_RETAINED"}', file=sys.stderr)
        sys.exit(130)
    except (Refusal, OSError, ValueError, TypeError, KeyError) as error:
        # Do not print foreign file payloads or command arguments.
        print(json.dumps({"status": "refused", "code": str(error) if isinstance(error, Refusal)
                          else "ARTIFACT_WINDOW_IO_OR_METADATA_ERROR"}), file=sys.stderr)
        sys.exit(1)
