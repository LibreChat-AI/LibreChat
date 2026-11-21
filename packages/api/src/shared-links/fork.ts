import {
  isAgentsEndpoint,
  isAssistantsEndpoint,
  resolveModelSpecEndpoint,
} from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { AppConfig } from '~/types';
import { ConversationImportError } from '~/conversations/import';

type Specs = AppConfig['modelSpecs'];
type Spec = NonNullable<NonNullable<Specs>['list']>[number];
type ForkPreset = Pick<TConversation, 'spec' | 'agent_id'>;
type Selection = { endpoint: string; model?: string; preset: ForkPreset };

function select(spec: Spec | undefined): Selection | undefined {
  if (!spec?.name) {
    return;
  }
  const endpoint = resolveModelSpecEndpoint(spec);
  // A copied conversation has no provider thread to resume on an assistants endpoint.
  if (!endpoint || isAssistantsEndpoint(endpoint)) {
    return;
  }
  return {
    endpoint,
    model: spec.preset?.model || undefined,
    preset: {
      spec: spec.name,
      ...(isAgentsEndpoint(endpoint) &&
        spec.preset?.agent_id && { agent_id: spec.preset.agent_id }),
    },
  };
}

function selectSpec(modelSpecs: Specs, name?: string): Selection | undefined {
  const list = modelSpecs?.list;
  if (!list?.length) {
    return;
  }
  const matching = name ? select(list.find((spec) => spec.name === name)) : undefined;
  if (matching || !modelSpecs?.enforce) {
    return matching;
  }

  let soft: Selection | undefined;
  let first: Selection | undefined;
  const seen = new Set<string>();
  for (const spec of list) {
    if (!spec.name || seen.has(spec.name)) {
      continue;
    }
    // Request validation resolves duplicate names to the first declaration.
    seen.add(spec.name);
    if (spec.showInMenu === false) {
      continue;
    }
    const selected = select(spec);
    if (!selected) {
      continue;
    }
    if (spec.default) {
      return selected;
    }
    first ??= selected;
    if (spec.softDefault) {
      soft ??= selected;
    }
  }
  if (soft || first) {
    return soft ?? first;
  }
  throw new ConversationImportError('No model spec is available for this fork', 422);
}

export async function resolveSharedForkSelection({
  modelSpecs,
  spec,
  getDefaultEndpoint,
  getDefaultModel,
}: {
  modelSpecs: Specs;
  spec?: string;
  getDefaultEndpoint: () => Promise<{ endpoint: string; model: string }>;
  getDefaultModel: (endpoint: string) => Promise<string>;
}): Promise<Selection> {
  const selected = selectSpec(modelSpecs, spec);
  if (!selected) {
    return { ...(await getDefaultEndpoint()), preset: {} };
  }
  if (!selected.model && !selected.preset.agent_id) {
    selected.model = await getDefaultModel(selected.endpoint);
  }
  return selected;
}
