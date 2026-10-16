import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withArtifactPathWrite, withArtifactProjectWrite } from "../lib/artifact-window";

// Windows ordinary writer leases remain supported; maintenance admission is
// explicitly unqualified there, so POSIX-only window contracts are separate.
const maintenanceTest = process.platform === "win32" ? test.skip : test;
const helper = join(import.meta.dir, "../bin/gstack-artifact-window.py");
function invoke(root: string, action: string, slug: string, ...args: string[]) {
  const result = spawnSync("python3", [helper, action, root, slug, ...args], {
    encoding: "utf8", timeout: 10000,
  });
  if (result.error) throw result.error;
  return { ...result, value: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
}
async function fixture(run: (root: string) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "gstack-window-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const acquire = (root: string, slug = "Project") => invoke(root, "acquire", slug);
const begin = (root: string, slug = "Project", seconds = 30) => invoke(root, "begin", slug, "--seconds", String(seconds));
const release = (root: string, id: string, slug = "Project") => invoke(root, "release", slug, "--id", id);
const status = (root: string, id: string, slug = "Project") => invoke(root, "status", slug, "--id", id);
const end = (root: string, id: string, slug = "Project") => invoke(root, "end", slug, "--id", id);

maintenanceTest("a writer admitted before the hold must finish before exclusivity; new same-scope writers refuse", () => fixture(root => {
  const writer = acquire(root); expect(writer.status).toBe(0);
  const window = begin(root); expect(window.value.state).toBe("draining");
  expect(window.value.writers.map((w: { id: string }) => w.id)).toEqual([writer.value.id]);
  expect(acquire(root).value.code).toBe("ARTIFACT_WINDOW_HELD");
  expect(invoke(root, "assert", "Project", "--id", window.value.id).value.code).toBe("ARTIFACT_WINDOW_NOT_EXCLUSIVE");
  expect(release(root, writer.value.id).status).toBe(0);
  expect(invoke(root, "assert", "Project", "--id", window.value.id).value.state).toBe("exclusive");
  expect(end(root, window.value.id).status).toBe(0);
  const after = acquire(root); expect(after.status).toBe(0); release(root, after.value.id);
}));

maintenanceTest("casefold and canonical Unicode spellings share admission; another project remains writable", () => fixture(root => {
  const window = begin(root, "Straße");
  expect(acquire(root, "STRASSE").value.code).toBe("ARTIFACT_WINDOW_HELD");
  const other = acquire(root, "OtherProject"); expect(other.status).toBe(0); release(root, other.value.id, "OtherProject");
  end(root, window.value.id, "Straße");
  const composed = begin(root, "Café");
  expect(acquire(root, "Cafe\u0301").value.code).toBe("ARTIFACT_WINDOW_HELD");
  end(root, composed.value.id, "Café");
}));

maintenanceTest("lease container survives bucket rename and does not live inside the moving directory", () => fixture(root => {
  mkdirSync(join(root, "projects", "CASE"), { recursive: true });
  writeFileSync(join(root, "projects", "CASE", "retained"), "exact bytes");
  const window = begin(root, "CASE");
  renameSync(join(root, "projects", "CASE"), join(root, "projects", "case"));
  expect(acquire(root, "case").value.code).toBe("ARTIFACT_WINDOW_HELD");
  expect(readFileSync(join(root, "projects", "case", "retained"), "utf8")).toBe("exact bytes");
  end(root, window.value.id, "case");
}));

maintenanceTest("unknown or dead writer ownership is never age-reclaimed", () => fixture(root => {
  const writer = invoke(root, "acquire", "Project", "--owner-pid", "2147483647");
  const window = begin(root); expect(window.value.state).toBe("draining");
  expect(status(root, window.value.id).value.writers).toHaveLength(1);
  expect(invoke(root, "assert", "Project", "--id", window.value.id).status).toBe(1);
  // Fixture cleanup is an explicit owner action, not runtime stale recovery.
  release(root, writer.value.id); end(root, window.value.id);
}));

maintenanceTest("foreign tokens cannot release writer or window, and a second window cannot overwrite the first", () => fixture(root => {
  const writer = acquire(root), window = begin(root);
  expect(release(root, "0".repeat(48)).status).toBe(1);
  expect(end(root, "0".repeat(48)).value.code).toBe("ARTIFACT_WINDOW_OWNER_CHANGED");
  expect(begin(root).value.code).toBe("ARTIFACT_WINDOW_HELD");
  expect(status(root, window.value.id).value.writers[0].id).toBe(writer.value.id);
  release(root, writer.value.id); end(root, window.value.id);
}));

maintenanceTest("expiry never silently reopens admission or authorizes mutation", () => fixture(async root => {
  const window = begin(root, "Project", 1);
  await Bun.sleep(1100);
  expect(status(root, window.value.id).value.state).toBe("expired");
  expect(invoke(root, "assert", "Project", "--id", window.value.id).value.code).toBe("ARTIFACT_WINDOW_NOT_EXCLUSIVE");
  expect(acquire(root).value.code).toBe("ARTIFACT_WINDOW_HELD");
  end(root, window.value.id);
}));

maintenanceTest("run holds admission over actual read/modify/write, then releases after close without changing repeated bytes", () => fixture(async root => {
  const ready = join(root, "ready"), proceed = join(root, "proceed"), file = join(root, "records.jsonl");
  writeFileSync(file, "repeat\nrepeat\nno-final-newline");
  const source = "from pathlib import Path;import sys,time;p,r,g=map(Path,sys.argv[1:]);data=p.read_bytes();r.write_text('ready');\nwhile not g.exists(): time.sleep(.01)\np.write_bytes(data+b'\\nappended\\n')";
  const child = Bun.spawn(["python3", helper, "run", root, "Project", "--", "python3", "-c", source, file, ready, proceed], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const window = begin(root); expect(window.value.state).toBe("draining");
    expect(acquire(root).value.code).toBe("ARTIFACT_WINDOW_HELD");
    writeFileSync(proceed, "continue");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(readFileSync(file, "utf8")).toBe("repeat\nrepeat\nno-final-newline\nappended\n");
    expect(status(root, window.value.id).value.state).toBe("exclusive");
    end(root, window.value.id);
  } finally {
    writeFileSync(proceed, "fixture cleanup");
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}), 10000);

maintenanceTest("directory destinations, native root aliases and alternate projects casing cannot bypass a held scope", () => fixture(root => {
  mkdirSync(join(root, "projects", "Project"), { recursive: true });
  const window = begin(root); let calls = 0;
  for (const target of [join(root, "projects", "Project"), join(realpathSync(root), "projects", "Project", "out"), join(root, "Projects", "Project", "out")]) {
    expect(() => withArtifactPathWrite(target, () => { calls++; }, root)).toThrow();
  }
  expect(calls).toBe(0); end(root, window.value.id);
}));

maintenanceTest("a symlink inside a bucket or an outside link into it refuses before writing", () => fixture(root => {
  mkdirSync(join(root, "projects", "Project"), { recursive: true });
  writeFileSync(join(root, "outside"), "kept");
  symlinkSync(join(root, "outside"), join(root, "projects", "Project", "escape"));
  symlinkSync(join(root, "projects", "Project"), join(root, "alias"));
  let calls = 0;
  for (const target of [join(root, "projects", "Project", "escape"), join(root, "alias", "out")]) {
    expect(() => withArtifactPathWrite(target, () => { calls++; }, root)).toThrow("ARTIFACT_WINDOW_DESTINATION_ALIAS");
  }
  expect(calls).toBe(0); expect(readFileSync(join(root, "outside"), "utf8")).toBe("kept");
}));

maintenanceTest("admission refusal retains received image bytes through the original recovery-copy path", () => fixture(root => {
  mkdirSync(join(root, "projects", "Project"), { recursive: true });
  mkdirSync(join(root, "recovery"));
  const window = begin(root), file = join(root, "projects", "Project", "image.png");
  const module = join(import.meta.dir, "../design/src/persist.ts");
  const program = `import {persistImage} from ${JSON.stringify(module)};console.log(JSON.stringify(persistImage(Buffer.from('retained received image').toString('base64'),process.argv[1],{tmpdir:process.argv[2]})));`;
  const child = spawnSync(process.execPath, ["--no-env-file", "-e", program, file, join(root, "recovery")], {
    env: { ...process.env, GSTACK_STATE_ROOT: root }, encoding: "utf8", timeout: 10000,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout); expect(result.ok).toBe(false);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(result.recovered.path, "utf8")).toBe("retained received image");
  expect(status(root, window.value.id).value.state).toBe("exclusive");
  end(root, window.value.id);
}));

maintenanceTest("run releases its own lease on a command failure and preserves the command exit status", () => fixture(root => {
  const result = spawnSync("python3", [helper, "run", root, "Project", "--", "python3", "-c", "raise SystemExit(7)"], { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(7);
  const window = begin(root); expect(window.value.state).toBe("exclusive"); end(root, window.value.id);
}));

test("scope traversal and malformed tokens refuse before touching another scope", () => fixture(root => {
  expect(acquire(root, "../escape").value.code).toBe("ARTIFACT_WINDOW_INVALID_SCOPE");
  expect(invoke(root, "end", "Project", "--id", "../escape").value.code).toBe("ARTIFACT_WINDOW_INVALID_ID");
}));

maintenanceTest("an async writer remains admitted across awaits and nested writes while a window drains", () => fixture(async root => {
  let proceed!: () => void;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  const file = join(root, "kept"); writeFileSync(file, "before");
  const task = withArtifactProjectWrite(root, "Project", async () => {
    await gate;
    withArtifactProjectWrite(root, "Project", () => writeFileSync(file, "before-and-after"));
  });
  const window = begin(root); expect(window.value.state).toBe("draining");
  expect(() => withArtifactProjectWrite(root, "Project", () => writeFileSync(file, "forbidden"))).toThrow("ARTIFACT_WINDOW_HELD");
  proceed(); await task;
  expect(readFileSync(file, "utf8")).toBe("before-and-after");
  expect(status(root, window.value.id).value.state).toBe("exclusive");
  end(root, window.value.id);
}));

maintenanceTest("a nested async child retains the lease even if its synchronous parent has returned", () => fixture(async root => {
  let proceed!: () => void, child!: Promise<void>;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  withArtifactProjectWrite(root, "Project", () => {
    child = withArtifactProjectWrite(root, "Project", async () => {
      await gate; writeFileSync(join(root, "closed"), "retained child");
    });
  });
  const window = begin(root); expect(window.value.state).toBe("draining");
  proceed(); await child;
  expect(status(root, window.value.id).value.state).toBe("exclusive");
  expect(readFileSync(join(root, "closed"), "utf8")).toBe("retained child");
  end(root, window.value.id);
}));

maintenanceTest("a direct agent session keeps its lease after preamble returns and releases independently at completion", () => fixture(root => {
  const writer = invoke(root, "acquire", "Project", "--session-id", "fixture-session", "--owner-pid", String(process.pid));
  const window = begin(root); expect(window.value.state).toBe("draining");
  expect(status(root, window.value.id).value.writers[0].session).toBe("fixture-session");
  expect(invoke(root, "session-release", "-", "--session-id", "foreign-session").value.status).toBe("not_registered");
  expect(status(root, window.value.id).value.writers[0].id).toBe(writer.value.id);
  expect(invoke(root, "session-release", "-", "--session-id", "fixture-session").value.status).toBe("released");
  expect(status(root, window.value.id).value.state).toBe("exclusive");
  end(root, window.value.id);
}));

maintenanceTest("the native skill-start/end path spans direct agent work and refuses a new workflow during drain", () => fixture(root => {
  const home = join(root, "home"), state = join(root, "state");
  // Use the helper's owned directory creation; no live HOME/installation lease.
  const init = acquire(root); release(root, init.value.id);
  const mkdir = spawnSync("python3", ["-c", "from pathlib import Path;import sys;[Path(x).mkdir() for x in sys.argv[1:]]", home, state], { encoding: "utf8", timeout: 10000 });
  expect(mkdir.status).toBe(0);
  writeFileSync(join(state, "config.yaml"), "update_check: false\nartifacts_sync_mode: off\ntelemetry: off\n");
  const env = { PATH: process.env.PATH!, HOME: home, GSTACK_STATE_ROOT: state, GSTACK_LEASE_DIR: join(root, "install-leases") };
  const entry = join(import.meta.dir, "../bin/gstack-skill-start");
  const first = spawnSync(entry, ["--skill", "fixture"], { cwd: root, env, encoding: "utf8", timeout: 10000 });
  expect(first.status, first.stderr).toBe(0);
  const lease = JSON.parse(first.stdout.match(/^ARTIFACT_WRITER_LEASE: (.+)$/m)![1]);
  const session = first.stdout.match(/^SESSION_ID: (.+)$/m)![1];
  const window = begin(state, lease.scope); expect(window.value.state).toBe("draining");
  const refused = spawnSync(entry, ["--skill", "fixture"], { cwd: root, env, encoding: "utf8", timeout: 10000 });
  expect(refused.status).toBe(3); expect(refused.stdout).toContain("artifact-scope-refused");
  const completed = spawnSync(join(import.meta.dir, "../bin/gstack-skill-end"), ["--skill", "fixture", "--outcome", "success", "--session-id", session], { cwd: root, env, encoding: "utf8", timeout: 10000 });
  expect(completed.status, completed.stderr).toBe(0);
  expect(status(state, window.value.id, lease.scope).value.state).toBe("exclusive");
  end(state, window.value.id, lease.scope);
}), 10000);

maintenanceTest("a broken window marker fails closed rather than admitting a writer", () => fixture(root => {
  const writer = acquire(root); release(root, writer.value.id);
  const probe = spawnSync("python3", ["-c", "import hashlib,pathlib,sys;print(pathlib.Path(sys.argv[1])/'.artifact-coordination'/hashlib.sha256(b'project').hexdigest()/'window.json')", root], { encoding: "utf8" });
  symlinkSync(join(root, "missing-window"), probe.stdout.trim());
  expect(acquire(root).value.code).toBe("ARTIFACT_WINDOW_HELD");
  expect(begin(root).value.code).toBe("ARTIFACT_WINDOW_HELD");
  expect(invoke(root, "end", "Project").value.code).toBe("ARTIFACT_WINDOW_INVALID_ID");
}));

maintenanceTest("an actual killed writer owner leaves its lease blocking exclusivity", () => fixture(async root => {
  const ready = join(root, "ready");
  const source = "import importlib.util,pathlib,os,sys,time;s=importlib.util.spec_from_file_location('window',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.acquire(sys.argv[2],'Project',os.getpid());pathlib.Path(sys.argv[3]).write_text('ready');time.sleep(30)";
  const owner = Bun.spawn(["python3", "-c", source, helper, root, ready], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    owner.kill("SIGKILL"); await owner.exited;
    const window = begin(root); expect(window.value.state).toBe("draining");
    expect(window.value.writers[0].pid).toBe(owner.pid);
    expect(invoke(root, "assert", "Project", "--id", window.value.id).value.code).toBe("ARTIFACT_WINDOW_NOT_EXCLUSIVE");
    end(root, window.value.id);
  } finally { if (owner.exitCode === null) { owner.kill("SIGKILL"); await owner.exited; } }
}));

maintenanceTest("a decision store admits every custom destination before reading or modifying any of them", () => fixture(async root => {
  const { appendEvent, makeRefEvent } = await import("../lib/gstack-decision");
  mkdirSync(join(root, "projects", "Project"), { recursive: true });
  mkdirSync(join(root, "projects", "Other"), { recursive: true });
  const log = join(root, "projects", "Other", "decisions.jsonl");
  const paths = { log, snapshot: join(root, "projects", "Project", "snapshot.json"), archive: join(root, "projects", "Other", "archive.jsonl") };
  writeFileSync(log, "kept\nkept\n");
  const window = begin(root);
  expect(() => appendEvent(paths, makeRefEvent("redact", "not-present"))).toThrow("ARTIFACT_WINDOW_HELD");
  expect(readFileSync(log, "utf8")).toBe("kept\nkept\n");
  expect(existsSync(paths.snapshot)).toBe(false);
  end(root, window.value.id);
}));


maintenanceTest("a dangling outside link cannot create a new file inside a held bucket", () => fixture(root => {
  mkdirSync(join(root, "projects", "Project"), { recursive: true });
  const target = join(root, "projects", "Project", "future.txt");
  const alias = join(root, "alias"); symlinkSync(target, alias);
  const window = begin(root);
  expect(() => withArtifactPathWrite(alias, () => writeFileSync(alias, "forbidden"), root)).toThrow("ARTIFACT_WINDOW_DESTINATION_ALIAS");
  expect(existsSync(target)).toBe(false); end(root, window.value.id);
}));

maintenanceTest("interrupting the holder does not release a child that is still writing", () => fixture(async root => {
  const ready = join(root, "ready"), proceed = join(root, "proceed"), done = join(root, "done");
  const source = "from pathlib import Path;import sys,time;r,g,d=map(Path,sys.argv[1:]);r.write_text('ready');\nwhile not g.exists(): time.sleep(.01)\nd.write_text('closed')";
  const holder = Bun.spawn(["python3", helper, "run", root, "Project", "--", "python3", "-c", source, ready, proceed, done], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    holder.kill("SIGINT"); expect(await holder.exited).toBe(130);
    const window = begin(root); expect(window.value.state).toBe("draining");
    writeFileSync(proceed, "finish");
    const closed = Date.now() + 2000;
    while (!existsSync(done) && Date.now() < closed) await Bun.sleep(10);
    expect(readFileSync(done, "utf8")).toBe("closed");
    // Child completion alone cannot prove the departed holder released safely.
    expect(status(root, window.value.id).value.state).toBe("draining"); end(root, window.value.id);
  } finally {
    writeFileSync(proceed, "cleanup");
    if (holder.exitCode === null) { holder.kill("SIGINT"); await holder.exited; }
  }
}));


test("ordinary writer lifecycle checks a live owner without sending a signal", () => fixture(root => {
  const writer = acquire(root);
  expect(writer.status).toBe(0);
  expect(invoke(root, "check", "Project", "--id", writer.value.id, "--owner-pid", String(process.pid)).status).toBe(0);
  expect(release(root, writer.value.id).status).toBe(0);
  const run = spawnSync("python3", [helper, "run", root, "Project", "--", "python3", "-c", "raise SystemExit(7)"], { encoding: "utf8", timeout: 10000 });
  expect(run.status).toBe(7);
  if (process.platform === "win32") expect(begin(root).value.code).toBe("ARTIFACT_WINDOW_POSIX_QUALIFICATION_REQUIRED");
}));


maintenanceTest("an admitted native CLI can finish its nested identity claim while new workflows refuse", () => fixture(async root => {
  const ready = join(root, "ready"), proceed = join(root, "proceed"), done = join(root, "done");
  const paths = join(import.meta.dir, "../bin/gstack-artifact-paths.py");
  const source = "from pathlib import Path;import sys,time,subprocess;r,g,d=map(Path,sys.argv[1:4]);r.write_text('ready');\nwhile not g.exists(): time.sleep(.01)\nsubprocess.run([sys.executable,sys.argv[4],'claim',sys.argv[5],'Project'],check=True);d.write_text('finished')";
  const holder = Bun.spawn(["python3", helper, "run", root, "Project", "--", "python3", "-c", source, ready, proceed, done, paths, root], { stdout: "pipe", stderr: "pipe" });
  try {
    const until = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < until) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const window = begin(root); expect(window.value.state).toBe("draining");
    expect(invoke(root, "acquire", "Project", "--session-id", "new-workflow").value.code).toBe("ARTIFACT_WINDOW_HELD");
    writeFileSync(proceed, "continue");
    expect(await holder.exited, await new Response(holder.stderr).text()).toBe(0);
    expect(readFileSync(done, "utf8")).toBe("finished");
    expect(status(root, window.value.id).value.state).toBe("exclusive"); end(root, window.value.id);
  } finally { writeFileSync(proceed, "cleanup"); if (holder.exitCode === null) { holder.kill(); await holder.exited; } }
}));
