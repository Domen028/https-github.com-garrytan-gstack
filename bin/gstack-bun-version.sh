# shellcheck shell=bash
# gstack-bun-version.sh — the one source for the Bun versions gstack needs.
# Sourced, never executed: ./setup refuses or warns from it before writing
# anything, and bin/gstack-session-update and /gstack-upgrade read the
# INCOMING release's floor (gstack_bun_incoming_hold) before advancing a
# live checkout. test/bun-version-drift.test.ts
# keeps it equal to package.json engines.bun, every CI pin, setup's install
# hint and README. Bash 3.2 builtins only.
#
# GSTACK_BUN_FLOOR is the security floor. Older Bun accepts
# --no-compile-autoload-dotenv/--no-compile-autoload-bunfig but ignores them,
# so gstack's compiled tools would read a project's .env. Verified by a
# compiled probe (a binary built with all four no-autoload flags, run beside a
# .env): Bun 1.3.2 loads it, 1.3.3 and 1.4.0 do not.
# GSTACK_BUN_TESTED is the supported minimum: the CI pin and engines.bun.
GSTACK_BUN_FLOOR="1.3.3"
GSTACK_BUN_TESTED="1.4.2"

# gstack_bun_archive_sha256 TARGET [VERSION] — the SHA-256 of
# https://github.com/oven-sh/bun/releases/download/bun-v$VERSION/bun-TARGET.zip
# (VERSION defaults to $GSTACK_BUN_TESTED) from that release's SHASUMS256.txt,
# for the targets bin/gstack-capy-install installs on Capy cloud machines (the
# same exact-archive recipe as .github/docker/Dockerfile.ci;
# test/bun-version-drift.test.ts keeps the $GSTACK_BUN_TESTED rows equal). A
# newer version is listed so the installer can follow a project's exact pin
# above the minimum. Prints nothing and returns 1 without a verified archive.
GSTACK_BUN_VERIFIED="1.4.2 1.4.3"
gstack_bun_archive_sha256() {
  case "${2:-$GSTACK_BUN_TESTED}" in
    1.4.2) case "$1" in
      linux-x64) echo 36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913 ;;
      linux-x64-baseline) echo c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f ;;
      linux-aarch64) echo 54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
      *) return 1 ;;
    esac ;;
    1.4.3) case "$1" in
      linux-x64) echo 3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18 ;;
      linux-x64-baseline) echo 1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b ;;
      linux-aarch64) echo efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21 ;;
      *) return 1 ;;
    esac ;;
    *) return 1 ;;
  esac
}

# _gstack_bun_parse <version> — sets _gb_core ("MAJOR MINOR PATCH" as decimal
# integers) and _gb_pre (prerelease, may be empty); returns 1 when malformed.
# A leading "v" and "+build" metadata are ignored.
_gstack_bun_parse() {
  _gb_v="${1#v}"; _gb_v="${_gb_v%%+*}"; _gb_pre=""
  case "$_gb_v" in
    *-*) _gb_pre="${_gb_v#*-}"; _gb_v="${_gb_v%%-*}"; [ -n "$_gb_pre" ] || return 1 ;;
  esac
  case "$_gb_v" in *.*.*) ;; *) return 1 ;; esac
  _gb_maj="${_gb_v%%.*}"; _gb_rest="${_gb_v#*.}"; _gb_min="${_gb_rest%%.*}"; _gb_pat="${_gb_rest#*.}"
  case "$_gb_maj" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_min" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_pat" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_pre" in *[!0-9A-Za-z.-]*) return 1 ;; esac
  _gb_core="$((10#$_gb_maj)) $((10#$_gb_min)) $((10#$_gb_pat))"
}

# _gstack_bun_below <version> <release> — returns 0 when version sorts below
# the release, 1 when it does not, and 2 when either cannot be parsed (callers
# never read 2 as "not below"). Prerelease rule (semver): 1.3.3-canary.1 is
# below 1.3.3 and above 1.3.2, so a prerelease of the floor itself is refused.
# The release's fields are copied into quoted positional parameters before the
# second parse, so the comparison does not depend on word splitting (zsh does
# not split; #3195).
_gstack_bun_below() {
  _gstack_bun_parse "$2" || return 2
  set -- "$1" "$_gb_maj" "$_gb_min" "$_gb_pat"
  _gstack_bun_parse "$1" || return 2
  [ "$((10#$_gb_maj))" -ne "$((10#$2))" ] && { [ "$((10#$_gb_maj))" -lt "$((10#$2))" ]; return; }
  [ "$((10#$_gb_min))" -ne "$((10#$3))" ] && { [ "$((10#$_gb_min))" -lt "$((10#$3))" ]; return; }
  [ "$((10#$_gb_pat))" -ne "$((10#$4))" ] && { [ "$((10#$_gb_pat))" -lt "$((10#$4))" ]; return; }
  [ -n "$_gb_pre" ]
}

# gstack_bun_status <version> [floor] — prints too-old, untested, ok or
# malformed (the version or the floor cannot be parsed). The optional floor
# lets the auto-updater apply the incoming release's floor with this
# release's comparison rule.
gstack_bun_status() {
  _gstack_bun_below "$1" "${2:-$GSTACK_BUN_FLOOR}"
  case $? in
    0) echo too-old ;;
    1) _gstack_bun_below "$1" "$GSTACK_BUN_TESTED"
       case $? in 0) echo untested ;; 1) echo ok ;; *) echo malformed ;; esac ;;
    *) echo malformed ;;
  esac
}

# gstack_bun_incoming_hold <git-dir> <rev> — the pre-advance check shared by
# the auto-updater and /gstack-upgrade. Reads the floor from <rev>'s copy of
# this file and checks the `bun` setup will run (first on PATH). Below that
# floor it prints the held reason and returns 0. A version it cannot compare
# also holds (bun-version-unreadable, BUN_VERSION_UNREADABLE), with the bun
# path and its output passed through gstack_sanitize_echo
# (bin/gstack-sanitize-echo.sh in <git-dir>). Otherwise it prints nothing and
# returns 1 (no bun, or no floor in <rev>). The comparison rule is this release's.
gstack_bun_incoming_hold() {
  command -v bun >/dev/null 2>&1 || return 1
  _gb_floor=$(git -C "$1" show "$2:bin/gstack-bun-version.sh" 2>/dev/null | sed -n 's/^GSTACK_BUN_FLOOR="\([0-9A-Za-z.+-]*\)".*/\1/p' | head -1)
  [ -n "$_gb_floor" ] || return 1
  _gb_found=$(bun --version 2>/dev/null | head -1)
  case "$(gstack_bun_status "$_gb_found" "$_gb_floor")" in
    too-old) ;;
    malformed)
      echo "bun-version-unreadable: could not read the version of Bun at $( (. "$1/bin/gstack-sanitize-echo.sh" && gstack_sanitize_echo "$(command -v bun)") 2>/dev/null) (bun --version printed '$( (. "$1/bin/gstack-sanitize-echo.sh" && gstack_sanitize_echo "$_gb_found") 2>/dev/null)'); gstack $(git -C "$1" show "$2:VERSION" 2>/dev/null | head -1 | tr -cd '0-9A-Za-z.+-') needs $_gb_floor or newer (BUN_VERSION_UNREADABLE)"
      return 0 ;;
    *) return 1 ;;
  esac
  _gb_ver=$(git -C "$1" show "$2:VERSION" 2>/dev/null | head -1)
  echo "bun-too-old: found Bun $_gb_found at $(command -v bun); gstack ${_gb_ver:-update} needs $_gb_floor or newer"
}

# gstack_bun_launch_dir [exact] — the directory to put first on PATH so
# gstack's `#!/usr/bin/env bun` bins run a supported Bun: the first of
# $BUN_INSTALL/bin and $HOME/.bun/bin whose bun is ok (and equals <exact>
# when given), unless the bun already first on PATH qualifies. Prints the
# directory (callers read its version with "<dir>/bun --version"); prints
# nothing and returns 1 when PATH's bun suffices or no candidate qualifies. Shared by
# gstack-capy-install (the GSTACK_LAUNCH line) and gstack-doctor --check (the
# runtime row's `found at ... (not on PATH)`).
gstack_bun_launch_dir() {
  _gb_path_bun=$(command -v bun 2>/dev/null || true)
  if [ -n "$_gb_path_bun" ]; then
    _gb_v=$(bun --version </dev/null 2>/dev/null | head -1)
    if [ "$(gstack_bun_status "$_gb_v")" = ok ] && { [ -z "${1:-}" ] || [ "$_gb_v" = "$1" ]; }; then return 1; fi
  fi
  for _gb_dir in "${BUN_INSTALL:+$BUN_INSTALL/bin}" "${HOME:+$HOME/.bun/bin}"; do
    [ -n "$_gb_dir" ] && [ -x "$_gb_dir/bun" ] || continue
    [ "$_gb_dir/bun" = "$_gb_path_bun" ] && continue
    _gb_v=$("$_gb_dir/bun" --version </dev/null 2>/dev/null | head -1)
    [ "$(gstack_bun_status "$_gb_v")" = ok ] || continue
    [ -z "${1:-}" ] || [ "$_gb_v" = "$1" ] || continue
    printf '%s\n' "$_gb_dir"
    return 0
  done
  return 1
}
