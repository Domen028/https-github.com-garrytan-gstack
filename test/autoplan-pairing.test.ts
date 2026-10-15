/**
 * Pairing negative control (next-wave B2/B-a): finding pairs copied verbatim
 * from a real autoplan run. File:line proximity associates findings but never
 * confirms them; only a title match or the parent's override does, and `b`
 * needs one shared proposal or the same remedy.
 */
import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/autoplan-pairing/run-20261014-pairs.json';
import { reconcile } from '../lib/autoplan-reconcile';
import { challengeDefault } from '../lib/autoplan-gate';

const pair = (name: string) => fixture.pairs.find(p => p.name.startsWith(name))! as any;
const challenge = (rows: any[], changes = 'direction') => rows.map(r => ({ ...r, user_challenge: true, changes }));

describe('pairing negative control from a real run', () => {
  test('two findings three lines apart on one file are associated but never confirmed, and never recommend b', () => {
    const p = pair('ceo r1 outside-1');
    const [row] = reconcile(p.native, p.outside).rows;
    expect(row).toMatchObject({ disposition: 'unverified', basis: 'file_line', native_id: p.native[0].id });
    expect(row!.resolution).toStartWith('same location, agreement unverified (bin/gstack-capy-install:197)');
    const [n] = challenge(p.native), [o] = challenge(p.outside);
    expect(challengeDefault(row!, n, o)).toMatchObject({ recommended: 'a', basis: 'plan direction; same location, agreement unverified' });
  });

  test('a location match with different titles stays unverified until the parent confirms it with one proposal', () => {
    const p = pair('dx r2 outside-2');
    const [row] = reconcile(p.native, p.outside).rows;
    expect(row!.disposition).toBe('unverified');
    const [confirmed] = reconcile(p.native, p.outside, [{ outside_id: p.outside[0].id, native_id: p.native[0].id, disposition: 'confirmed', resolution: 'same trailer grammar break', proposal: 'keep `gstack: fail <components>` and specify the pins exit' }]).rows;
    expect(challengeDefault(confirmed!, challenge(p.native, 'scope')[0], challenge(p.outside, 'scope')[0])).toMatchObject({ recommended: 'b', basis: 'both voices; shared proposal' });
  });

  test('the same problem on different files is new until the parent associates it; different remedies keep a', () => {
    const p = pair('dx r2 native-2');
    expect(reconcile(p.native, p.outside).rows[0]).toMatchObject({ disposition: 'new', native_id: null });
    const [row] = reconcile(p.native, p.outside, [{ outside_id: p.outside[0].id, native_id: p.native[0].id, disposition: 'confirmed', resolution: 'both: a recommendation edit changes what a seen reply resolves to' }]).rows;
    expect(challengeDefault(row!, challenge(p.native, 'scope')[0], challenge(p.outside, 'scope')[0])).toMatchObject({ recommended: 'a', basis: 'plan direction; remedies differ; no shared proposal' });
  });
});
