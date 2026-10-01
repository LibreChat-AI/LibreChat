import { getConfigDefaults, RetentionMode } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import { loadDefaultInterface } from './interface';

describe('loadDefaultInterface', () => {
  it('uses the schema default for URL auto-submit when not configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.autoSubmitFromUrl).toBe(true);
  });

  it('uses the schema default for code highlight throttling when not configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.codeHighlightThrottleMs).toBe(300);
  });

  it('preserves a configured code highlight throttle interval', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        codeHighlightThrottleMs: 100,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.codeHighlightThrottleMs).toBe(100);
  });

  it('uses the schema default for the agent selector list cap when not configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.agentSelectorLimit).toBe(10);
  });

  it('forwards a configured agent selector list cap to the served interface', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        agentSelectorLimit: 4,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.agentSelectorLimit).toBe(4);
  });

  it('preserves disabled URL auto-submit config', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        autoSubmitFromUrl: false,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.autoSubmitFromUrl).toBe(false);
  });

  it('preserves a disabled build info flag', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        buildInfo: false,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.buildInfo).toBe(false);
  });

  it('uses the schema default for build info when not configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.buildInfo).toBe(true);
  });

  it('preserves enabled build info config', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        buildInfo: true,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.buildInfo).toBe(true);
  });

  it('enables response feedback by default', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.feedback).toBe(true);
  });

  it('preserves a disabled response feedback flag', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        feedback: false,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.feedback).toBe(false);
  });

  it('disables context cost by default', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.contextCost).toBe(false);
  });

  it('preserves a disabled context cost flag', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        contextCost: false,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.contextCost).toBe(false);
  });

  it('preserves enabled context cost config', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        contextCost: true,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.contextCost).toBe(true);
  });

  it('disables token throughput by default', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.tokenThroughput).toBe(false);
  });

  it('preserves an enabled token throughput flag', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        tokenThroughput: true,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.tokenThroughput).toBe(true);
  });

  it('passes through a configured display currency', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        currency: { code: 'EUR', rate: 0.92 },
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.currency).toEqual({ code: 'EUR', rate: 0.92 });
  });

  it('omits currency when it is not configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.currency).toBeUndefined();
  });

  it('preserves enabled URL auto-submit config', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        autoSubmitFromUrl: true,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.autoSubmitFromUrl).toBe(true);
  });

  it('preserves the configured chat retention periods', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        temporaryChatRetention: 24,
        generalChatRetention: 2160,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.temporaryChatRetention).toBe(24);
    expect(interfaceConfig?.generalChatRetention).toBe(2160);
  });

  it('omits temporary chat retention when it is not explicitly configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig).not.toHaveProperty('temporaryChatRetention');
    expect(interfaceConfig).not.toHaveProperty('generalChatRetention');
  });

  it('preserves the configured agent file retention exemption', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        retentionMode: RetentionMode.ALL,
        retainAgentFiles: true,
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.retentionMode).toBe(RetentionMode.ALL);
    expect(interfaceConfig?.retainAgentFiles).toBe(true);
  });

  it('passes through configured default pinned tools', async () => {
    const config: Partial<TCustomConfig> = {
      interface: {
        defaultPinnedTools: ['artifacts', 'execute_code', 'mcp'],
      },
    };

    const interfaceConfig = await loadDefaultInterface({
      config,
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.defaultPinnedTools).toEqual(['artifacts', 'execute_code', 'mcp']);
  });

  it('omits default pinned tools when not explicitly configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig).not.toHaveProperty('defaultPinnedTools');
  });

  it('passes the trace viewer section through unchanged', async () => {
    const traceViewer = { enabled: true, showInputOutput: false, maxRecords: 200 };
    const interfaceConfig = await loadDefaultInterface({
      config: { interface: { traceViewer } },
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.traceViewer).toEqual(traceViewer);
  });

  it('leaves the trace viewer unset when not configured', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });

    expect(interfaceConfig?.traceViewer).toBeUndefined();
  });
});
