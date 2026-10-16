# DX Hall of Fame Reference

Read ONLY the section for the current review pass. Do NOT load the entire file.

## Pass 1: Getting Started

**Gold standards:**
- **Stripe**: 7 lines of code to charge a card. Docs pre-fill YOUR test API keys when logged in. Stripe Shell runs CLI inside docs page. No local install needed.
- **Vercel**: `git push` = live site on global CDN with HTTPS. Every PR gets preview URL. One CLI command: `vercel`.
- **Clerk**: `<SignIn />`, `<SignUp />`, `<UserButton />`. 3 JSX components, working auth with email, social, MFA out of the box.
- **Supabase**: Create a Postgres table, auto-generates REST API + Realtime + self-documenting docs instantly.
- **Firebase**: `onSnapshot()`. 3 lines for real-time sync across all clients with offline persistence built-in.
- **Twilio**: Virtual Phone in console. Send/receive SMS without buying a number, no credit card. Result: 62% improvement in activation.

**Anti-patterns:**
- Email verification before any value (breaks flow)
- Credit card required before sandbox
- "Choose your own adventure" with multiple paths (decision fatigue; one golden path wins)
- API keys hidden in settings (Stripe pre-fills them into code examples)
- Static code examples without language switching
- Separate docs site from dashboard (context switching)

## Pass 2: API/CLI/SDK Design

**Gold standards:**
- **Stripe prefixed IDs**: `ch_` for charges, `cus_` for customers. Self-documenting. Impossible to pass wrong ID type.
- **Stripe expandable objects**: Default returns ID strings. `expand[]` gets full objects inline. Nested expansion up to 4 levels.
- **Stripe idempotency keys**: Pass `Idempotency-Key` header on mutations. Safe retries. No "did I double-charge?" anxiety.
- **Stripe API versioning**: First call pins account to that day's version. Test new versions per-request via `Stripe-Version` header.
- **GitHub CLI**: Auto-detects terminal vs pipe. Human-readable in terminal, tab-delimited when piped. `gh pr <tab>` shows all PR actions.
- **SwiftUI progressive disclosure**: `Button("Save") { save() }` to full customization, same API at every level.
- **htmx**: HTML attributes replace JS. 14KB total. `hx-get="/search" hx-trigger="keyup changed delay:300ms"`. Zero build step.
- **shadcn/ui**: Copy source code into your project. You own every line. No dependency, no version conflicts.

**Anti-patterns:**
- Chatty API: requiring 5 calls for one user-visible action
- Inconsistent naming: `/users` (plural) vs `/user/123` (singular) vs `/create-order` (verb in URL)
- Implicit failure: 200 OK with error nested in response body
- God endpoint: 47 parameter combinations with different behavior per subset
- Documentation-required API: 3 pages of docs before first call = too much ceremony

## Pass 3: Error Messages & Debugging

Score against the agent-ready error contract (Pass 3 of the review, and
https://github.com/garrytan/gstack/blob/main/docs/agent-ready-errors.md). The examples
below show single items done well; none of them alone meets every item.

**Elm (what, fix, readable first line):**
```
-- TYPE MISMATCH ---- src/Main.elm
I cannot do addition with String values like this one:
42|   "hello" + 1
     ^^^^^^^
Hint: To put strings together, use the (++) operator instead.
```
First person, complete sentences, exact location, suggested fix.

**Rust (code, fix, `--explain`):**
```
error[E0308]: mismatched types
 --> src/main.rs:4:20
help: consider borrowing here
  |
4 |     let name: &str = &get_name();
  |                       +
```
A stable code with `rustc --explain E0308`, primary and secondary labels, and a help line
that shows the exact edit.

**Stripe API (code, doc anchor, structured channel):**
```json
{"error":{"type":"invalid_request_error","code":"resource_missing","message":"No such customer: 'cus_nonexistent'","param":"customer","doc_url":"https://stripe.com/docs/error-codes/resource-missing"}}
```

**Agent-ready CLI error (every applicable item).** stderr, exit 3:
```
deploy: push to registry.example.com/acme/api:1.4.2 failed: 401 unauthorized (REGISTRY_AUTH)
  cause: docker login token in ~/.docker/config.json expired; nothing was pushed (side effects: none)
  context: deploy 2.8.0, docker 27.1, config ./deploy.toml, env DEPLOY_REGISTRY set
  fix: run `deploy login --registry registry.example.com`, then rerun the same command (safe to retry once)
  docs: https://deploy.example.com/errors#REGISTRY_AUTH
```
and with `--json`, the same fields as an RFC 9457 problem-details object with extension members:
```json
{"type":"https://deploy.example.com/errors#REGISTRY_AUTH","title":"Registry push unauthorized",
 "detail":"push to registry.example.com/acme/api:1.4.2 failed: 401","instance":"req_7f3a",
 "code":"REGISTRY_AUTH","fix":"deploy login --registry registry.example.com",
 "recovery":{"action":"fix_and_retry","side_effects":"none","max_retries":1},
 "context":{"version":"2.8.0","config":"./deploy.toml","env":["DEPLOY_REGISTRY"]}}
```
An unexpected crash adds `trace: ~/.deploy/logs/crash-2026-10-16T18-02.log (rerun with
--verbose to print it)`. A remote API returns `instance` as its correlation id and keeps the
trace in its own logs. `recovery.action` is retry | fix_and_retry | do_first | ask_human;
`side_effects` is none | partial | complete | unknown, with `reconcile` (a status command)
whenever it is unknown. These member names are illustrative; score the meaning, not the spelling.

**A partial example, gstack's own workflow errors:**
```
findings.jsonl:12: severity must be one of Critical, High, Medium, Low, Informational (ARTIFACT_SCHEMA)
```
It covers what (file, line, the constraint), code (with a `docs/troubleshooting.md` anchor
that carries the `fix:`) and channel (exit 1). It lacks a fix on the line itself, a recovery
class and context. It would score CAP6:fix.

**Standards mapping.** CLI Agent Spec (cli-agent-spec.github.io): per-exit-code `retryable`
and `side_effects` → recovery. RFC 9457: `type` → code + doc anchor, `detail` → what,
`instance` → trace for remote services. Stripe: `code` + `doc_url` → code. MCP tools:
`isError: true` results the model can read → channel. clig.dev "Errors": the actionable line
where the reader looks, debug info for unexpected errors → fix, trace.

**Anti-patterns:** TypeScript buries "Did you mean?" mid-chain; put the fix on the first or
last line. `Error: operation failed` with exit 0. A prompt that hangs when no terminal is
attached. A stack trace that prints an API token.

## Pass 4: Documentation & Learning

**Gold standards:**
- **Stripe docs**: Three-column layout (nav / content / live code). API keys injected when logged in. Language switcher persists across ALL pages. Hover-to-highlight. Stripe Shell for in-browser API calls. Built and open-sourced Markdoc. Features don't ship until docs are finalized. Docs contributions affect performance reviews.
- 52% of developers blocked by lack of documentation (Postman 2023)
- Companies with world-class docs see 2.5x increase in adoption
- "Docs as product": ships with the feature or the feature doesn't ship

## Pass 5: Upgrade & Migration Path

**Gold standards:**
- **Next.js**: `npx @next/codemod upgrade major`. One command upgrades Next.js, React, React DOM, runs all relevant codemods.
- **AG Grid**: Every release from v31+ includes a codemod.
- **Stripe API versioning**: One codebase internally. Version pinning per account. Breaking changes never surprise you.
- **Martin Fowler's pipeline pattern**: Compose small, testable transformations rather than one monolithic codemod.
- 21.9% of breaking changes in Maven Central were undocumented (Ochoa et al., 2021)

## Pass 6: Developer Environment & Tooling

**Gold standards:**
- **Bun**: 100x faster than npm install, 4x faster than Node.js runtime. Speed IS DX.
- 87 interruptions per day average; 25 minutes to recover from each. Devs code only 2-4 hours/day.
- Each 1-point DXI improvement = 13 minutes saved per developer per week.
- **GitHub Copilot**: 55.8% faster task completion. PR time from 9.6 days to 2.4 days.

## Pass 7: Community & Ecosystem

- Dev tools require ~14 exposures before purchase (Matt Biilmann, Netlify). Incompatible with quarterly OKR cycles.
- 4-5x performance multiplier for teams with strong developer experience (DevEx framework).

## Pass 8: DX Measurement

**Three academic frameworks:**
1. **SPACE** (Microsoft Research, 2021): Satisfaction, Performance, Activity, Communication, Efficiency. Measure at least 3 dimensions.
2. **DevEx** (ACM Queue, 2023): Feedback Loops, Cognitive Load, Flow State. Combine perceptual + workflow data.
3. **Fagerholm & Munch** (IEEE, 2012): Cognition, Affect, Conation. The psychological "trilogy of mind."

## Claude Code Skill DX Checklist

Use when reviewing plans for Claude Code skills, MCP servers, or AI agent tools.

- [ ] **AskUserQuestion design**: One issue per call. Re-ground context (project, branch, task). Browser handoff for visual feedback.
- [ ] **State storage**: Global (~/.tool/) vs per-project ($SLUG/) vs per-session. Append-only JSONL for audit trails.
- [ ] **Progressive consent**: One-time prompts with marker files. Never re-ask. Reversible.
- [ ] **Auto-upgrade**: Version check with cache + snooze backoff. Migration scripts. Inline offer.
- [ ] **Skill composition**: Benefits-from chains. Review chaining. Inline invocation with section skipping.
- [ ] **Error recovery**: Resume from failure. Partial results preserved. Checkpoint-safe.
- [ ] **Agent-readable errors**: Every error meets the agent-ready error contract (Pass 3): a safe fix, recovery class, code, context, and a result line with a code.
- [ ] **Session continuity**: Timeline events. Compaction recovery. Cross-session learnings.
- [ ] **Bounded autonomy**: Clear operational limits. Mandatory escalation for destructive actions. Audit trails.

Reference implementations: gstack's design-shotgun loop, auto-upgrade flow, progressive consent, hierarchical storage.
