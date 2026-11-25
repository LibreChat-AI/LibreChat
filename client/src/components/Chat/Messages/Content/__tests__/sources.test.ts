import { Tools } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { getSourceDomains } from '../sources';

const search = (
  toolCallId: string,
  links: string[],
  agentId = 'agent-a',
  stepId = 'step-a',
): TAttachment =>
  ({
    type: Tools.web_search,
    toolCallId,
    agentId,
    stepId,
    messageId: 'message',
    [Tools.web_search]: {
      turn: 0,
      organic: links.map((link) => ({ link, title: link })),
    },
  }) as TAttachment;

describe('source domains for a collapsed header', () => {
  it.each([
    ['another call', 'second', 'agent-a', 'step-a'],
    ['another agent', 'first', 'agent-b', 'step-a'],
    ['another step', 'first', 'agent-a', 'step-b'],
  ])('retains a repeated turn owned by %s', (_, id, agent, step) => {
    expect(
      getSourceDomains(
        [
          search('first', ['https://one.example/a']),
          search(id, ['https://two.example/b'], agent, step),
        ],
        3,
      ),
    ).toEqual(['one.example', 'two.example']);
  });

  it('uses the latest snapshot for the same owner and turn', () => {
    expect(
      getSourceDomains(
        [
          search('first', ['https://stale.example/a']),
          search('first', ['https://fresh.example/b']),
        ],
        3,
      ),
    ).toEqual(['fresh.example']);
  });

  it('deduplicates domains across searches and respects the display cap', () => {
    expect(
      getSourceDomains(
        [
          search('first', ['https://www.one.example/a', 'https://one.example/b']),
          search('second', ['https://two.example/a', 'https://three.example/a']),
        ],
        2,
      ),
    ).toEqual(['one.example', 'two.example']);
  });

  it('returns a stable empty result when there are no owned sources', () => {
    expect(getSourceDomains(undefined, 3)).toBe(getSourceDomains([], 3));
  });
});
