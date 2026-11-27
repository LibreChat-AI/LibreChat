import { configureAgentEventRuntime } from './agents';

describe('configureAgentEventRuntime', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = { ...originalEnvironment };
    delete process.env.AGENT_TRIGGERS_SELF_URL;
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('projects the explicit base-config routing choice', () => {
    configureAgentEventRuntime({
      selfUrl: 'https://triggers.internal',
    });

    expect(process.env.AGENT_TRIGGERS_SELF_URL).toBe('https://triggers.internal');
  });

  it('preserves the environment routing fallback when YAML is omitted', () => {
    process.env.AGENT_TRIGGERS_SELF_URL = 'https://legacy.internal';

    configureAgentEventRuntime(undefined);

    expect(process.env.AGENT_TRIGGERS_SELF_URL).toBe('https://legacy.internal');
  });
});
