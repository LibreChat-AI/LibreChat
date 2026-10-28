import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useQuery, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TStartupConfig } from 'librechat-data-provider';
import { MCPAppsPolicyProvider, useMCPAppsHost, useMCPAppsPolicy } from '../MCPAppsPolicyContext';

function PolicyProbe() {
  const policy = useMCPAppsPolicy();
  return <output>{`${policy.enabled}:${policy.legacyHtmlEnabled}`}</output>;
}

function HostProbe() {
  const { policy, userId } = useMCPAppsHost();
  return <output>{`${policy.enabled}:${policy.legacyHtmlEnabled}:${userId ?? 'none'}`}</output>;
}

function LimitsProbe() {
  const { cspLimits } = useMCPAppsPolicy();
  return (
    <output>{`${cspLimits?.maxSourcesPerDirective}:${cspLimits?.maxSerializedLength}`}</output>
  );
}

function SandboxPolicyProbe() {
  const { sandboxUrl, maxAdmissionRequestsPerMinute, maxActiveViews, maxActionPreviewChars } =
    useMCPAppsPolicy();
  return (
    <output>{`${sandboxUrl ?? 'none'}:${maxAdmissionRequestsPerMinute ?? 'none'}:${maxActiveViews ?? 'none'}:${maxActionPreviewChars ?? 'none'}`}</output>
  );
}

function CachedPolicyProvider({ children }: { children: React.ReactNode }) {
  const { data, isSuccess, error } = useQuery<TStartupConfig>(
    ['startup-policy'],
    () => new Promise<TStartupConfig>(() => undefined),
    { retry: false },
  );
  return (
    <MCPAppsPolicyProvider startupConfig={data} ready={isSuccess && error == null}>
      {children}
    </MCPAppsPolicyProvider>
  );
}

describe('MCPAppsPolicyProvider', () => {
  it('denies executable UI without an authenticated published policy', () => {
    render(<PolicyProbe />);
    expect(screen.getByText('false:false')).toBeInTheDocument();
  });

  it('publishes only a nonempty authenticated host identity', () => {
    const config = {
      mcpApps: { enabled: true, legacyHtmlEnabled: true },
    } as TStartupConfig;
    const { rerender } = render(
      <MCPAppsPolicyProvider startupConfig={config} ready userId="   ">
        <HostProbe />
      </MCPAppsPolicyProvider>,
    );
    expect(screen.getByText('true:true:none')).toBeInTheDocument();

    rerender(
      <MCPAppsPolicyProvider startupConfig={config} ready userId="user-1">
        <HostProbe />
      </MCPAppsPolicyProvider>,
    );
    expect(screen.getByText('true:true:user-1')).toBeInTheDocument();
  });

  it('uses safe defaults for missing or malformed published CSP limits', () => {
    const { rerender } = render(
      <MCPAppsPolicyProvider
        startupConfig={{ mcpApps: { enabled: true, legacyHtmlEnabled: true } } as TStartupConfig}
        ready
      >
        <LimitsProbe />
      </MCPAppsPolicyProvider>,
    );
    expect(screen.getByText('32:4096')).toBeInTheDocument();

    rerender(
      <MCPAppsPolicyProvider
        startupConfig={
          {
            mcpApps: {
              enabled: true,
              legacyHtmlEnabled: true,
              cspLimits: { maxSourcesPerDirective: 0, maxSerializedLength: 8192 },
            },
          } as TStartupConfig
        }
        ready
      >
        <LimitsProbe />
      </MCPAppsPolicyProvider>,
    );
    expect(screen.getByText('32:8192')).toBeInTheDocument();
  });

  it('preserves deployment-owned sandbox startup fields', () => {
    render(
      <MCPAppsPolicyProvider
        startupConfig={
          {
            mcpApps: {
              enabled: true,
              legacyHtmlEnabled: true,
              sandboxUrl: 'https://mcp-sandbox.example.com/api/mcp/sandbox',
              maxAdmissionRequestsPerMinute: 480,
              maxActiveViews: 7,
              maxActionPreviewChars: 32768,
            },
          } as TStartupConfig
        }
        ready
      >
        <SandboxPolicyProbe />
      </MCPAppsPolicyProvider>,
    );

    expect(
      screen.getByText('https://mcp-sandbox.example.com/api/mcp/sandbox:480:7:32768'),
    ).toBeInTheDocument();
  });

  it('falls back to bounded policy values when a published startup payload is malformed', () => {
    render(
      <MCPAppsPolicyProvider
        ready
        startupConfig={
          {
            mcpApps: {
              enabled: true,
              legacyHtmlEnabled: true,
              maxActiveViews: Infinity,
              maxActionPreviewChars: 0,
            },
          } as TStartupConfig
        }
      >
        <SandboxPolicyProbe />
      </MCPAppsPolicyProvider>,
    );
    expect(screen.getByText('none:none:3:16384')).toBeInTheDocument();
  });

  it('keeps App capacity in an isolated per-host Jotai store', () => {
    function Reserve({ label }: { label: string }) {
      const { reserveView } = useMCPAppsHost();
      const [accepted, setAccepted] = React.useState(false);
      return (
        <>
          <button onClick={() => setAccepted(reserveView(label))}>{label}</button>
          <output>{`${label}:${accepted}`}</output>
        </>
      );
    }
    const config = {
      mcpApps: { enabled: true, legacyHtmlEnabled: true, maxActiveViews: 1 },
    } as TStartupConfig;
    render(
      <>
        <MCPAppsPolicyProvider ready userId="alice" startupConfig={config}>
          <Reserve label="first" />
        </MCPAppsPolicyProvider>
        <MCPAppsPolicyProvider ready userId="bob" startupConfig={config}>
          <Reserve label="second" />
        </MCPAppsPolicyProvider>
      </>,
    );
    // Each provider owns its own capacity; the other user's View remains independent.
    act(() => {
      screen.getByRole('button', { name: 'first' }).click();
      screen.getByRole('button', { name: 'second' }).click();
    });
    expect(screen.getByText('first:true')).toBeInTheDocument();
    expect(screen.getByText('second:true')).toBeInTheDocument();
  });

  it('tracks the startup cache without exposing pending, missing, or malformed policy', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CachedPolicyProvider>
          <PolicyProbe />
        </CachedPolicyProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText('false:false')).toBeInTheDocument();

    act(() => {
      queryClient.setQueryData<TStartupConfig>(['startup-policy'], {
        mcpApps: { enabled: false, legacyHtmlEnabled: true },
      } as TStartupConfig);
    });
    await waitFor(() => expect(screen.getByText('false:true')).toBeInTheDocument());

    act(() => {
      queryClient.setQueryData<TStartupConfig>(['startup-policy'], {
        mcpApps: { enabled: true, legacyHtmlEnabled: true },
      } as TStartupConfig);
    });
    await waitFor(() => expect(screen.getByText('true:true')).toBeInTheDocument());

    act(() => {
      queryClient.setQueryData<TStartupConfig>(['startup-policy'], {
        mcpApps: { enabled: true, legacyHtmlEnabled: 'yes' },
      } as unknown as TStartupConfig);
    });
    await waitFor(() => expect(screen.getByText('false:false')).toBeInTheDocument());
  });

  it('denies executable UI when the startup query fails', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: console.log, warn: console.warn, error: jest.fn() },
    });

    function FailedPolicyProvider() {
      const { data, isSuccess, error } = useQuery<TStartupConfig>(
        ['failed-startup-policy'],
        () => Promise.reject(new Error('startup unavailable')),
        { retry: false },
      );
      return (
        <MCPAppsPolicyProvider startupConfig={data} ready={isSuccess && error == null}>
          <PolicyProbe />
        </MCPAppsPolicyProvider>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <FailedPolicyProvider />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(queryClient.getQueryState(['failed-startup-policy'])?.status).toBe('error'),
    );
    expect(screen.getByText('false:false')).toBeInTheDocument();
  });
});
