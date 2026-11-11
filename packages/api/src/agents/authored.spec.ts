import { AuthoredSkillState, captureAuthoredSkills, restoreAuthoredSkills } from './authored';

const id = '507f1f77bcf86cd799439011';
const handler = () => ({ handle: jest.fn() });

test('keeps authoring scopes separate and preserves unconsumed bindings across re-pause', () => {
  const original = new AuthoredSkillState();
  const first = handler();
  original.bind(first);
  original.record({ agentId: 'a', executionId: 'child-1' }, { name: 'created', id, primed: true });
  const snapshot = captureAuthoredSkills(first);
  const resumed = new AuthoredSkillState();
  const second = handler();
  resumed.bind(second);
  restoreAuthoredSkills(second, JSON.parse(JSON.stringify(snapshot)));
  expect(resumed.take({ agentId: 'b', executionId: 'child-1' }, new Set(['created']))).toEqual([]);
  expect(resumed.take({ agentId: 'a', executionId: 'child-2' }, new Set(['created']))).toEqual([]);
  expect(resumed.take({ agentId: 'a' }, new Set(['created']))).toEqual([]);
  expect(captureAuthoredSkills(second)).toEqual(snapshot);
  expect(resumed.take({ agentId: 'a', executionId: 'child-1' }, new Set(['created']))).toEqual(
    snapshot,
  );
  resumed.confirm({ agentId: 'a', executionId: 'child-1' }, 'created');
  expect(resumed.take({ agentId: 'a', executionId: 'child-1' }, new Set(['created']))).toEqual([]);
  snapshot[0].name = 'mutated';
  expect(captureAuthoredSkills(first)[0].name).toBe('created');
});

test('does not downgrade an existing prime during same-author recovery', () => {
  const state = new AuthoredSkillState();
  state.record({ agentId: 'a' }, { name: 'created', id, primed: true });
  state.record({ agentId: 'a' }, { name: 'created', id, primed: false });
  expect(state.snapshot()[0].primed).toBe(true);
});

test('round-trips every valid name shape accepted by skill authoring', () => {
  const original = new AuthoredSkillState();
  original.record({ agentId: 'a' }, { name: 'valid--name-', id, primed: false });
  const resumed = new AuthoredSkillState();
  resumed.restore(original.snapshot());
  expect(resumed.snapshot()).toEqual(original.snapshot());
});
