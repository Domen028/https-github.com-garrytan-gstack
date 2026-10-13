/**
 * Field wave CD1/CD2 config keys in `.gstack/pregate.json`: the repo's guards
 * (commands a lane must pass before it reports done), the serial-test
 * patterns the lanes check runs in their own process, and the non-executing
 * call-plan command a paid gate is priced from. Validation stays strict:
 * every key is typed, globs are contained, commands are one line.
 */
import { describe, expect, test } from 'bun:test';
import { parseConfig, validateConfig } from '../lib/pregate/config';
import { CHECK_IDS } from '../lib/pregate/index';

const codes = (c: unknown) => validateConfig(c, CHECK_IDS).map(e => `${e.code}:${e.path}`);

describe('pregate config: price_command', () => {
  test('a one-line price_command is valid and parsed; a multi-line or empty one is PREGATE_CONFIG_INVALID', () => {
    expect(codes({ price_command: 'bun run eval:plan-calls' })).toEqual([]);
    expect(parseConfig(JSON.stringify({ price_command: 'bun run eval:plan-calls' })).config.price_command).toBe('bun run eval:plan-calls');
    expect(parseConfig('{}').config.price_command).toBeNull();
    expect(codes({ price_command: 'a\nb' })).toEqual(['PREGATE_CONFIG_INVALID:price_command']);
    expect(codes({ price_command: '' })).toEqual(['PREGATE_CONFIG_INVALID:price_command']);
  });
});
