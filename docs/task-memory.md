# HydraDB task memory

HydraDB task memory remembers how earlier tasks in a repository were done
and shows that history to Claude Code when a related prompt comes up. After
a turn in which the agent edited files and then ran a test command that
passed, gstack records the procedure: what the task was, which files changed,
and which checks passed. On a later prompt in the same repository, the
closest matching procedures appear as reference context.

It is off by default, works one repository at a time, and needs a
[HydraDB](https://docs.hydradb.com/get-started/v2/introduction) API key. It
supports Claude Code only.

## Turn it on

Run `enable` from inside the repository you want remembered:

```bash
gstack-task-memory enable
```

`enable` shows what each part sends, then asks for consent to capture and to
recall separately. It reads the API key from `HYDRA_DB_API_KEY`, the key file
an earlier `enable` stored, or a hidden prompt. It then creates the database
(`gstack_task_memory` unless you pass `--database <name>`), registers two
Claude Code hooks at your stable gstack install, and records the grant for
this repository.

Variations:

- To capture without querying on prompts, run `gstack-task-memory enable --capture`.
- To query on prompts without capturing, run `gstack-task-memory enable --recall`.
- To enable from a script, pipe the key and give consent up front:
  `printf '%s\n' "$KEY" | gstack-task-memory enable --yes --key-stdin`.

The key is never accepted as an argument. A key you enter is stored in
`$GSTACK_STATE_ROOT/task-memory/hydradb.key` with mode 0600, and
`HYDRA_DB_API_KEY` takes precedence over it. A key file that other users can
read is refused.

Running `enable` again replaces the grant. Work from before the new grant is
never captured. A procedure an earlier grant sent to the same database is
still removed if it later loses its proof; a grant for a different database
leaves the old one alone.

## What leaves your machine

Every request goes to `https://api.hydradb.com`. gstack writes an egress
receipt before each request and skips the request when it cannot. Review the
receipts with `gstack-egress list --sink hydradb-task-memory`, and the grant
with `gstack-egress grants`.

| Part | When | What is sent |
| --- | --- | --- |
| Capture | After each Claude Code turn, from a background process | One Markdown procedure per verified task: the first line of the prompt that started it (redacted, 160 characters at most), the repository-relative paths of the edited files in order, and each passing test command with its pass count |
| Recall | On each prompt in a granted repository | The prompt as a search query: code blocks removed, redacted, 512 characters at most |

Transcripts, file contents, diffs, tool output and credentials are never
sent. A prompt that contains a credential is not sent at all. Procedures are
stored as HydraDB memories with inference off, so HydraDB keeps the text
exactly as gstack wrote it.

Each repository gets its own collection, named from its `origin` remote, so
every clone and worktree shares it. Recall shows a result only when its
metadata names the same repository. Results appear inside an untrusted-content
envelope, and their commands are never run for you.

## What counts as a verified task

A task is captured only when the session itself shows that it worked:

- The agent changed at least one file in the repository with Edit, Write,
  MultiEdit or NotebookEdit.
- After the last change, a test command ran and its own output reports a
  complete result with passing tests and no failures. `bun test`, `pytest`,
  `cargo test`, `vitest` and `jest` summaries are recognized. The command
  must run on its own: a pipe, `||`, `;`, an environment prefix, output sent
  to `/dev/null` or a `cd` into a subdirectory hides its real status, so that
  run never counts as a pass.
- No later run of a check failed or ended without a readable result. This
  includes masked runs: `bun test || true` that reports a failure, a run that
  was interrupted, and a run that has not returned yet all cancel the earlier
  pass until the same check passes again.

A missing exit status, a success message from the agent, and the end of a
turn are not evidence. Any later change cancels earlier checks. A change is
an edit, a tool gstack does not recognize, or a shell command that may write
files: a redirect into a file, a background job (`&`), command substitution,
`git commit` (its hooks can edit files), `git fetch`, `git remote set-url`, a
snapshot update such as `bun test -u`, or any command gstack cannot read.
Reading commands such as `git status`, `git diff`, `ls` and `grep`, and the
agent's own task-list tools, cancel nothing. A new prompt after a verified
task starts a new task, so later work never cancels an earlier finished one.

If a captured procedure loses its proof, recall on this machine stops showing
it at once, and gstack asks HydraDB to delete it. HydraDB deletes an entry
only after it finishes indexing it, so the deletion can stay pending for a
while, and longer if HydraDB is unreachable. Until HydraDB accepts it, other
machines that share the repository's collection can still recall the
procedure.

## Check, tune and retry

- `gstack-task-memory status` shows the grant, where the key comes from,
  the retrieval mode, both hooks, and the state of each procedure. It makes
  no network call. `pending` is not yet accepted by HydraDB, `processing` is
  accepted but not searchable, `searchable` can be recalled while HydraDB
  finishes indexing, and `indexed` is complete. `retracting` waits for HydraDB
  to accept a deletion, `rejected` was refused as malformed and is not resent,
  and `stale` was never sent before the grant was replaced.
- Recall uses fast retrieval by default and gives up after 2 seconds. To
  trade latency for better matches, run `gstack-task-memory mode thinking`,
  which allows 5 seconds. A slow or unreachable HydraDB never blocks a prompt.
- Work that could not be delivered, including a deletion, is retried by a
  later Stop from any session in the repository, after a wait that doubles
  with each failure up to an hour. That covers a refused key, a missing
  database, an outage and failed indexing. After you fix the key or the
  database, run `gstack-task-memory flush` to retry now. `flush` sends only
  what capture already recorded and never reads old transcripts.
- Hook failures are written to `$GSTACK_STATE_ROOT/hook-errors.log`, and
  `status` shows the most recent ones.

## Turn it off

Run `gstack-task-memory disable` from inside the repository. It revokes that
repository's grant first, so the next prompt and the next Stop send nothing.
An `enable` still waiting for the database is cancelled and enables nothing.
The hooks stay while another repository still holds a grant. Add
`--remove-key` to delete the stored key file.

Procedures already stored in HydraDB stay there. `gstack-uninstall` removes
the hooks and every grant.
