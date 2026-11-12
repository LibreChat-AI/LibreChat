import type { TModelSpec } from 'librechat-data-provider';
import { synthesizeToggleToolOptions } from './toggles';
import { TOOL_SELECTION_WILDCARD } from './selection';

const spec = (overrides: Partial<TModelSpec>): TModelSpec =>
  ({
    name: 'spec',
    label: 'Spec',
    preset: { endpoint: 'openai', model: 'gpt-4' },
    ...overrides,
  }) as TModelSpec;

describe('synthesizeToggleToolOptions', () => {
  it('composes the deferral selection with background and intent selections', () => {
    const toolOptions = synthesizeToggleToolOptions({
      modelSpec: spec({ deferLoading: ['web_search'], runInBackground: true }),
    });
    expect(toolOptions).toEqual({
      [TOOL_SELECTION_WILDCARD]: { run_in_background: true, defer_loading: false },
      web_search: { defer_loading: true },
    });
  });

  it('returns nothing when no selection applies', () => {
    expect(synthesizeToggleToolOptions({ modelSpec: spec({}) })).toBeUndefined();
  });
});
