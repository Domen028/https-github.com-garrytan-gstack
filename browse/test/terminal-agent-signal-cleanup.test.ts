import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GSTACK_EXTENSION_ID } from '../src/extension-id';

const AGENT_SCRIPT = path.join(import.meta.dir, '../src/terminal-agent.ts');
const EXT_ORIGIN = `chrome-extension://${GSTACK_EXTENSION_ID}`;

function waitForFile(file: string, timeoutMs = 5000): string {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {}
    Bun.sleepSync(25);
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

test('SIGTERM reaps every active PTY child before terminal-agent exits', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-term-signal-'));
  const stateFile = path.join(stateDir, 'browse.json');
  const childPidFile = path.join(stateDir, 'pty-child.pid');
  const terminalCli = path.join(stateDir, 'terminal-cli');
  let agent: any;
  let ws: WebSocket | null = null;
  let childPid: number | null = null;

  try {
    fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-browse-token' }));
    fs.writeFileSync(terminalCli, [
      '#!/bin/bash',
      'shift 2',
      'echo "$$" > "$GSTACK_TEST_CHILD_PID_FILE"',
      "trap '' INT TERM",
      'while :; do sleep 1; done',
      '',
    ].join('\n'));
    fs.chmodSync(terminalCli, 0o755);

    agent = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_SERVER_PORT: '0',
        BROWSE_TERMINAL_BINARY: terminalCli,
        GSTACK_STATE_ROOT: stateDir,
        GSTACK_TEST_CHILD_PID_FILE: childPidFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const port = Number(waitForFile(path.join(stateDir, 'terminal-port')));
    const internalToken = waitForFile(path.join(stateDir, 'terminal-internal-token'));
    const attachToken = 'signal-cleanup-token-at-least-seventeen';
    const grant = await fetch(`http://127.0.0.1:${port}/internal/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${internalToken}`,
      },
      body: JSON.stringify({ token: attachToken, sessionId: 'signal-cleanup-session' }),
    });
    expect(grant.status).toBe(200);

    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Origin: EXT_ORIGIN,
        Cookie: `gstack_pty=${attachToken}`,
      },
    } as any);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket did not open')), 5000);
      ws!.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws!.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('websocket failed'));
      });
    });
    ws.send(new Uint8Array([10]));

    childPid = Number(waitForFile(childPidFile));
    expect(isAlive(childPid)).toBe(true);

    agent.kill('SIGTERM');
    await Promise.race([
      agent.exited,
      Bun.sleep(6000).then(() => { throw new Error('terminal-agent did not exit'); }),
    ]);

    expect(isAlive(childPid)).toBe(false);
  } finally {
    try { ws?.close(); } catch {}
    try { agent?.kill?.('SIGKILL'); } catch {}
    if (childPid && isAlive(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  }
}, 10_000);
