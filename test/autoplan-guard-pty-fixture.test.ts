import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closePacketReadAfterNotice, prepareGuardSession } from './helpers/autoplan-guard-pty';

const base = '/home/runner/.cache/gstack-paid-shard-x/tmp/ap-guard-pty-y';

test('the close-packet check accepts a Read in the notice turn and rejects one made before the notice', () => {
  // PR gate 39069171159 (b789898, pass): the CEO reviewer's notice started the turn that read the close packet.
  expect(closePacketReadAfterNotice([
    `Read ${base}/project/.gstack/tmp/autoplan/autoplan-ceo-oMVeYz/close-packet.md`,
    'Bash true autoplan-published ceo',
    `Read ${base}/home/.claude/skills/gstack/autoplan/sections/design-phase.md`,
    'Agent Design review',
  ])).toBe(true);
  // PR gate 39070276914 (dc739be, fail): the actor read the close packet in the dispatch turn, before the notice.
  expect(closePacketReadAfterNotice([
    'Bash true autoplan-published ceo',
    `Read ${base}/home/.claude/skills/gstack/autoplan/sections/design-phase.md`,
    `Bash cat "${base}/project/.gstack/tmp/autoplan/dispatch-design.txt"`,
    'Agent Design review',
  ])).toBe(false);
});

test('the scripted actor ends its turn after a background CEO dispatch and reads the close packet only after the reviewer finishes', () => {
  const s = prepareGuardSession(undefined);
  try {
    const skill = fs.readFileSync(path.join(s.project, '.claude', 'skills', fs.readdirSync(path.join(s.project, '.claude', 'skills'))[0]!, 'SKILL.md'), 'utf8');
    const step = (n: number) => skill.slice(skill.indexOf(`\n${n}. `) + 1, skill.indexOf(`\n${n + 1}. `));
    expect(step(5)).toContain('If its result says the agent is running in the background, end your turn at once with no further tool call; the completion notification starts your next turn.');
    expect(step(5)).not.toContain('If the agent runs in the background, end your turn and wait');
    expect(step(6).startsWith('6. Only after the CEO review agent has finished (in the turn its completion notification starts, when it ran in the background), Read the file whose path step 3 printed')).toBe(true);
    expect(skill.indexOf('\n6. ')).toBeGreaterThan(skill.indexOf('\n5. '));
  } finally { s.cleanup(); }
});
