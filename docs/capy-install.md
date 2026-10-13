# Installing gstack on a Capy cloud machine

Three layers, each owned by gstack:

| Layer | Where | Job |
|---|---|---|
| Bootstrapper | `capy/skill/gstack/scripts/install.sh` (copied once into the owner's Drive skill folder; frozen) | clone when absent; fetch origin's default branch and read the supported minimum from `FETCH_HEAD:capy/support.env`; in install mode fast-forward a clean, unpinned checkout below it; exec the full wrapper |
| Full wrapper | `bin/gstack-capy-session` (moves with the checkout) | map the session start onto the installer: `--check` certifies, otherwise install or repair |
| Installer | `bin/gstack-capy-install` | Bun, both host profiles, the doctor, the install verdict, the launch line, the trailer |

The vendored skill (`capy/skill/gstack/SKILL.md`) tells a Capy agent how to use
them. The Drive folder is a mirror: the owner copies `capy/skill/gstack/` there
when asked; nothing writes the Drive automatically.

Direct use, without the skill:

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.local/share/gstack
~/.local/share/gstack/bin/gstack-capy-install --for autoplan
```

## Session start

1. `bash <skill>/scripts/install.sh --check --for <skill>` (under a second when
   a checkout exists). It fetches refs only and never moves the checkout. With
   no checkout it prints `gstack: fail not-installed — ...` and the session
   records that line and continues when it runs no gstack workflow; install
   right before the first workflow.
2. When the trailer is `gstack: fail revision ...` or `gstack: fail runtime ...`
   and a checkout exists, run the same command without `--check`. Below the
   supported minimum, a clean checkout on the remote default branch is
   fast-forwarded (`gstack-capy-skill: upgraded <old> -> <new>`), reinstalled
   and rechecked as one transaction under `.gstack-capy-install.lock` (the
   bootstrapper holds it and hands it over with `GSTACK_CAPY_LOCK_HELD=1`).
   A pinned (`--revision`, detached HEAD, another branch), dirty or diverged
   checkout is never moved; the trailer names the cause and the exact commands
   ([REVISION_BELOW_MINIMUM](troubleshooting.md#revision-below-minimum)).
   `GSTACK_CAPY_AUTO_UPGRADE=0` disables the fast-forward.
3. When the fetch fails (offline), the bootstrapper says `remote minimum
   unknown (fetch failed)` and checks the local install only; it never claims
   the minimum.

The upgrade target is always the tip of the default branch: every commit there
is a stamped release that passed CI. Recovery runs forward, never back: an
install interrupted after a fast-forward leaves the trailer `fail`, and the
next install or `bin/gstack-upgrade` run completes the pending install stages
(setup is never skipped after a fast-forward) or refuses and names the cause.
Checking out an older commit is not a supported rollback; it does not undo
setup migrations that already ran.

Between minimums, `bin/gstack-upgrade --check` says `current <v>` or `behind
<installed> -> <remote> (<n> commits)`, and `bin/gstack-upgrade` fast-forwards
and reinstalls (`bin/gstack-capy-install` on a Capy install, else `./setup
--refresh-registered`). It refuses a dirty, diverged or pinned checkout with
[UPGRADE_REFUSED](troubleshooting.md#upgrade-refused) and never stashes or
resets.

## What the installer does

1. Reuses the checkout it lives in (or clones into `--root <dir>`), under the
   lock. It never resets or pulls; `--revision <ref>` pins a fresh clone, and an
   existing checkout at another revision is reused with the trailer note
   `(requested <ref>; run <checkout>/bin/gstack-upgrade to move)`.
2. Preflight: `git`, `curl`, `node`, `jq`, then Bun. A supported Bun already in
   `$BUN_INSTALL/bin` (default `~/.bun/bin`) is reused. The project's pins
   (`--project <path>`, default the git toplevel of the current directory) are
   read with the doctor's own parser (`bin/gstack-runtime-pins.ts`: engines,
   packageManager, `.tool-versions`, `.bun-version` and CI `bun-version:` lanes
   for this platform). When neither the Bun on PATH nor the installed one
   satisfies gstack's minimum and the pins, the installer downloads one exact
   release archive, verifies its SHA-256 against `bin/gstack-bun-version.sh`
   and installs it into `$BUN_INSTALL/bin`, beside any different system Bun (no
   symlink into a shared bin directory). That archive is the supported minimum
   (1.4.2), or the project's exact pin when it is above the minimum and gstack
   carries a verified archive for it (`GSTACK_BUN_VERIFIED`: 1.4.2, 1.4.3), so a
   repo whose CI pins `bun-version: 1.4.3` gets 1.4.3. With an exact pin, only
   that version satisfies it. Any other exact pin (below the minimum, two
   different ones, or one without a verified archive), or a range gstack's
   minimum does not satisfy, stops with both
   constraints ([RUNTIME_PIN_CONFLICT](troubleshooting.md#capy-install-runtime-conflict),
   exit 3) before `./setup`. With no Bun at or above the security floor, the
   verified one is installed first so the pins can be read.
3. `./setup --host claude --no-prefix`, then `./setup --host codex --model
   gpt-6-astra`, both with `--no-browser`. Skipped when this exact HEAD was set
   up with the same hosts, model and browser flag (recorded in the git dir
   after a successful setup) and `gstack-doctor --check` passes; a warm rerun
   takes about a second.
4. `gstack-doctor --check` for the requested workflow (`--for <skill>`,
   `--only <skill>`, or `--require <id,id>`; default `claude,codex,patch`),
   run with the launch PATH, so the trailer certifies the Bun workflows run.
5. The install verdict, written atomically to
   `<state root>/install-verdicts/<sha256 of the checkout realpath>.json`:
   checkout, HEAD, the workflow and required components it certified, whether
   pins were skipped as planning-only, the trailer, the remote minimum, the
   launch PATH and the time.

`--check` runs only steps 4 and 5 (no clone, Bun install or setup).

## The one line to grep

The last line is the trailer:

```
gstack: ok 1.91.96.0 for=autoplan
gstack: fail runtime,pins
```

Exit 0 only with `gstack: ok`. Read the exit status and the trailer directly:

```bash
out=$(bash <skill>/scripts/install.sh --check --for autoplan 2>&1); rc=$?
printf '%s\n' "$out" | grep '^gstack: '
[ "$rc" -eq 0 ]
```

Never pipe `--check` (or the installer) through `tail`, `head` or `grep`
alone: the pipe's exit status replaces the doctor's, and a silent failure is
the incident this installer exists to end. Every `FAIL <id>` row carries a
`fix:` clause and a reason code with its [troubleshooting
anchor](troubleshooting.md#install-check-gstack-doctor---check-and-the-capy-installer).
A parent agent confirms each subagent machine with this grep; one machine's
install never covers another, and a subagent's first report carries its own
`gstack:` line.

`SKIP pins (planning-only; repo pins differ: ..., launch bun <v>)` is not a
failure: planning workflows (`--for autoplan`, the plan reviews,
`office-hours`) never run the target repo's tests. Workflows that do (`review`,
`ship`, `qa`) and `--require` keep `pins` required.

When a lane reports to another thread (a handoff, a `gstack-lane-check`
result, a coordinator contract), store and use the full thread id (`jam_…`)
in the message, never the short display code: the code is a label the app
renders, the id is what another agent can address and what the evidence bundle
records. `UBI_OWNER` and lane ownership records take the same full id.

## Browser

The default install prints `SKIP browser (lazy; gstack-browser-ensure
installs on first use)` and downloads nothing. The first browser skill run
(`/browse`, `/qa`, `/design-review`, ...) calls `bin/gstack-browser-ensure`
from its preflight, which installs Chromium (~115 MiB, about 86 s on a Capy
machine) under setup's lock and prints `BROWSER_OK` or `BROWSER_UNAVAILABLE
<reason>`. `--with-browser` installs it during the install instead, and the
installer then prints the planning-only install time and the browser bootstrap
time separately.

## The launch line

Every successful run, `--check` included, prints before the trailer:

```
GSTACK_LAUNCH: PATH=<dir>:$PATH GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=<path> GSTACK_EPHEMERAL=1 GSTACK_CAPY=1 GSTACK_INSTALL_VERDICT=<file>
GSTACK_LAUNCH_PATH: <dir>
```

`PATH=<dir>:$PATH` and `GSTACK_LAUNCH_PATH` appear only when the certified Bun
is not first on PATH (the Capy image's `/usr/local/bin/bun` is 1.3.14; 57 gstack
commands start with `#!/usr/bin/env bun`). A child shell's `export` cannot
configure the parent's later commands, so the parent supplies these
assignments to every gstack command it launches (prefix the command, or
export them once in the shell that runs it). A fresh shell without them keeps
reporting the Bun it would really run: `FAIL runtime — bun 1.3.14 at
/usr/local/bin/bun ...; verified bun 1.4.2 found at ~/.bun/bin (not on PATH);
fix: export PATH="$HOME/.bun/bin:$PATH" or prefix commands with the
GSTACK_LAUNCH line`.

`GSTACK_EPHEMERAL=1` tells gstack the disk vanishes with the machine, so the
doctor's `state root` row reads `durable=no` and unattended runs say
`learnings: skipped` instead of writing silently. A durable root is opt-in:
set `GSTACK_STATE_ROOT` to a directory that outlives the machine. The
installer never writes to the Capy drive. See
[docs/state-root.md](state-root.md#ephemeral-machines).

`GSTACK_CAPY=1` turns on install admission. An unattended session (any host)
refuses to start a workflow on a Bun below the supported minimum; with
`GSTACK_CAPY=1`, an unattended or `GSTACK_SESSION_KIND=spawned` session also
needs a passing verdict for this checkout, its current HEAD and a workflow at
least as wide as the one starting. A refusal prints `INSTALL: fail ...` and
`GSTACK_RESULT: skill=<s> status=refused run=-` and exits 3
([INSTALL_UNVERIFIED](troubleshooting.md#install-unverified)). Ambient
spawned sessions (OpenClaw) only warn. `GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1`
admits anyway and says so.

## Bake into a Capy snapshot

Machines that never run a workflow should not pay the install (about 30 s
cold). A project that runs gstack on most machines can bake it instead: the
project Setup's initialize step runs

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.local/share/gstack
~/.local/share/gstack/bin/gstack-capy-install --require claude,codex,patch
```

and snapshots capture `$HOME` (the checkout, `~/.bun/bin`, both host
profiles). Each session then pays only the `--check`. A baked revision still
moves forward at session start when it falls below the supported minimum, and
the baked `~/.bun/bin` reaches workflows through the `GSTACK_LAUNCH` line. The
project Setup is shared by every thread in the project, so changing it is the
project's decision.

## Raising the supported minimum

`capy/support.env` holds `GSTACK_MIN_REVISION` and `GSTACK_CAPY_MIN_WRAPPER`.
Raise `GSTACK_MIN_REVISION` only for install-honesty or security fixes, at
stamp time, to the VERSION being released: every machine below it is
fast-forwarded at its next session start. It never exceeds VERSION
(test/capy-skill-wrapper.test.ts). Raise `GSTACK_CAPY_MIN_WRAPPER` together with
`GSTACK_CAPY_WRAPPER` in the bootstrapper when the bootstrapper itself
changes; older Drive copies keep working and print an owner action
([CAPY_WRAPPER_STALE](troubleshooting.md#capy-wrapper-stale)).

## Exit codes

| Exit | Meaning |
|-----:|---------|
| 0 | `gstack: ok` — every required component passed |
| 1 | `gstack: fail <ids>` — a required component failed; each row has a fix |
| 2 | usage error |
| 3 | preflight stopped before `./setup` (`INSTALL_PREFLIGHT_FAILED`, `RUNTIME_PIN_CONFLICT`); nothing was installed |
