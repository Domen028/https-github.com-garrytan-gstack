/**
 * #3247: one busy tab must not make the daemon look dead. A renderer stuck in
 * a long script never answers page.evaluate() or page.title(). /health folded
 * that into its `status`, so the CLI refused every command (status, tabs,
 * tab, newtab, stop) with "Daemon busy" until --force-restart threw the
 * session away, and `tabs` and `state save` hung on the tab as well.
 *
 * A real Chromium tab is held in a busy loop while a second tab stays idle;
 * each surface must answer within its bound and name the busy tab.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserManager, TAB_PROBE_TIMEOUT_MS } from '../src/browser-manager';
import { HEALTH_REQUEST_TIMEOUT_MS } from '../src/cli';
import { handleMetaCommand } from '../src/meta-commands';
import { callRoute, stubRouteContext } from './route-test-harness';
import { startTestServer } from './test-server';

// Outlasts every check below; closing the busy tab at the end stops it sooner.
const BUSY_MS = 30_000;

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let busyId = 0;
let idleId = 0;
let profileDir = '';
const originalProfile = process.env.CHROMIUM_PROFILE;

beforeAll(async () => {
  // Per-file profile, set in a hook (see commands.test.ts for why).
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-busy-tab-profile-'));
  process.env.CHROMIUM_PROFILE = profileDir;
  testServer = startTestServer(0);
  bm = new BrowserManager();
  await bm.launch();
  busyId = bm.getActiveTabId();
  await bm.getPage().goto(`${testServer.url}/basic.html`);
  idleId = await bm.newTab(`${testServer.url}/basic.html`);
  bm.switchTab(busyId, { bringToFront: false });
  await bm.getPage().evaluate((ms) => {
    setTimeout(() => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }, 50);
  }, BUSY_MS);
  await Bun.sleep(300); // let the loop start
}, 30_000);

afterAll(async () => {
  try { testServer.server.stop(true); } catch {}
  try { await Promise.race([bm?.close(), Bun.sleep(3000)]); } catch {}
  if (originalProfile === undefined) delete process.env.CHROMIUM_PROFILE;
  else process.env.CHROMIUM_PROFILE = originalProfile;
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
});

describe('busy active tab (#3247)', () => {
  test('/health says the daemon is alive and names the busy tab before the CLI gives up', async () => {
    // Equal budgets were the bug: the CLI aborted just before the reply landed.
    expect(TAB_PROBE_TIMEOUT_MS).toBeLessThan(HEALTH_REQUEST_TIMEOUT_MS);
    const ctx = stubRouteContext({
      browserManager: bm,
      terminal: { readPort: () => null, grantToken: async () => true, restartSession: async () => true },
    });
    const started = Date.now();
    const body = await (await callRoute('GET', '/health', ctx)).json();
    expect(Date.now() - started).toBeLessThan(HEALTH_REQUEST_TIMEOUT_MS);
    expect(body.status).toBe('healthy');
    expect(body.activeTab).toEqual({ id: busyId, responsive: false });
  });

  test('tabs lists every tab without waiting on the busy one', async () => {
    const started = Date.now();
    const out = await handleMetaCommand('tabs', [], bm, async () => {});
    expect(Date.now() - started).toBeLessThan(HEALTH_REQUEST_TIMEOUT_MS);
    expect(out).toContain(`[${busyId}] (not responding)`);
    expect(out).toContain(`[${idleId}] Test Page - Basic`);
  });

  test('status stays healthy and names the busy tab with a way out', async () => {
    const out = await handleMetaCommand('status', [], bm, async () => {});
    expect(out).toContain('Status: healthy');
    expect(out).toContain(`Active tab ${busyId}`);
    expect(out).toContain(`closetab ${busyId}`);
  });

  test('saveState finishes with every tab, skipping only the busy tab storage', async () => {
    const state = await bm.saveState();
    expect(state.pages).toHaveLength(2);
    expect(state.pages.find(p => p.isActive)?.storage).toBeNull();
    expect(state.pages.find(p => !p.isActive)?.storage).not.toBeNull();
  }, 15_000);

  test('the idle tab still answers', async () => {
    bm.switchTab(idleId, { bringToFront: false });
    try {
      expect(await bm.probeActiveTab()).toEqual({ id: idleId, responsive: true });
      expect(await bm.getPage().title()).toBe('Test Page - Basic');
    } finally {
      bm.switchTab(busyId, { bringToFront: false });
    }
  });

  test('closetab closes the busy tab and the session carries on', async () => {
    const out = await handleMetaCommand('closetab', [String(busyId)], bm, async () => {});
    expect(out).toContain(`Closed tab ${busyId}`);
    expect(bm.getTabCount()).toBe(1);
    expect(await bm.probeActiveTab()).toEqual({ id: idleId, responsive: true });
  }, 15_000);
});
