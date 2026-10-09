import { overheadKey, setModelOverhead, getModelOverhead } from './usage';

describe('model overhead cache', () => {
  it('keys agents by agentId so the resolved reader and raw writer agree', () => {
    /** The writer stores under the raw `agents` submission (no resolved model);
     *  the reader resolves to the agent's real provider/model. Both must produce
     *  the same key, or the cache misses for the main agents case. */
    const writerKey = overheadKey('agents', '', 'agent_123');
    const readerKey = overheadKey('openAI', 'gpt-4', 'agent_123');
    expect(writerKey).toBe('agent:agent_123');
    expect(readerKey).toBe('agent:agent_123');

    setModelOverhead(writerKey, 1500);
    expect(getModelOverhead(readerKey)).toBe(1500);
  });

  it('keys non-agent configs by endpoint:model and round-trips overhead', () => {
    const key = overheadKey('openAI', 'gpt-4', null);
    expect(key).toBe('openAI::gpt-4');

    /** Unknown config defaults to 0 (estimate falls back to message-only). */
    expect(getModelOverhead(key)).toBe(0);

    setModelOverhead(key, 800);
    expect(getModelOverhead(key)).toBe(800);

    /** Non-positive overhead is ignored, keeping the last good value. */
    setModelOverhead(key, 0);
    expect(getModelOverhead(key)).toBe(800);

    /** A different config is isolated. */
    expect(getModelOverhead(overheadKey('google', 'gemini', null))).toBe(0);
  });
});
