import type { AgentSubagentsConfig, GraphEdge } from 'librechat-data-provider';
import type { FormSelection } from '../selectors';
import type { AgentItem } from '../types';
import { isHandoffEdge, setSubagentsEnabled, removeHandoffs } from '../orchestration';
import { hasConfigurableSettings } from '../configurable';
import { deriveSelectedItems } from '../selectors';
import { computeToggleAction } from '../mutations';

const subagentItem: AgentItem = {
  kind: 'builtin',
  id: 'subagents',
  name: '',
  description: '',
  iconKey: 'subagents',
};
const handoffItem: AgentItem = {
  kind: 'builtin',
  id: 'handoffs',
  name: '',
  description: '',
  iconKey: 'handoffs',
};
const catalog = [subagentItem, handoffItem];
const form: FormSelection = {
  execute_code: false,
  web_search: false,
  file_search: false,
  memory: false,
  artifacts: '',
  tools: [],
  skills: [],
  context_files: [],
  knowledge_files: [],
  code_files: [],
};
const handoff: GraphEdge = {
  from: 'parent',
  to: 'child',
  edgeType: 'handoff',
  prompt: 'Keep this',
};
const direct: GraphEdge = { from: 'parent', to: 'other', edgeType: 'direct' };

test('derives each native tool independently from stored configuration', () => {
  expect(deriveSelectedItems(form, catalog, [])).toEqual([]);
  expect(deriveSelectedItems({ ...form, subagents: { enabled: true } }, catalog, [])).toEqual([
    subagentItem,
  ]);
  expect(deriveSelectedItems({ ...form, edges: [handoff] }, catalog, [])).toEqual([handoffItem]);
  expect(
    deriveSelectedItems({ ...form, subagents: { enabled: true }, edges: [handoff] }, catalog, []),
  ).toEqual(catalog);
  expect(
    deriveSelectedItems(
      { ...form, edges: [direct], subagents: { enabled: false, agent_ids: ['child'] } },
      catalog,
      [],
    ),
  ).toEqual([]);
});

test('toggles subagents and opens destination settings to add handoffs', () => {
  expect(computeToggleAction(subagentItem, { selected: false })).toEqual({
    type: 'subagents',
    enabled: true,
  });
  expect(computeToggleAction(subagentItem, { selected: true })).toEqual({
    type: 'subagents',
    enabled: false,
  });
  expect(computeToggleAction(handoffItem, { selected: false })).toEqual({ type: 'configure' });
  expect(computeToggleAction(handoffItem, { selected: true })).toEqual({ type: 'handoffs-remove' });
  expect(hasConfigurableSettings(subagentItem)).toBe(true);
  expect(hasConfigurableSettings(handoffItem)).toBe(true);
});

test('subagent toggles preserve their complete settings and restore the retained roster', () => {
  const subagents: AgentSubagentsConfig = {
    enabled: true,
    allowSelf: false,
    agent_ids: ['child'],
    shareFiles: true,
    graphs: [
      {
        type: 'team',
        name: 'Review',
        description: 'Review work',
        entry_agent_id: 'child',
        result_agent_id: 'child',
        agent_ids: ['child'],
        edges: [],
      },
    ],
  };
  const disabled = setSubagentsEnabled(subagents, false);
  expect(disabled).toEqual({ ...subagents, enabled: false });
  expect(subagents.enabled).toBe(true);
  expect(setSubagentsEnabled(disabled, true)).toEqual(subagents);
  expect(setSubagentsEnabled(undefined, true)).toEqual({
    enabled: true,
    allowSelf: true,
    agent_ids: [],
  });
});

test.each<[GraphEdge, boolean]>([
  [{ from: 'parent', to: 'child' }, true],
  [{ from: ['parent'], to: ['child'] }, true],
  [{ from: ['left', 'right'], to: 'child' }, true],
  [{ from: 'parent', to: ['left', 'right'] }, false],
  [{ from: 'parent', to: ['left', 'right'], condition: () => true }, true],
  [{ from: 'parent', to: ['left', 'right'], edgeType: 'handoff' }, true],
  [{ from: 'parent', to: 'child', edgeType: 'direct' }, false],
])('matches runtime classification for %j', (edge, expected) => {
  expect(isHandoffEdge(edge)).toBe(expected);
  expect(deriveSelectedItems({ ...form, edges: [edge] }, [handoffItem], [])).toEqual(
    expected ? [handoffItem] : [],
  );
  expect(removeHandoffs([edge])).toEqual(expected ? [] : [edge]);
});

test('handoff removal retains all direct edges and does not mutate stored input', () => {
  const implicitDirect: GraphEdge = { from: 'parent', to: ['left', 'right'] };
  const edges = [handoff, direct, implicitDirect];
  expect(removeHandoffs(edges)).toEqual([direct, implicitDirect]);
  expect(edges).toHaveLength(3);
  expect(removeHandoffs()).toEqual([]);
});
