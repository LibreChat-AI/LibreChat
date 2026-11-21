import type { AgentKeyMCPGrantHost } from '~/apiKeys/grants';
import { initializeWithScheduleMCPExecution } from '~/schedules/authorization/runtime';

type ScheduleInput = Parameters<typeof initializeWithScheduleMCPExecution>[0];
type ScheduleHost = ReturnType<Parameters<typeof initializeWithScheduleMCPExecution>[1]>;

/** The hosts that put a run under what its subject was granted, one per kind of subject. */
export interface AuthorityHosts {
  schedule: ScheduleHost;
  key: Pick<AgentKeyMCPGrantHost, 'prepare'>;
}

/**
 * Initializes a run on the chat route under what its subject was granted, before any tool is
 * loaded. A schedule's occurrence, and the turns its tasks report back in, go to the schedule
 * host as before. A delivery of the trigger engine goes to the host of the subject it names:
 * one an API key posted runs under that key's grant, as a run the key starts through the
 * remote API does. Any other request initializes as it is.
 *
 * The remote API's own controllers call the key host themselves and do not come through here,
 * so a run is never put under its key's grant twice.
 */
export function initializeWithAuthority<T>(
  input: ScheduleInput,
  getHosts: () => AuthorityHosts,
  initialize: () => Promise<T>,
  retainCompletion?: Parameters<typeof initializeWithScheduleMCPExecution>[3],
): Promise<T> {
  return initializeWithScheduleMCPExecution(
    input,
    () => getHosts().schedule,
    async () => {
      const source = input.executionContext?.source;
      if (source?.type === 'trigger' && source.subject?.kind === 'key')
        await getHosts().key.prepare({
          req: input.req,
          executionContext: input.executionContext,
          signal: input.signal,
        });
      return initialize();
    },
    retainCompletion,
  );
}
