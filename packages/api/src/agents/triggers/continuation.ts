import type { AgentTriggerExecutionHostDeps } from './host';

type ContinueResolver = NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']>;

export interface AgentContinuationResolverDeps {
  eventActor: ContinueResolver;
  internalSources: ReadonlyMap<string, ContinueResolver>;
  /** Adapters for continuations the server queues for an outside source, by source type. */
  sources?: ReadonlyMap<string, ContinueResolver>;
}

/** Selects the single continuation adapter authorized for this delivery. */
export function createAgentContinuationResolver({
  eventActor,
  internalSources,
  sources,
}: AgentContinuationResolverDeps): ContinueResolver {
  return (envelope, context) => {
    if (envelope.target.bindingId != null && envelope.target.sourceKeyId != null) {
      return eventActor(envelope, context);
    }
    if (envelope.event.source.type !== 'internal') {
      return sources?.get(envelope.event.source.type)?.(envelope, context);
    }
    return internalSources.get(envelope.event.source.id)?.(envelope, context);
  };
}
