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
never captured.

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
  must run on its own: a pipe, `||`, `;`, a redirect or an environment prefix
  hides its real status, so that run does not count.
- No check after the last change failed without passing again later.

A missing exit status, a success message from the agent, and the end of a
turn are not evidence. Any later change, including a shell command that may
write files or a tool gstack does not recognize, cancels earlier checks. If a
captured procedure loses its proof this way, gstack deletes it from HydraDB.
A new prompt after a verified task starts a new task, so later work never
cancels an earlier finished one.

## Check, tune and retry

- `gstack-task-memory status` shows the grant, where the key comes from,
  the retrieval mode, both hooks, and the delivery state of each procedure.
  It makes no network call. `queued` means HydraDB accepted a procedure that
  is not searchable yet.
- Recall uses fast retrieval by default and gives up after 2 seconds. To
  trade latency for better matches, run `gstack-task-memory mode thinking`,
  which allows 5 seconds. A slow or unreachable HydraDB never blocks a prompt.
- A procedure that could not be delivered is retried on the next Stop. To
  retry now, run `gstack-task-memory flush`.
- Hook failures are written to `$GSTACK_STATE_ROOT/hook-errors.log`, and
  `status` shows the most recent ones.

## Turn it off

Run `gstack-task-memory disable` from inside the repository. It revokes that
repository's grant first, so the next prompt and the next Stop send nothing.
The hooks stay while another repository still holds a grant. Add
`--remove-key` to delete the stored key file.

Procedures already stored in HydraDB stay there. `gstack-uninstall` removes
the hooks and every grant.
