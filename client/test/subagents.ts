import type { SubagentUpdateEvent } from 'librechat-data-provider';
import type { SubagentContentPart, SubagentTickerLine } from '~/utils/subagentContent';
import {
  foldSubagentEvent,
  initSubagentTickerState,
  foldSubagentEventIntoTicker,
  initSubagentAggregatorState,
} from '~/utils/subagentContent';

/** Folds a whole event stream through the incremental aggregator the live UI uses. */
export function aggregateSubagentContent(events: SubagentUpdateEvent[]): SubagentContentPart[] {
  let parts: SubagentContentPart[] = [];
  let state = initSubagentAggregatorState();
  for (const event of events) {
    ({ parts, state } = foldSubagentEvent(parts, state, event));
  }
  return parts;
}

/** Folds a whole event stream through the incremental ticker the live UI uses. */
export function buildSubagentTickerLines(events: SubagentUpdateEvent[]): SubagentTickerLine[] {
  let state = initSubagentTickerState();
  for (const event of events) {
    state = foldSubagentEventIntoTicker(state, event);
  }
  return state.lines;
}
