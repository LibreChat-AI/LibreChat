import { getModelRefusalInfo } from './refusal';

describe('getModelRefusalInfo', () => {
  it.each([
    { response_metadata: { messageStop: { stopReason: 'content_filtered' } } },
    { response_metadata: { stopReason: 'content_filtered' } },
  ])('normalizes Bedrock content filtering', (output) => {
    expect(getModelRefusalInfo(output)).toEqual({ stop_reason: 'content_filtered' });
  });

  it('preserves Anthropic refusal metadata', () => {
    expect(
      getModelRefusalInfo({ additional_kwargs: { stop_reason: 'refusal', reason: 'safety' } }),
    ).toEqual({ stop_reason: 'refusal', reason: 'safety' });
  });

  it('ignores normal completions', () => {
    expect(
      getModelRefusalInfo({
        additional_kwargs: { stop_reason: 'end_turn' },
        response_metadata: { stopReason: 'end_turn' },
      }),
    ).toBeUndefined();
  });
});
