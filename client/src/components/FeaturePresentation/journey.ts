import type { Location } from 'react-router-dom';

const marker = '__librechatChatJourney';

export function chatJourney(location: Pick<Location, 'key' | 'state'>): string {
  const state: unknown = location.state;
  return state != null &&
    typeof state === 'object' &&
    marker in state &&
    typeof state[marker] === 'string'
    ? state[marker]
    : location.key;
}

export const chatJourneyState = (journey: string) => ({ [marker]: journey });
