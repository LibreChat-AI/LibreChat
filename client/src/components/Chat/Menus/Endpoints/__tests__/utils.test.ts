import type { useLocalize } from '~/hooks';
import type { Endpoint } from '~/common';
import { filterItems, filterModels, getDisplayValue, getModelName } from '../utils';

const agentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  icon: null,
  showMarketplace: true,
  searchAliases: ['agent marketplace', 'marketplace'],
};

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

describe('model selector utilities', () => {
  it('matches endpoint search aliases', () => {
    const results = filterItems([agentsEndpoint], 'marketplace', undefined, undefined);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('matches localized Marketplace labels', () => {
    const localize = ((key: string) => {
      if (key === 'com_agents_marketplace') {
        return 'Tienda de Agentes';
      }
      if (key === 'com_ui_marketplace') {
        return 'Tienda';
      }
      return key;
    }) as ReturnType<typeof useLocalize>;

    const results = filterItems([agentsEndpoint], 'tienda', undefined, undefined, localize);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('does not match agents when there are no selectable agent options', () => {
    const results = filterItems([disabledAgentsEndpoint], 'my agents', undefined, undefined);
    expect(results).toEqual([]);
  });
});

const claudeEndpoint: Endpoint = {
  value: 'Claude',
  label: 'Claude',
  hasModels: true,
  icon: null,
  models: [{ name: 'claude-opus-4-8' }, { name: 'claude-sonnet-4-6' }],
  modelLabels: { 'claude-opus-4-8': 'Opus 4.8' },
};

describe('getModelName', () => {
  it('returns the declared label for a labelled model', () => {
    expect(getModelName(claudeEndpoint, 'claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('returns undefined for a model with no label, so callers fall back to the id', () => {
    expect(getModelName(claudeEndpoint, 'claude-sonnet-4-6')).toBeUndefined();
  });

  it('ignores modelLabels on agents and assistants endpoints', () => {
    const agents: Endpoint = {
      value: 'agents',
      label: 'Agents',
      hasModels: true,
      icon: null,
      agentNames: { 'agent-1': 'Support Agent', 'agent-2': '' },
      modelLabels: { 'agent-1': 'Never Rendered' },
    };
    expect(getModelName(agents, 'agent-1')).toBe('Support Agent');
    /* An unnamed agent stores '', which must read as no name at all. */
    expect(getModelName(agents, 'agent-2')).toBeUndefined();
  });

  it('tolerates a missing endpoint or model', () => {
    expect(getModelName(null, 'claude-opus-4-8')).toBeUndefined();
    expect(getModelName(claudeEndpoint, null)).toBeUndefined();
  });
});

describe('label-aware search', () => {
  it('matches an endpoint on a model label', () => {
    expect(filterItems([claudeEndpoint], 'opus 4.8', undefined, undefined)).toEqual([
      claudeEndpoint,
    ]);
  });

  it('still matches an endpoint on the raw model id', () => {
    expect(filterItems([claudeEndpoint], 'claude-opus', undefined, undefined)).toEqual([
      claudeEndpoint,
    ]);
  });

  it('filters models by label and by id, since a label is additive', () => {
    const models = ['claude-opus-4-8', 'claude-sonnet-4-6'];
    expect(filterModels(claudeEndpoint, models, 'Opus 4.8', undefined, undefined)).toEqual([
      'claude-opus-4-8',
    ]);
    expect(filterModels(claudeEndpoint, models, 'opus-4-8', undefined, undefined)).toEqual([
      'claude-opus-4-8',
    ]);
  });
});

describe('getDisplayValue', () => {
  const localize = ((key: string) => key) as ReturnType<typeof useLocalize>;

  it('shows the label of the selected model', () => {
    expect(
      getDisplayValue({
        localize,
        mappedEndpoints: [claudeEndpoint],
        selectedValues: { endpoint: 'Claude', model: 'claude-opus-4-8', modelSpec: '' },
        modelSpecs: [],
      }),
    ).toBe('Opus 4.8');
  });
});
