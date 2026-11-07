import { Tools } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import { ASK_USER_QUESTION_TOOL_NAME } from './hitl/askUserQuestionTool';
import { getToggleToolNames, resolveToolToggle } from './toggles';

const spec = (overrides: Partial<TModelSpec>): TModelSpec =>
  ({
    name: 'spec',
    label: 'Spec',
    preset: { endpoint: 'agents' },
    ...overrides,
  }) as TModelSpec;

const allOn = spec({
  executeCode: true,
  fileSearch: true,
  webSearch: true,
  memory: true,
  askUserQuestion: true,
});

describe('resolveToolToggle', () => {
  it('honors a badge the user switched off over the spec default', () => {
    expect(resolveToolToggle(false, true)).toBe(false);
    expect(resolveToolToggle(true, false)).toBe(true);
  });

  it('falls back to the spec when the client sent no badge state', () => {
    expect(resolveToolToggle(undefined, true)).toBe(true);
    expect(resolveToolToggle(undefined, undefined)).toBe(false);
  });

  it.each([
    ['hides the badge row', { hideBadgeRow: true }],
    ['is not sent to the client', { showInMenu: false }],
  ])('combines both sources when the spec %s', (_label, visibility) => {
    expect(resolveToolToggle(false, true, visibility)).toBe(true);
    expect(resolveToolToggle(true, false, visibility)).toBe(true);
    expect(resolveToolToggle(false, false, visibility)).toBe(false);
    expect(resolveToolToggle(undefined, undefined, visibility)).toBe(false);
  });

  it('lets the user decide for a listed spec with visible badges', () => {
    const visible = { showInMenu: true, hideBadgeRow: false };
    expect(resolveToolToggle(false, true, visible)).toBe(false);
  });
});

describe('getToggleToolNames', () => {
  it('equips every tool a spec enables when the client sends no badges (API callers)', () => {
    expect(getToggleToolNames({ modelSpec: allOn })).toEqual([
      Tools.execute_code,
      Tools.file_search,
      Tools.web_search,
      Tools.memory,
      ASK_USER_QUESTION_TOOL_NAME,
    ]);
  });

  it('drops the tools whose badges the user switched off', () => {
    const tools = getToggleToolNames({
      modelSpec: allOn,
      ephemeralAgent: { execute_code: false, web_search: false, file_search: true },
    });
    expect(tools).toEqual([Tools.file_search, Tools.memory, ASK_USER_QUESTION_TOOL_NAME]);
  });

  it('keeps every spec tool when the spec hides the badge row', () => {
    const tools = getToggleToolNames({
      modelSpec: { ...allOn, hideBadgeRow: true },
      ephemeralAgent: { execute_code: false, web_search: false },
    });
    expect(tools).toContain(Tools.execute_code);
    expect(tools).toContain(Tools.web_search);
  });

  it('equips badge-selected tools without a spec', () => {
    expect(getToggleToolNames({ ephemeralAgent: { web_search: true } })).toEqual([
      Tools.web_search,
    ]);
  });
});
