import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { Tools, EToolResources, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, EndpointFileConfig } from 'librechat-data-provider';
import useAttachItems from '../useAttachItems';

/**
 * Ports the destination-visibility cases from the deleted `AttachFileMenu`
 * spec, which is where this logic used to live. They cover the rule that
 * decides which upload destinations exist at all: the one that silently lost
 * both tool destinations when the palette stopped passing the ephemeral agent.
 */

jest.mock('~/hooks', () => ({
  useAgentToolPermissions: jest.fn(),
  useAgentCapabilities: jest.fn(),
  useGetAgentsConfig: jest.fn(),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

const mockHandleFileChange = jest.fn();
jest.mock('~/hooks/Files', () => ({
  useFileHandlingNoChatContext: () => ({ handleFileChange: mockHandleFileChange }),
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  __esModule: true,
  default: jest.fn(),
  useSharePointFileHandlingNoChatContext: () => ({
    handleSharePointFiles: jest.fn(),
    isProcessing: false,
    downloadProgress: undefined,
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
}));

const mockUseAgentToolPermissions = jest.requireMock('~/hooks').useAgentToolPermissions;
const mockUseAgentCapabilities = jest.requireMock('~/hooks').useAgentCapabilities;
const mockUseGetAgentsConfig = jest.requireMock('~/hooks').useGetAgentsConfig;
const mockUseGetStartupConfig = jest.requireMock('~/data-provider').useGetStartupConfig;

const SAVED_AGENT = 'agent_abc123';

interface Options {
  agentId?: string | null;
  endpoint?: string | null;
  endpointType?: EModelEndpoint | string;
  useResponsesApi?: boolean;
  isUnifiedMode?: boolean;
  endpointFileConfig?: EndpointFileConfig;
  provider?: string;
  tools?: string[];
  contextEnabled?: boolean;
  fileSearchEnabled?: boolean;
  codeEnabled?: boolean;
  sharePointEnabled?: boolean;
}

/** Row ids, which are what the palette keys and folds on. */
function renderEntries(options: Options = {}): string[] {
  const {
    agentId = null,
    endpoint = null,
    endpointType,
    useResponsesApi,
    isUnifiedMode = false,
    endpointFileConfig,
    provider,
    tools,
    contextEnabled = false,
    fileSearchEnabled = false,
    codeEnabled = false,
    sharePointEnabled = false,
  } = options;

  mockUseAgentToolPermissions.mockReturnValue({ tools, provider });
  mockUseAgentCapabilities.mockReturnValue({ contextEnabled, fileSearchEnabled, codeEnabled });
  mockUseGetAgentsConfig.mockReturnValue({ agentsConfig: { capabilities: [] } });
  mockUseGetStartupConfig.mockReturnValue({
    data: { sharePointFilePickerEnabled: sharePointEnabled },
  });

  const { result } = renderHook(
    () =>
      useAttachItems({
        agentId,
        endpoint,
        endpointType,
        useResponsesApi,
        endpointFileConfig,
        isUnifiedMode,
        conversationId: 'convo-1',
        conversation: { conversationId: 'convo-1' } as TConversation,
        files: new Map(),
        setFiles: jest.fn(),
        setFilesLoading: jest.fn(),
      }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) => <RecoilRoot>{children}</RecoilRoot>,
    },
  );

  return result.current.entries.map((entry) => entry.id);
}

const allCapabilities = { contextEnabled: true, fileSearchEnabled: true, codeEnabled: true };

/** The hook, not just its entry labels, so a destination can be chosen. */
function renderAttach(options: Options = {}) {
  mockUseAgentToolPermissions.mockReturnValue({ tools: options.tools, provider: options.provider });
  mockUseAgentCapabilities.mockReturnValue({
    contextEnabled: options.contextEnabled ?? true,
    fileSearchEnabled: options.fileSearchEnabled ?? true,
    codeEnabled: options.codeEnabled ?? true,
  });
  mockUseGetAgentsConfig.mockReturnValue({ agentsConfig: { capabilities: [] } });
  mockUseGetStartupConfig.mockReturnValue({ data: { sharePointFilePickerEnabled: false } });

  return renderHook(
    () =>
      useAttachItems({
        agentId: options.agentId ?? null,
        endpoint: options.endpoint ?? null,
        endpointType: options.endpointType,
        useResponsesApi: options.useResponsesApi,
        endpointFileConfig: options.endpointFileConfig,
        isUnifiedMode: options.isUnifiedMode,
        conversationId: 'convo-1',
        conversation: { conversationId: 'convo-1' } as TConversation,
        files: new Map(),
        setFiles: jest.fn(),
        setFilesLoading: jest.fn(),
      }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) => <RecoilRoot>{children}</RecoilRoot>,
    },
  );
}

/** Stands in for the picker: a real one cannot open in jsdom, and what matters
 *  is that the change event arrives while the chosen destination is still set. */
const pickFile = (input: HTMLInputElement, onFileChange: (e: never) => void) => {
  onFileChange({ target: input } as never);
};

describe('useAttachItems', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('provider upload versus image-only upload', () => {
    it('offers a provider upload for a custom endpoint type', () => {
      expect(renderEntries({ endpointType: 'custom' })).toContain('local:provider');
    });

    it.each([EModelEndpoint.openAI, EModelEndpoint.anthropic, EModelEndpoint.google])(
      'offers a provider upload for %s',
      (endpointType) => {
        expect(renderEntries({ endpointType })).toContain('local:provider');
      },
    );

    it('falls back to an image upload for the agents endpoint with no resolved provider', () => {
      const ids = renderEntries({ endpointType: EModelEndpoint.agents });
      expect(ids).toContain('local:image');
      expect(ids).not.toContain('local:provider');
    });

    it('resolves the provider through a saved agent, not the agents endpoint', () => {
      expect(
        renderEntries({
          agentId: SAVED_AGENT,
          endpointType: EModelEndpoint.agents,
          provider: EModelEndpoint.anthropic,
        }),
      ).toContain('local:provider');
    });

    it('offers a provider upload for azureOpenAI only with the responses API', () => {
      expect(
        renderEntries({ provider: EModelEndpoint.azureOpenAI, useResponsesApi: true }),
      ).toContain('local:provider');
      expect(
        renderEntries({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: true }),
      ).toContain('local:provider');
      expect(
        renderEntries({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: false }),
      ).toContain('local:image');
    });

    /* Assistants carry their own file configuration and the old menu handed
       them an unfiltered picker; scoping them to the image capability, which
       the provider check would, silently dropped PDF support. */
    it.each([EModelEndpoint.assistants, EModelEndpoint.azureAssistants])(
      'offers one unfiltered upload for %s and no tool destinations',
      (endpoint) => {
        const ids = renderEntries({
          endpoint,
          contextEnabled: true,
          fileSearchEnabled: true,
          codeEnabled: true,
        });
        expect(ids).toEqual(['local:assistants']);
      },
    );

    it('reads a provider whatever its casing, which OpenRouter arrives in', () => {
      expect(renderEntries({ provider: 'OpenRouter' })).toContain('local:provider');
    });
    it('offers local and SharePoint sources without destination choices in unified mode', () => {
      expect(
        renderEntries({
          isUnifiedMode: true,
          sharePointEnabled: true,
          contextEnabled: true,
          fileSearchEnabled: true,
          codeEnabled: true,
        }),
      ).toEqual(['local:unified', 'sharepoint:unified']);
    });
  });

  describe('destinations behind an agent capability', () => {
    it('offers text extraction when the context capability is on', () => {
      expect(renderEntries({ contextEnabled: true })).toContain('local:context');
      expect(renderEntries({ contextEnabled: false })).not.toContain('local:context');
    });

    it('offers a tool destination only when its capability is on', () => {
      const ids = renderEntries({ fileSearchEnabled: true });
      expect(ids).toContain('local:file_search');
      expect(ids).not.toContain('local:execute_code');
    });

    it('offers every destination when every capability is on', () => {
      expect(renderEntries(allCapabilities)).toEqual([
        'local:image',
        'local:context',
        'local:file_search',
        'local:execute_code',
      ]);
    });
  });

  describe('which agent is allowed the tool destinations', () => {
    /* The regression: an ordinary chat runs on an ephemeral agent, which has no
       tool list. Reading one anyway hid both destinations, leaving drag and
       drop as the only way to reach the code environment. */
    it('offers both tool destinations in an ordinary chat', () => {
      const ids = renderEntries({ ...allCapabilities, agentId: null, tools: undefined });
      expect(ids).toContain('local:file_search');
      expect(ids).toContain('local:execute_code');
    });

    it('offers both to an ephemeral agent, which carries no tool list', () => {
      const ids = renderEntries({
        ...allCapabilities,
        agentId: 'openAI__gpt-5___GPT-5',
        tools: undefined,
      });
      expect(ids).toContain('local:file_search');
      expect(ids).toContain('local:execute_code');
    });

    it('offers a saved agent only the destinations it was built with', () => {
      const ids = renderEntries({
        ...allCapabilities,
        agentId: SAVED_AGENT,
        tools: [Tools.file_search],
      });
      expect(ids).toContain('local:file_search');
      expect(ids).not.toContain('local:execute_code');
    });

    it('offers a saved agent with no tools neither destination', () => {
      const ids = renderEntries({ ...allCapabilities, agentId: SAVED_AGENT, tools: [] });
      expect(ids).not.toContain('local:file_search');
      expect(ids).not.toContain('local:execute_code');
      expect(ids).toContain('local:context');
    });
  });

  describe('SharePoint', () => {
    it('mirrors every local destination when it is enabled', () => {
      expect(renderEntries({ ...allCapabilities, sharePointEnabled: true })).toEqual([
        'local:image',
        'local:context',
        'local:file_search',
        'local:execute_code',
        'sharepoint:image',
        'sharepoint:context',
        'sharepoint:file_search',
        'sharepoint:execute_code',
      ]);
    });

    it('adds nothing when it is disabled', () => {
      expect(renderEntries({ ...allCapabilities, sharePointEnabled: false })).toHaveLength(4);
    });
  });

  describe('what the palette folds away', () => {
    /* The disclosure keeps one row out and hides the rest, so exactly one row
       may claim to be the ordinary destination. */
    it('marks the provider row as the only primary destination', () => {
      mockUseAgentToolPermissions.mockReturnValue({ tools: undefined, provider: undefined });
      mockUseAgentCapabilities.mockReturnValue(allCapabilities);
      mockUseGetAgentsConfig.mockReturnValue({ agentsConfig: { capabilities: [] } });
      mockUseGetStartupConfig.mockReturnValue({
        data: { sharePointFilePickerEnabled: true },
      });

      const { result } = renderHook(
        () =>
          useAttachItems({
            agentId: null,
            endpoint: EModelEndpoint.anthropic,
            endpointType: EModelEndpoint.anthropic,
            conversationId: 'convo-1',
            conversation: { conversationId: 'convo-1' } as TConversation,
            files: new Map(),
            setFiles: jest.fn(),
            setFilesLoading: jest.fn(),
          }),
        {
          wrapper: ({ children }: { children: React.ReactNode }) => (
            <RecoilRoot>{children}</RecoilRoot>
          ),
        },
      );

      const primary = result.current.entries.filter((entry) => entry.primary === true);
      expect(primary.map((entry) => entry.id)).toEqual(['local:provider']);
      /* Including the SharePoint copy of the provider row: it is a second way
         to reach a destination that is already out. */
      expect(
        result.current.entries.find((entry) => entry.id === 'sharepoint:provider')?.primary,
      ).toBe(false);
    });
  });

  describe('where the picked file is routed', () => {
    /* The destination is held in a ref precisely because the picker can fire
       its change event before React has committed any state, so losing it here
       lands a File Search upload as a plain provider attachment. */
    it('carries the chosen destination through the picker and then forgets it', () => {
      const { result } = renderAttach();
      const input = document.createElement('input');
      Object.defineProperty(result.current.inputRef, 'current', { value: input, writable: true });

      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:file_search')?.onSelect();
      });
      act(() => pickFile(input, result.current.onFileChange));
      expect(mockHandleFileChange).toHaveBeenLastCalledWith(
        expect.anything(),
        EToolResources.file_search,
      );

      /* And the next pick is a plain one unless a destination is chosen again. */
      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:provider')?.onSelect();
      });
      act(() => pickFile(input, result.current.onFileChange));
      expect(mockHandleFileChange).toHaveBeenLastCalledWith(expect.anything(), undefined);
    });

    /* A custom endpoint's own NAME is what identifies its provider; the
       resolved `endpointType` flattens every one of them to `custom`. Handing
       the palette the type in place of the name cost an OpenRouter endpoint the
       video and audio it takes. */
    it('reads the provider from a custom endpoint name, not its resolved type', () => {
      const acceptFor = (endpoint: string) => {
        const { result } = renderAttach({ endpoint, endpointType: EModelEndpoint.custom });
        const input = document.createElement('input');
        const accepts: string[] = [];
        input.click = () => accepts.push(input.accept);
        Object.defineProperty(result.current.inputRef, 'current', { value: input, writable: true });
        act(() => {
          result.current.entries.find((entry) => entry.id === 'local:provider')?.onSelect();
        });
        return accepts[0];
      };

      expect(acceptFor('OpenRouter')).toContain('video/');
      expect(acceptFor('OpenRouter')).toContain('audio/');
      /* The type on its own is a document-and-image provider and nothing more. */
      expect(acceptFor(EModelEndpoint.custom)).not.toContain('video/');
    });
    it('uses an explicit custom-endpoint media allowlist', () => {
      const { result } = renderAttach({
        endpoint: 'MyGateway',
        endpointType: EModelEndpoint.custom,
        endpointFileConfig: {
          supportedMimeTypes: [/^image\/.*$/, /^application\/pdf$/, /^video\/.*$/],
        },
      });
      const input = document.createElement('input');
      const accepts: string[] = [];
      input.click = () => accepts.push(input.accept);
      Object.defineProperty(result.current.inputRef, 'current', { value: input, writable: true });

      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:provider')?.onSelect();
      });

      expect(accepts[0]).toContain('video/*');
      expect(accepts[0]).not.toContain('audio/*');
    });

    it('scopes the picker to what the destination can send', () => {
      const { result } = renderAttach({ endpointType: EModelEndpoint.bedrock });
      const input = document.createElement('input');
      const accepts: string[] = [];
      input.click = () => accepts.push(input.accept);
      Object.defineProperty(result.current.inputRef, 'current', { value: input, writable: true });

      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:provider')?.onSelect();
      });
      expect(accepts[0]).toContain('image/');

      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:context')?.onSelect();
      });
      /* Text extraction takes anything the server can read, so it does not
         narrow the picker at all. */
      expect(accepts[1]).toBe('');
    });
  });

  describe('edge cases', () => {
    it.each([
      ['undefined endpoint and provider', { endpoint: undefined, provider: undefined }],
      ['null endpoint', { endpoint: null }],
      ['missing agent id', { agentId: undefined }],
      ['empty agent id', { agentId: '' }],
    ])('still resolves a destination with %s', (_label, options) => {
      expect(renderEntries(options as Options).length).toBeGreaterThan(0);
    });
  });
});
