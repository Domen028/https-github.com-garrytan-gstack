/** Cooperative project writer lifetimes; metadata stays outside project buckets. */
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveStateRoot } from "./state-root";
import { claimArtifactProject } from "./bin-context";

const helper = join(import.meta.dir, "../bin/gstack-artifact-window.py");
interface Lease { id: string; refs: number; released: boolean }
const owned = new AsyncLocalStorage<Map<string, Lease>>();
function call(action: string, root: string, slug: string, args: string[] = []): { id: string } {
  const result = spawnSync("python3", [helper, action, root, slug, ...args], {
    encoding: "utf8", timeout: 10000, maxBuffer: 65536,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || "ARTIFACT_WINDOW_UNAVAILABLE: no project mutation authorized");
  }
  return JSON.parse(result.stdout);
}

function ownsOuterLease(root: string, slug: string): boolean {
  const id = process.env.GSTACK_ARTIFACT_WRITER_ID;
  if (!id || process.env.GSTACK_ARTIFACT_WRITER_PID !== String(process.ppid)) return false;
  call("check", root, slug, ["--id", id, "--owner-pid", String(process.ppid)]);
  return true;
}

/** Acquire before the first read used by a mutation; retain until close/settlement. */
export function withArtifactProjectWrite<T>(root: string, slug: string, write: () => T): T {
  if (ownsOuterLease(root, slug)) return write();
  const key = resolve(root) + "\0" + slug;
  const inherited = owned.getStore()?.get(key);
  const lease: Lease = inherited && !inherited.released ? inherited
    : { ...call("acquire", root, slug, ["--owner-pid", String(process.pid)]), refs: 0, released: false };
  lease.refs++;
  let finished = false;
  const release = () => {
    if (finished) return;
    finished = true;
    if (--lease.refs === 0) {
      lease.released = true;
      call("release", root, slug, ["--id", lease.id]);
    }
  };
  try {
    const next = new Map(owned.getStore());
    next.set(key, lease);
    const result = owned.run(next, write);
    if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") {
      return Promise.resolve(result).finally(release) as T;
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

/** Arbitrary publishers participate when their final destination is a project bucket. */
export function withArtifactPathWrite<T>(file: string, write: () => T, root = resolveStateRoot()): T {
  const physical = (input: string): string => {
    let cursor = resolve(input);
    const missing: string[] = [];
    for (;;) {
      try { return resolve(realpathSync(cursor), ...missing); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(basename(cursor));
        cursor = parent;
      }
    }
  };
  const actualRoot = physical(root);
  // Root spellings such as /var versus /private/var are allowed. A link
  // inside a bucket, or an external link into one, is not stable ownership.
  for (let cursor = resolve(file); dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    let link = false;
    try { link = lstatSync(cursor).isSymbolicLink(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (link) {
      // Once a link exists, an unresolvable target is unknown ownership, not a
      // missing ordinary path. Never swallow ENOENT from realpath here.
      let target: string;
      try { target = realpathSync(cursor); }
      catch { throw new Error("ARTIFACT_WINDOW_DESTINATION_ALIAS: unresolved link"); }
      const lexicalLink = relative(resolve(root), cursor).split(/[\\/]/);
      const targetLink = relative(actualRoot, target).split(/[\\/]/);
      if (lexicalLink[0]?.toLowerCase() === "projects" || targetLink[0]?.toLowerCase() === "projects") {
        throw new Error("ARTIFACT_WINDOW_DESTINATION_ALIAS: no artifact written");
      }
    }
  }
  const lexical = relative(resolve(root), resolve(file));
  const actual = relative(actualRoot, physical(file));
  const parts = actual.split(/[\\/]/);
  const lexicalProject = lexical.split(/[\\/]/)[0]?.toLowerCase() === "projects";
  if (lexicalProject && (parts[0] === ".." || isAbsolute(actual))) {
    throw new Error("ARTIFACT_WINDOW_DESTINATION_ESCAPED: no artifact written");
  }
  if (parts[0]?.toLowerCase() === "projects" && parts[0] !== "projects") {
    throw new Error("ARTIFACT_WINDOW_NONCANONICAL_PROJECTS: no artifact written");
  }
  if (parts.length >= 2 && parts[0] === "projects" && parts[1] && parts[1] !== "..") {
    return withArtifactProjectWrite(root, parts[1], () => {
      claimArtifactProject(root, parts[1]);
      return write();
    });
  }
  return write();
}

/** Hold an entire native CLI's reads, RMW and writes in one external lease. */
export function reexecArtifactWriter(root: string, slug: string): void {
  if (ownsOuterLease(root, slug)) return;
  const result = spawnSync("python3", [helper, "run", root, slug, "--",
    process.execPath, "--no-env-file", process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit", timeout: 900000,
  });
  // A timed-out/killed holder leaves an explicit lease for inspection. Never
  // pretend it was released or silently replace it on a subsequent command.
  if (result.error || result.status === null) throw new Error("ARTIFACT_WINDOW_WRITER_INCOMPLETE");
  process.exit(result.status);
}
