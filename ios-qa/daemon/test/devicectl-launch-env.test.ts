// GSTACK_IOS_LAUNCH_ENV (split from #1796, credit @Bmathews721): a JSON object
// of string to string forwarded to `devicectl device process launch
// --environment-variables`. An invalid value refuses the launch with
// IOS_LAUNCH_ENV_INVALID instead of launching the app without it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'child_process';
import { launchApp, launchEnvArgs, parseLaunchEnv, type SpawnImpl } from '../src/devicectl';

function recorder(status = 0): { spawn: SpawnImpl; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnImpl = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status, stdout: Buffer.from(''), stderr: Buffer.from(''), pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<Buffer>;
  };
  return { spawn, calls };
}

let saved: string | undefined;
beforeEach(() => { saved = process.env.GSTACK_IOS_LAUNCH_ENV; delete process.env.GSTACK_IOS_LAUNCH_ENV; });
afterEach(() => { if (saved === undefined) delete process.env.GSTACK_IOS_LAUNCH_ENV; else process.env.GSTACK_IOS_LAUNCH_ENV = saved; });

describe('GSTACK_IOS_LAUNCH_ENV', () => {
  test('unset or empty leaves the launch argv unchanged', () => {
    for (const value of [undefined, '', '  ', '{}']) {
      if (value === undefined) delete process.env.GSTACK_IOS_LAUNCH_ENV; else process.env.GSTACK_IOS_LAUNCH_ENV = value;
      const { spawn, calls } = recorder();
      expect(launchApp('UDID', 'com.test', spawn)).toEqual({ ok: true });
      expect(calls).toEqual([['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', 'UDID', 'com.test']]);
    }
  });

  test('a JSON object is forwarded before the bundle id', () => {
    process.env.GSTACK_IOS_LAUNCH_ENV = '{"DEBUG_BRIDGE":"1","API_BASE":"http://localhost:8080"}';
    const launch = recorder();
    expect(launchApp('UDID', 'com.test', launch.spawn)).toEqual({ ok: true });
    expect(launch.calls[0]).toEqual(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', 'UDID',
      '--environment-variables', '{"DEBUG_BRIDGE":"1","API_BASE":"http://localhost:8080"}', 'com.test']);
    expect(launchEnvArgs()).toEqual({ ok: true, args: ['--environment-variables', '{"DEBUG_BRIDGE":"1","API_BASE":"http://localhost:8080"}'] });
    expect(launchEnvArgs('')).toEqual({ ok: true, args: [] });
  });

  test('invalid JSON, a non-object, a non-string value, a bad name or a bridge-reserved key refuses without launching', () => {
    const cases: Array<[string, string]> = [
      ['{"A":', 'is not valid JSON'],
      ['["A=1"]', 'must be a JSON object of string to string'],
      ['null', 'must be a JSON object of string to string'],
      ['{"PORT":8080}', 'PORT is a number, not a string'],
      ['{"BAD-NAME":"x"}', '"BAD-NAME" is not an environment variable name'],
      ['{"GSTACK_IOS_QA_PORT":"1"}', 'GSTACK_IOS_QA_PORT collides with the debug bridge\'s reserved GSTACK_ variables'],
    ];
    for (const [value, detail] of cases) {
      process.env.GSTACK_IOS_LAUNCH_ENV = value;
      const { spawn, calls } = recorder();
      const r = launchApp('UDID', 'com.test', spawn);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(detail);
      expect(r.error).toEndWith('(IOS_LAUNCH_ENV_INVALID)');
      expect(calls).toEqual([]);
    }
  });

  test('a refusal never echoes a value', () => {
    process.env.GSTACK_IOS_LAUNCH_ENV = '{"TOKEN":"sk-secret-value","N":1}';
    const r = launchApp('UDID', 'com.test', recorder().spawn);
    expect(r.error).not.toContain('sk-secret-value');
    expect(parseLaunchEnv('{"TOKEN": "sk-secret-value"')).toEqual({ ok: false, detail: expect.not.stringContaining('sk-secret-value') });
  });
});
