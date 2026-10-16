// /cso --paths audit scope (field list 2, item 12): a repository over the source
// cap can be audited by naming the subtree to read, and every skipped path stays
// in the manifest unread and is reported as a snapshot-inputs gap.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OUTSIDE_AUDIT_PATHS, capture, snapshotManifestCapMessage, sourceCapMessage } from '../lib/cso/snapshot';
import { newRun, readJson, saveReport } from '../lib/cso/state';
import { canonical, sha256, type VerificationObservation } from '../lib/cso/contracts';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { canonicalStartPlan, canonicalTestPlan, patchHash, verifyRepair } from '../lib/cso/verification';

const ROOT = path.resolve(import.meta.dir, '..');
const launcher = path.join(ROOT, 'bin', process.platform === 'win32' ? 'gstack-cso-launcher.exe' : 'gstack-cso-launcher');
const MIB = 1024 * 1024;
let root = '';
let state = '';
const originalHome = process.env.GSTACK_HOME;

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 60_000 });
  if (result.status) throw new Error(result.stderr);
  return result.stdout;
}
function cso(repo: string, args: string[], home = state) {
  return spawnSync(launcher, args, { cwd: repo, encoding: 'utf8', env: { HOME: root, GSTACK_HOME: home, PATH: '/usr/bin:/bin' }, timeout: 120_000, maxBuffer: 64 * MIB });
}
function makeRepo(name: string, files: Record<string, string | Buffer>): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  git(repo, 'config', 'user.name', 'Fixture');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fixture');
  return repo;
}
function runDir(run: { repoId: string; runId: string }): string {
  return path.join(state, 'security', 'cso', run.repoId, run.runId);
}
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((item) => item.isFile()).map((item) => path.relative(dir, path.join(item.parentPath, item.name)).split(path.sep).join('/')).sort();
}
function runDirs(home: string): string[] {
  const base = path.join(home, 'security', 'cso');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).filter((repo) => repo.isDirectory()).flatMap((repo) => fs.readdirSync(path.join(base, repo.name), { withFileTypes: true }).filter((run) => run.isDirectory()).map((run) => `${repo.name}/${run.name}`)).sort();
}
function error(result: ReturnType<typeof cso>) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  return JSON.parse(result.stderr).error;
}
const USERS = 'export const tenantQuery = (id:string) => db.user.findUnique({where:{id}})\n';
const application = { actors: ['tenant user'], assets: ['tenant records'], entrypoints: ['GET /users/:id'], tenantBoundaries: ['tenant id'], sensitiveOperations: ['record read'], invariants: ['tenant isolation'] };
const finding = { title: 'Cross-tenant user read', rootCause: 'Tenant query omits caller tenant predicate', location: { path: 'src/core/users.ts', line: 1, symbol: 'tenantQuery' }, advisoryIds: [], severity: 'high', confidence: 'high', confidenceRationale: 'The caller-to-query trace and missing tenant predicate directly support the finding', evidence: 'supported', attackerControl: 'Authenticated caller chooses the record ID', impact: 'Another tenant record is returned', scenario: 'A tenant supplies a known record ID owned by another tenant and receives that record', trace: ['GET /users/:id', 'tenantQuery', 'findUnique by id'], references: ['src/core/users.ts:1', 'OWASP API1:2023'], recommendation: 'Bind the lookup predicate to the authenticated tenant identifier', challenge: { reviewer: 'independent-2', independent: true, mode: 'independent_agent', callers: 'Authenticated route forwards the ID', controls: 'Authentication does not bind tenant', counterevidence: 'Opaque IDs reduce guessing but do not authorize', conclusion: 'The authorization invariant is absent' } };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-paths-'));
  state = path.join(root, 'state');
  process.env.GSTACK_HOME = state;
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CSO --paths audit scope', () => {
  test('only the source cap advises --paths; the manifest cap and entry limit, which still count skipped paths, do not', async () => {
    const source = sourceCapMessage(346_199_207, 7_561);
    expect(source).toContain('rerun with --paths');
    expect(source).toContain('lists every skipped path');
    expect(source).not.toContain('smaller checkout');
    const manifest = snapshotManifestCapMessage(61_234, 17_000_000);
    expect(manifest).not.toContain('--paths');
    expect(manifest).toContain('No supported workaround raises this cap');

    const repo = makeRepo('entry-limit-scoped', { 'src/core/users.ts': USERS, 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const refused = await capture(repo, newRun(repo).dir, undefined, undefined, { maxEntries: 2 }, ['src/core']).then(
      () => undefined,
      (error) => error,
    );
    expect(refused?.code).toBe('MISSING_INPUT');
    expect(refused?.message).toBe('Source tree exceeds the 2-entry snapshot admission limit');
  });

  test('a repository over the source cap is admitted with --paths, and every skipped path is disclosed unread', () => {
    const repo = makeRepo('over-cap-scoped', {
      'src/core/users.ts': USERS,
      'src/mcp/server.ts': 'export const serve = () => 1\n',
      'assets/a.bin': Buffer.alloc(40 * MIB, 1),
      'assets/b.bin': Buffer.alloc(25 * MIB, 1),
      'README.md': '# fixture\n',
    });
    const capped = error(cso(repo, ['start', '--repo', repo, '--offline'])).message;
    expect(capped).toStartWith('64 MiB source cap exceeded:');
    expect(capped).toContain('rerun with --paths');

    const started = cso(repo, ['start', '--repo', repo, '--offline', '--paths', 'src/mcp,src/core/,src/core']);
    expect(started.stderr).toBe('');
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      dir = runDir(run),
      report = readJson(path.join(dir, 'report.json')),
      manifest = readJson(path.join(dir, 'snapshot.json'), 16 * MIB);
    expect(report.policy.paths).toEqual(['src/core', 'src/mcp']);

    const skipped = ['README.md', 'assets/a.bin', 'assets/b.bin'];
    for (const file of skipped) {
      const entry = manifest.entries.find((item: any) => item.path === file);
      expect(entry).toMatchObject({ originalHash: 'not-read', transformation: OUTSIDE_AUDIT_PATHS, bytes: fs.statSync(path.join(repo, file)).size });
      expect(entry.executionHash).toBeUndefined();
    }
    expect(OUTSIDE_AUDIT_PATHS).toStartWith('withheld:');
    expect(listFiles(path.join(dir, 'snapshot'))).toEqual(['src/core/users.ts', 'src/mcp/server.ts']);
    expect(listFiles(path.join(dir, 'readable'))).toEqual(['src/core/users.ts', 'src/mcp/server.ts']);

    const coverage = report.coverage.find((item: any) => item.domain === 'snapshot-inputs');
    expect(coverage.status).toBe('partial');
    expect(coverage.gaps).toEqual(skipped.map((file) => `${file}: outside the --paths audit scope; payload was not read or assessed`));
    expect(coverage.evidence).toEqual(['2 sanitized execution inputs captured; 0 explicit non-executable exclusions; 3 unread in-scope inputs; 0 tracked deletions; audit limited by --paths to src/core, src/mcp, so 3 source files were skipped unread']);
    expect(report.source.transformations).toEqual(skipped.map((file) => ({ path: file, handling: OUTSIDE_AUDIT_PATHS })));
  }, 180_000);

  test('capture never opens an out-of-scope payload when there is no comparison base', async () => {
    const repo = makeRepo('unreadable-outside', { 'src/core/users.ts': USERS, 'secret/blob.txt': 'outside the audit\n' });
    fs.chmodSync(path.join(repo, 'secret', 'blob.txt'), 0o000);
    try {
      await expect(capture(repo, newRun(repo).dir)).rejects.toThrow('Source could not be opened as a regular file: secret/blob.txt');
      const run = newRun(repo),
        manifest = await capture(repo, run.dir, undefined, undefined, {}, ['src/core']);
      expect(manifest.entries.find((entry) => entry.path === 'secret/blob.txt')).toMatchObject({ originalHash: 'not-read', transformation: OUTSIDE_AUDIT_PATHS, bytes: 18 });
      expect(listFiles(path.join(run.dir, 'snapshot'))).toEqual(['src/core/users.ts']);
    } finally {
      fs.chmodSync(path.join(repo, 'secret', 'blob.txt'), 0o644);
    }
  });

  test('invalid --paths values are refused and leave no run', () => {
    const repo = makeRepo('invalid-paths', { 'src/core/users.ts': USERS });
    const home = path.join(root, 'invalid-state'),
      many = Array.from({ length: 33 }, (_, i) => `src/p${i}`).join(',');
    for (const value of ['', ',', '../src', 'src/../x', '/src', '-src', 'src//core', 'src/./core', 'src\\core', 'src\ncore', many]) {
      const refused = error(cso(repo, ['start', '--repo', repo, '--offline', '--paths', value], home));
      expect(refused.code).toBe('INVALID_ARGUMENT');
    }
    const unmatched = error(cso(repo, ['start', '--repo', repo, '--offline', '--paths', 'src/core,src/typo'], home));
    expect(unmatched).toEqual({ code: 'INVALID_ARGUMENT', message: '--paths entry matches no source file: src/typo' });
    expect(error(cso(repo, ['start', '--repo', repo, '--paths'], home)).message).toBe('--paths requires a value');
    expect(runDirs(home)).toEqual([]);
  }, 120_000);

  test('--diff refuses changed paths outside --paths and compares unchanged ones without reporting them', () => {
    const repo = makeRepo('diff-scope', { 'src/core/users.ts': USERS, 'src/other/a.ts': 'export const a = 1\n', 'docs/b.md': 'b\n' }),
      base = git(repo, 'rev-parse', 'HEAD').trim(),
      home = path.join(root, 'diff-state'),
      start = () => cso(repo, ['start', '--repo', repo, '--offline', '--diff', '--base', base, '--paths', 'src/core'], home);

    fs.writeFileSync(path.join(repo, 'src/core/users.ts'), USERS + '// changed\n');
    const accepted = start();
    expect(accepted.stderr).toBe('');
    expect(accepted.status).toBe(0);
    const run = JSON.parse(accepted.stdout),
      manifest = readJson(path.join(home, 'security', 'cso', run.repoId, run.runId, 'snapshot.json'), 16 * MIB);
    expect(manifest.changedPaths).toEqual(['src/core/users.ts']);

    fs.writeFileSync(path.join(repo, 'src/other/a.ts'), 'export const a = 2\n');
    const modified = error(start());
    expect(modified.code).toBe('INVALID_ARGUMENT');
    expect(modified.message).toContain('--diff found 1 changed path outside --paths (src/core): src/other/a.ts.');
    git(repo, 'checkout', '--', 'src/other/a.ts');

    fs.rmSync(path.join(repo, 'docs/b.md'));
    fs.writeFileSync(path.join(repo, 'new.ts'), 'export const n = 1\n');
    const added = error(start());
    expect(added.message).toContain('--diff found 2 changed paths outside --paths (src/core): docs/b.md, new.ts.');
    expect(runDirs(home)).toEqual([`${run.repoId}/${run.runId}`]);
  }, 180_000);

  test('recheck rebuilds the original --paths scope', () => {
    const repo = makeRepo('recheck-scope', { 'src/core/users.ts': USERS, 'tools/build.ts': 'export const build = 1\n' }),
      started = cso(repo, ['start', '--repo', repo, '--scope', 'auth', '--offline', '--paths', 'src/core']);
    expect(started.status).toBe(0);
    const run = JSON.parse(started.stdout),
      dir = runDir(run),
      initial = readJson(path.join(dir, 'report.json')),
      evidence = path.join(root, 'recheck-evidence.json');
    fs.writeFileSync(evidence, JSON.stringify({ application, findings: [finding], coverage: initial.coverage.filter((item: any) => !['snapshot-inputs', 'history-inputs'].includes(item.domain)).map((item: any) => ({ ...item, status: 'assessed', method: 'fresh caller and boundary trace', gaps: [], evidence: ['current captured source'] })), gaps: [] }));
    const outside = path.join(root, 'outside-finding.json');
    fs.writeFileSync(outside, JSON.stringify({ findings: [{ ...finding, location: { ...finding.location, path: 'tools/build.ts' }, references: ['tools/build.ts:1'] }] }));
    const refusedFinding = error(cso(repo, ['submit', run.runId, outside]));
    expect(refusedFinding).toEqual({ code: 'INVALID_SCHEMA', message: 'Finding root cause is outside the --paths audit scope: tools/build.ts' });
    expect(cso(repo, ['submit', run.runId, evidence]).status).toBe(0);
    expect(cso(repo, ['finish', run.runId]).status).toBe(0);
    const final = readJson(path.join(dir, 'report.json'));
    expect(final.findings).toHaveLength(1);
    const rechecked = cso(repo, ['recheck', final.findings[0].id, '--repo', repo]);
    expect(rechecked.stderr).toBe('');
    expect(rechecked.status).toBe(0);
    const childRun = JSON.parse(rechecked.stdout),
      child = readJson(path.join(runDir({ ...childRun, repoId: run.repoId }), 'report.json'));
    expect(child.policy.paths).toEqual(['src/core']);
    expect(child.coverage.find((item: any) => item.domain === 'snapshot-inputs').gaps).toEqual(['tools/build.ts: outside the --paths audit scope; payload was not read or assessed']);
    const claim = path.join(root, 'withheld-claim.json');
    fs.writeFileSync(claim, JSON.stringify({ recheck: { findingId: final.findings[0].id, outcome: 'resolved', rootCause: finding.rootCause, evidence: [{ kind: 'caller', path: 'tools/build.ts', line: 1, observation: 'A caller outside the audit scope' }, { kind: 'security_boundary', path: 'src/core/users.ts', line: 1, observation: 'Fresh boundary trace' }] } }));
    expect(error(cso(repo, ['submit', childRun.runId, claim]))).toEqual({ code: 'INVALID_SCHEMA', message: 'Recheck evidence must reference freshly captured readable source' });
  }, 180_000);

  test.skipIf(process.platform === 'win32')('replay from supplied source recaptures with the original --paths scope', async () => {
    const repo = makeRepo('replay-scope', {
      'package.json': JSON.stringify({ name: 'cso-paths-replay', version: '1.0.0', private: true, scripts: { start: 'node app.js', test: 'node --test' } }) + '\n',
      'package-lock.json': JSON.stringify({ name: 'cso-paths-replay', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'cso-paths-replay', version: '1.0.0' } } }) + '\n',
      'app.js': 'module.exports = "vulnerable"\n',
      'app.test.js': "const test=require('node:test');test('legitimate control remains available',()=>{});\n",
      'docs/notes.md': 'outside the audit\n',
    });
    const started = cso(repo, ['start', '--repo', repo, '--comprehensive', '--offline', '--paths', 'app.js,app.test.js,package.json,package-lock.json']);
    expect(started.stderr).toBe('');
    const run = JSON.parse(started.stdout),
      dir = runDir(run),
      snapshot = path.join(dir, 'snapshot'),
      manifest = readJson(path.join(dir, 'snapshot.json'), 16 * MIB);
    expect(manifest.entries.find((entry: any) => entry.path === 'docs/notes.md').transformation).toBe(OUTSIDE_AUDIT_PATHS);
    const recordFinding = { ...finding, location: { path: 'app.js', line: 1, symbol: 'recordLookup' }, references: ['app.js:1', 'OWASP API1:2023'] },
      submission = path.join(root, 'replay-finding.json');
    fs.writeFileSync(submission, JSON.stringify({ findings: [recordFinding] }));
    expect(cso(repo, ['submit', run.runId, submission]).status).toBe(0);
    const report = readJson(path.join(dir, 'report.json')),
      start = canonicalStartPlan(snapshot, 'node', 3456),
      tests = canonicalTestPlan(snapshot, 'node'),
      arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const request: any = { findingId: report.findings[0].id, runtimeProfile: `node-24.4.0-${arch}`, port: 3456, start: start.command, legitimate: [{ name: 'legitimate control', path: '/control', method: 'GET', expected: { status: 200, includes: 'CONTROL_OK' } }], security: { name: 'unauthorized record is denied', path: '/records/other', method: 'GET', expected: { status: 403, includes: 'DENIED' }, vulnerable: { status: 200, includes: 'RECORD' } }, existingTests: tests.commands, fixtures: {}, boundaryFiles: ['app.js'], testFiles: tests.files, changes: [{ path: 'app.js', beforeSha256: sha256(fs.readFileSync(path.join(snapshot, 'app.js'))), after: 'module.exports = "fixed"\n', effect: 'source' }], review: { reviewer: 'independent-reviewer', independent: true, rootCauseRepaired: true, featurePreserved: true, boundaryMocks: false, rationale: 'The caller predicate is added while the legitimate control and existing test remain unchanged.', reviewedPatchHash: '' } };
    request.review.reviewedPatchHash = patchHash(request);
    const tap = 'TAP version 13\n# Subtest: legitimate control remains available\nok 1 - legitimate control remains available\n  ---\n  duration_ms: 1\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
      runtime: any = { id: request.runtimeProfile, stack: 'node', platform: `linux/${arch}`, image: `ghcr.io/garrytan/gstack/cso-staging/node-${arch}@sha256:${'b'.repeat(64)}` },
      executor = {
        observe: async (_source: string, phase: 'before' | 'after', received: any, _runtime: any, _verifier: any, _work: string, _control: string, _execution: any, evidence: any, witness: any) => {
          const observation: VerificationObservation = { booted: true, legitimate: true, security: phase === 'before' ? 'intended_failure' : 'pass', existingTests: false, output: `external ${phase} assertions passed`, inputHash: '' },
            receipt = await witness.attest(observation, [{ command: received.existingTests[0], code: 0, output: tap, minimumPassingTests: evidence.minimumPassingTests[0] }]);
          return { observation: { ...observation, existingTests: receipt.diagnosticTestsPassed, inputHash: witness.binding.harnessHash }, witness: receipt };
        },
      };
    const verified = await verifyRepair({ runId: run.runId, runDir: dir, manifest, rawRequest: request, runtime, verifier: runtime, policyHash: ISOLATION_POLICY_HASH, auditPolicyHash: sha256(canonical(report.policy)), archives: [], executor } as any);
    report.findings[0].reproduction = 'reproduced';
    report.findings[0].repair = 'runtime_tested';
    report.findings[0].verificationId = verified.bundle.id;
    report.findings[0].verificationAssurance = { assertions: 'authenticated_out_of_process', testCompletion: 'self_reported', review: 'self_attested' };
    saveReport(dir, report);
    fs.rmSync(snapshot, { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'readable'), { recursive: true, force: true });
    const supplied = cso(repo, ['replay', verified.bundle.id, '--source', repo]);
    expect(supplied.status).not.toBe(0);
    expect(supplied.stderr).not.toContain('does not match the bundle input hashes');
    expect(supplied.stderr).toContain('MISSING_QUALIFIED_RUNTIME');
  }, 60_000);
});
