import type { Agents } from 'librechat-data-provider';
import { isSkillAuthoringToolCall } from '../steps/tools';

describe.each(['create_file', 'edit_file'])('%s skill authoring detection', (name) => {
  it.each(['path', 'file_path'])('recognizes %s in object and JSON arguments', (field) => {
    const args = { [field]: 'skills/demo/SKILL.md' };
    expect(isSkillAuthoringToolCall({ name, args })).toBe(true);
    expect(isSkillAuthoringToolCall({ name, args: JSON.stringify(args) })).toBe(true);
  });

  it('prefers path over the legacy file_path field', () => {
    for (const args of [
      { path: 'skills/demo/references/a.md', file_path: 'workspace/a.md' },
      { path: 'workspace/a.md', file_path: 'skills/demo/SKILL.md' },
    ]) {
      const expected = args.path.startsWith('skills/');
      expect(isSkillAuthoringToolCall({ name, args })).toBe(expected);
      expect(isSkillAuthoringToolCall({ name, args: JSON.stringify(args) })).toBe(expected);
    }
  });

  it.each<Agents.ToolCall['args']>([
    undefined,
    '',
    '{invalid json',
    'null',
    '{}',
    { path: null },
    { path: 42 },
    { path: 'workspace/skills/demo/SKILL.md' },
    { path: 'demo/SKILL.md' },
    { file_path: 'workspace/a.md' },
  ])('ignores arguments without a skill path: %j', (args) => {
    expect(isSkillAuthoringToolCall({ name, args })).toBe(false);
  });
});

it('ignores missing calls and tools that do not author files', () => {
  expect(isSkillAuthoringToolCall()).toBe(false);
  expect(
    isSkillAuthoringToolCall({ name: 'read_file', args: { path: 'skills/demo/SKILL.md' } }),
  ).toBe(false);
});
