import { Send } from '@langchain/langgraph';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import { encodeSdkValue, decodeSdkValue } from './wire';

describe('SDK wire data', () => {
  it('round-trips checkpoint messages and structured values without confusing user tag fields', () => {
    const source = {
      messages: [
        new HumanMessage('hello'),
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call',
              name: 'inspect',
              args: { nested: { $sdk: 'undefined', value: 'user data' } },
            },
          ],
        }),
      ],
      bytes: new Uint8Array([1, 2, 255]),
      map: new Map([['key', new Set([1, 2])]]),
      send: new Send('inspect', { subject: 'fixture' }),
      numbers: [NaN, Infinity, -Infinity, -0],
      missing: undefined,
      number: BigInt('12345678901234567890'),
      date: new Date('2026-01-01Z'),
    };
    const result = decodeSdkValue(
      JSON.parse(JSON.stringify(encodeSdkValue(source))),
    ) as typeof source;
    expect(result.messages[0]).toBeInstanceOf(HumanMessage);
    expect(result.messages[1]).toBeInstanceOf(AIMessage);
    expect(result).toEqual(source);
  });
  it('refuses closures instead of serializing host behavior', () => {
    expect(() => encodeSdkValue({ secretProvider: () => 'secret' })).toThrow('not serializable');
  });
});

it('refuses unknown classes instead of silently losing graph state', () => {
  class UnregisteredState {
    value = 'private';
  }
  expect(() => encodeSdkValue(new UnregisteredState())).toThrow('class is not serializable');
});
