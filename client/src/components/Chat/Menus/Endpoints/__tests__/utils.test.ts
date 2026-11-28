import type { Agent } from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';
import type { Endpoint } from '~/common';
import { filterItems, filterSelectorAgents } from '../utils';

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

describe('filterSelectorAgents', () => {
  const own = { id: 'agent_own', name: 'Own', isEditable: true } as Agent;
  const pinnedShared = { id: 'agent_pinned', name: 'Pinned', isEditable: false } as Agent;
  const otherShared = { id: 'agent_other', name: 'Other', isEditable: false } as Agent;
  const list = [own, pinnedShared, otherShared];

  it('keeps pinned agents the user cannot edit when only editable agents are listed', () => {
    const result = filterSelectorAgents(list, {
      editableOnly: true,
      pinnedAgentIds: new Set(['agent_pinned']),
    });
    expect(result).toEqual([own, pinnedShared]);
  });

  it('drops agents the user cannot edit and has not pinned when only editable agents are listed', () => {
    const result = filterSelectorAgents(list, { editableOnly: true, pinnedAgentIds: new Set() });
    expect(result).toEqual([own]);
  });

  it('returns every agent when the list is not limited to editable agents', () => {
    const result = filterSelectorAgents(list, { editableOnly: false, pinnedAgentIds: new Set() });
    expect(result).toEqual(list);
  });

  it('passes an undefined list through', () => {
    const result = filterSelectorAgents(undefined, {
      editableOnly: true,
      pinnedAgentIds: new Set(['agent_pinned']),
    });
    expect(result).toBeUndefined();
  });
});
