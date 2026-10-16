# gstack-brain-lock.sh — the one drain lock for every gstack writer to the
# artifacts repo's git state in $GSTACK_HOME.
#
# This file is NOT executable; source it:
#
#   . "$(dirname "$0")/gstack-brain-lock.sh"
#
# Writers that take it: the drain (gstack-brain-sync --once), the skill-start
# merge (gstack-skill-start), gstack-artifacts-init, gstack-brain-restore and
# gstack-gbrain-source-wireup. Holding it is what lets the drain treat an old
# .git/index.lock as abandoned: no other gstack writer can be running git there.
#
# Provides:
#   gstack_brain_lock_acquire <gstack_home> <try|wait>
#     Returns 0 when this process holds the lock afterwards, 1 otherwise.
#     try  — give up at once when a live process holds it.
#     wait — retry once a second for GSTACK_BRAIN_LOCK_WAIT seconds (default
#            120), then give up.
#     A child of the holder (the drain runs the wireup's daily advance; restore
#     runs the wireup) inherits GSTACK_BRAIN_LOCK_TOKEN; when it matches the
#     lock's owner file the child proceeds without taking or releasing it.
#     On failure, _GSTACK_BRAIN_LOCK_HOLDER names the holder's pid (or "").
#   gstack_brain_lock_release
#     Removes the lock only when this process took it and still owns it.
#
# The lock is a directory (mkdir is atomic on every POSIX filesystem; flock(1)
# is not on macOS) holding `pid` and `owner`. A lock whose pid is dead is
# stale and requires inspection. Missing owner metadata also refuses acquisition.

_GSTACK_BRAIN_LOCK_DIR=""
_GSTACK_BRAIN_LOCK_MINE=0
_GSTACK_BRAIN_LOCK_HOLDER=""

_gstack_brain_lock_try_once() {
  local dir="$1" pid
  if mkdir "$dir" 2>/dev/null; then
    GSTACK_BRAIN_LOCK_TOKEN="$$-${RANDOM:-0}-$(date +%s 2>/dev/null || echo 0)"
    export GSTACK_BRAIN_LOCK_TOKEN
    if ! printf '%s\n' "$$" > "$dir/pid" || ! printf '%s\n' "$GSTACK_BRAIN_LOCK_TOKEN" > "$dir/owner"; then
      echo "gstack: lock owner initialization failed; preserve $dir for inspection" >&2
      return 1
    fi
    _GSTACK_BRAIN_LOCK_MINE=1
    return 0
  fi
  # Unknown/dead ownership is an explicit recovery condition. Never remove a
  # lock after a liveness sample: another contender may now own that pathname.
  if [ -f "$dir/pid" ]; then
    _GSTACK_BRAIN_LOCK_HOLDER=$(head -1 "$dir/pid" 2>/dev/null || echo "")
  fi
  return 1
}

gstack_brain_lock_acquire() {
  local home="$1" mode="${2:-try}" waited=0 limit
  _GSTACK_BRAIN_LOCK_DIR="$home/.brain-sync.lock.d"
  _GSTACK_BRAIN_LOCK_MINE=0
  _GSTACK_BRAIN_LOCK_HOLDER=""
  if [ -n "${GSTACK_BRAIN_LOCK_TOKEN:-}" ] && [ -f "$_GSTACK_BRAIN_LOCK_DIR/owner" ] \
      && [ "$(head -1 "$_GSTACK_BRAIN_LOCK_DIR/owner" 2>/dev/null)" = "$GSTACK_BRAIN_LOCK_TOKEN" ]; then
    return 0
  fi
  mkdir -p "$home" 2>/dev/null || true
  limit="${GSTACK_BRAIN_LOCK_WAIT:-120}"
  case "$limit" in ''|*[!0-9]*) limit=120 ;; esac
  while :; do
    _gstack_brain_lock_try_once "$_GSTACK_BRAIN_LOCK_DIR" && return 0
    # A stale lock was just cleared: take it now instead of after a sleep.
    [ -d "$_GSTACK_BRAIN_LOCK_DIR" ] || { _gstack_brain_lock_try_once "$_GSTACK_BRAIN_LOCK_DIR" && return 0; }
    [ "$mode" = "wait" ] || return 1
    [ "$waited" -ge "$limit" ] && return 1
    sleep 1
    waited=$(( waited + 1 ))
  done
}

gstack_brain_lock_release() {
  [ "$_GSTACK_BRAIN_LOCK_MINE" = "1" ] || return 0
  if [ "$(head -1 "$_GSTACK_BRAIN_LOCK_DIR/owner" 2>/dev/null)" = "${GSTACK_BRAIN_LOCK_TOKEN:-}" ]; then
    rm -rf "$_GSTACK_BRAIN_LOCK_DIR" 2>/dev/null || true
  fi
  _GSTACK_BRAIN_LOCK_MINE=0
  unset GSTACK_BRAIN_LOCK_TOKEN
  return 0
}
