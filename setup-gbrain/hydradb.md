# Optional HydraDB memory

HydraDB is an optional search backend for the GBrain that gstack already uses.
It keeps older memory available when the local working set is smaller. GBrain
still owns writes, source permissions and the local fallback. No separate HydraDB
SDK or API key is needed inside gstack.

## Connect

Run `/setup-gbrain --hydradb` (fast by default), or
`/setup-gbrain --hydradb --mode thinking`. On an existing working brain, do only
this connection step and its verification; do not reinitialize or migrate it.

1. Verify `gbrain cloud --help` exposes `connect`, `mode` and `primary`.
   This requires the optional cloud-memory feature in GBrain
   ([upstream PR #6695](https://github.com/garrytan/gbrain/pull/6695)). If absent,
   report the dependency and keep normal GBrain working. Do not silently install
   an unmerged branch or reinterpret HydraDB as a PGLite/Postgres engine.
2. Explain that connecting copies this brain's eligible pages, past and future,
   to HydraDB. This is separate from repo-import and transcript-capture consent.
   A whole shared brain may include other sources; its owner must authorize this.
   Ask for cloud-copy consent unless already explicitly given. Declining leaves
   GBrain working normally. Private/quarantined pages are excluded by GBrain.
3. Have the user run the appropriate command in a terminal. The native prompt
   handles consent and the API key from <https://dashboard.hydradb.com>:

   ```bash
   gbrain cloud connect --mode fast
   # Or, when the user selected thinking:
   gbrain cloud connect --mode thinking
   ```

   Never ask for a key in chat or put it in argv, the repository or gstack config.
   With consent already given and `HYDRA_DB_API_KEY` securely available in the
   process environment, `--yes` permits a noninteractive connect. Otherwise hand
   the terminal command to the user. A remote MCP client cannot administer the
   host's cloud connection: its owner runs these commands on the brain host.
4. Check `gbrain cloud status --json`. Require `connected: true`, `primary: true`,
   a non-null `key`, and the chosen `mode`. A declined connection can exit zero;
   exit status alone is not proof. If provisioning/backfill is still pending,
   report it; run `gbrain cloud push` when the database is ready before claiming
   existing history is searchable.
5. Persist the semantic context budget with the installed `gstack-config`:

   ```bash
   gstack-config set brain_query_timeout_ms 10000   # fast
   # Or for thinking:
   gstack-config set brain_query_timeout_ms 30000
   ```

   Use its absolute install path when it is not on PATH. No shell profile edit
   or agent restart is needed for this setting. `GSTACK_BRAIN_TIMEOUT_MS`, when
   present in the agent environment, overrides it; report an overriding value
   below the selected budget rather than claiming the setup is ready.
6. Run a representative `gbrain query "<known memory question>"` from the same
   project/source as the agent, and the normal `gstack-brain-context-load.ts`
   helper with `--skill <active-skill> --repo <repo-slug> --explain`.
   Confirm returned readable memory reaches the datamarked context block.
   GBrain falls back locally during an outage: a successful query alone does
   not prove a HydraDB round trip. When inspecting MCP protocol responses, require
   `_meta.retrieval.backend: "hydradb"` before reporting cloud retrieval as verified;
   otherwise report the connection and context-load checks separately.

## Change modes or return to normal GBrain

```bash
gbrain cloud mode thinking
gstack-config set brain_query_timeout_ms 30000

gbrain cloud mode fast
gstack-config set brain_query_timeout_ms 10000

gbrain cloud primary off          # search locally; cloud syncing continues
gbrain cloud disconnect           # stop cloud retrieval and syncing
gstack-config unset brain_query_timeout_ms  # restore the 500ms context budget
```

Disconnect preserves local GBrain data and the cloud copy. Deleting that copy
requires the separate `gbrain cloud disconnect --purge-cloud` action. Writes
continue through GBrain; saved facts, lists and structural code lookups retain
their normal behavior. Automatic transcript capture remains separately opt-in.
Cloud-only passages have no local page to fetch: use their returned Markdown
and provenance, rather than calling `gbrain get` with a made-up slug.
