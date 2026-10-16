# Source after resolving state root and slug, before reading or writing project
# content. The external holder spans the re-executed command, including close.
gstack_artifact_write_reexec() {
  local home="$1" slug="$2" entry="$3" helper
  shift 3
  helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gstack-artifact-window.py"
  # Only the holder's direct child can skip self-reexecution. An inherited
  # environment in a sibling/nested writer is not an admission lease.
  if [ -n "${GSTACK_ARTIFACT_WRITER_ID:-}" ] && [ "${GSTACK_ARTIFACT_WRITER_PID:-}" = "$PPID" ] \
      && python3 "$helper" check "$home" "$slug" --id "$GSTACK_ARTIFACT_WRITER_ID" --owner-pid "$PPID" >/dev/null; then
    return 0
  fi
  exec python3 "$helper" run "$home" "$slug" -- bash "$entry" "$@"
}
