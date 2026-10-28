import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import {
  Tools,
  Permissions,
  roleDefaults,
  PermissionTypes,
  EToolResources,
  EModelEndpoint,
} from 'librechat-data-provider';
import type { TConversation, EndpointFileConfig } from 'librechat-data-provider';
import type { TAuthContext } from '~/common';
import { AuthContext } from '~/hooks/AuthContext';
import { ephemeralAgentByConvoId } from '~/store';
import useAttachItems from '../useAttachItems';

/**
 * Ports the destination-visibility cases from the deleted `AttachFileMenu`
 * spec, which is where this logic used to live. They cover the rule that
 * decides which upload destinations exist at all: the one that silently lost
 * both tool destinations when the palette stopped passing the ephemeral agent.
 */

jest.mock('~/hooks', () => ({
  useHasAccess: jest.fn(jest.requireActual('~/hooks/Roles/useHasAccess').default),
  useAgentToolPermissions: jest.fn(),
  useAgentCapabilities: jest.fn(),
  useGetAgentsConfig: jest.fn(),
}));

jest.mock('~/hooks/AuthContext', () => {
  const { createContext } = jest.requireActual('react');
  return { AuthContext: createContext(undefined) };
});

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
  useSharePointFileHandlingNoChatContext: jest.fn(() => ({
    handleSharePointFiles: jest.fn().mockResolvedValue(undefined),
    isProcessing: false,
    downloadProgress: undefined,
  })),
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
  codeEnvironmentId?: string;
  statefulCodeSessionsAllowedByAgent?: boolean;
  authContext?: TAuthContext;
  initialFileSearch?: boolean;
}

function accessContext(canUseFileSearch?: boolean): TAuthContext {
  return {
    user: {
      id: 'user-1',
      username: 'reader',
      email: 'reader@example.com',
      name: 'Reader',
      avatar: '',
      role: 'reader',
      provider: 'local',
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
    roles:
      canUseFileSearch === undefined
        ? undefined
        : {
            reader: {
              ...roleDefaults.USER,
              name: 'reader',
              permissions: {
                ...roleDefaults.USER.permissions,
                [PermissionTypes.FILE_SEARCH]: { [Permissions.USE]: canUseFileSearch },
              },
            },
          },
    token: undefined,
    isAuthenticated: true,
    isAuthReady: true,
    error: undefined,
    login: jest.fn(),
    logout: jest.fn(),
    completeAuthentication: jest.fn(),
    setError: jest.fn(),
  };
}

const allowedAccess = accessContext(true);

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
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <AuthContext.Provider value={options.authContext ?? allowedAccess}>
          <RecoilRoot>{children}</RecoilRoot>
        </AuthContext.Provider>
      ),
    },
  );

  return result.current.entries.map((entry) => entry.id);
}

const allCapabilities = { contextEnabled: true, fileSearchEnabled: true, codeEnabled: true };

/** The hook, not just its entry labels, so a destination can be chosen. */
function renderAttach(options: Options = {}) {
  mockUseAgentToolPermissions.mockReturnValue({
    tools: options.tools,
    provider: options.provider,
    codeEnvironmentId: options.codeEnvironmentId,
    statefulCodeSessionsAllowedByAgent: options.statefulCodeSessionsAllowedByAgent,
  });
  mockUseAgentCapabilities.mockReturnValue({
    contextEnabled: options.contextEnabled ?? true,
    fileSearchEnabled: options.fileSearchEnabled ?? true,
    codeEnabled: options.codeEnabled ?? true,
  });
  mockUseGetAgentsConfig.mockReturnValue({ agentsConfig: { capabilities: [] } });
  mockUseGetStartupConfig.mockReturnValue({
    data: { sharePointFilePickerEnabled: options.sharePointEnabled ?? false },
  });

  return renderHook(
    () => {
      const attach = useAttachItems({
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
      });
      const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId('convo-1'));
      return { ...attach, ephemeralAgent };
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <AuthContext.Provider value={options.authContext ?? allowedAccess}>
          <RecoilRoot
            initializeState={({ set }) => {
              if (options.initialFileSearch) {
                set(ephemeralAgentByConvoId('convo-1'), { file_search: true });
              }
            }}
          >
            {children}
          </RecoilRoot>
        </AuthContext.Provider>
      ),
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
    it('keeps implicit upload first and restores only explicit File Search in unified mode', () => {
      expect(
        renderEntries({
          isUnifiedMode: true,
          sharePointEnabled: true,
          contextEnabled: true,
          fileSearchEnabled: true,
          codeEnabled: true,
        }),
      ).toEqual([
        'local:unified',
        'local:file_search',
        'sharepoint:unified',
        'sharepoint:file_search',
      ]);
    });
  });

  describe.each([false, true])('File Search role access (unified=%s)', (isUnifiedMode) => {
    it.each([null, SAVED_AGENT])(
      'fails closed while roles load and respects permission changes (agent=%s)',
      (agentId) => {
        const options: Options = {
          ...allCapabilities,
          isUnifiedMode,
          agentId,
          tools: [Tools.file_search, Tools.execute_code],
          sharePointEnabled: true,
          authContext: accessContext(),
        };
        const { result, rerender } = renderAttach(options);
        const ids = () => result.current.entries.map((entry) => entry.id);
        const fileSearchIds = ['local:file_search', 'sharepoint:file_search'];

        for (const id of fileSearchIds) {
          expect(ids()).not.toContain(id);
        }

        options.authContext = accessContext(true);
        rerender();
        expect(ids()).toEqual(expect.arrayContaining(fileSearchIds));

        options.authContext = accessContext(false);
        rerender();
        for (const id of fileSearchIds) {
          expect(ids()).not.toContain(id);
        }
        expect(ids()).toEqual(
          expect.arrayContaining([
            `local:${isUnifiedMode ? 'unified' : 'image'}`,
            `sharepoint:${isUnifiedMode ? 'unified' : 'image'}`,
          ]),
        );
        expect(ids().includes('local:execute_code')).toBe(!isUnifiedMode);
        expect(ids().includes('sharepoint:execute_code')).toBe(!isUnifiedMode);
      },
    );
  });

  describe.each([false, true])('cancelled File Search selection (preenabled=%s)', (enabled) => {
    it.each(['local', 'sharepoint'])('preserves the prior tool state for %s', (source) => {
      const { result } = renderAttach({
        isUnifiedMode: true,
        sharePointEnabled: true,
        initialFileSearch: enabled,
      });
      act(() => {
        result.current.entries.find((entry) => entry.id === `${source}:file_search`)?.onSelect();
      });
      if (source === 'sharepoint') {
        act(() => result.current.setIsSharePointDialogOpen(false));
      }
      expect(result.current.ephemeralAgent?.file_search ?? false).toBe(enabled);
      expect(mockHandleFileChange).not.toHaveBeenCalled();
    });
  });

  describe('unified destinations', () => {
    it('keeps both sources implicit when File Search is disabled, even with code enabled', () => {
      expect(
        renderEntries({ isUnifiedMode: true, sharePointEnabled: true, codeEnabled: true }),
      ).toEqual(['local:unified', 'sharepoint:unified']);
    });

    it('offers File Search only when a saved agent allows it', () => {
      expect(
        renderEntries({
          ...allCapabilities,
          isUnifiedMode: true,
          agentId: SAVED_AGENT,
          tools: [Tools.file_search],
        }),
      ).toEqual(['local:unified', 'local:file_search']);
    });

    it('does not offer explicit destinations for an agent with only code enabled', () => {
      expect(
        renderEntries({
          ...allCapabilities,
          isUnifiedMode: true,
          sharePointEnabled: true,
          agentId: SAVED_AGENT,
          tools: [Tools.execute_code],
        }),
      ).toEqual(['local:unified', 'sharepoint:unified']);
    });

    it('keeps both sources implicit for the selected stateful code environment', () => {
      const { result } = renderAttach({
        isUnifiedMode: true,
        sharePointEnabled: true,
        agentId: SAVED_AGENT,
        tools: [Tools.file_search, Tools.execute_code],
        codeEnvironmentId: 'stateful-only',
        statefulCodeSessionsAllowedByAgent: true,
      });
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        'local:unified',
        'local:file_search',
        'sharepoint:unified',
        'sharepoint:file_search',
      ]);
      const input = document.createElement('input');
      Object.defineProperty(result.current.inputRef, 'current', { value: input, writable: true });

      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:unified')?.onSelect();
      });
      act(() => pickFile(input, result.current.onFileChange));
      expect(mockHandleFileChange).toHaveBeenLastCalledWith(expect.anything(), undefined);

      act(() => {
        result.current.entries.find((entry) => entry.id === 'sharepoint:unified')?.onSelect();
      });
      const sharePoint = jest.requireMock('~/hooks/Files/useSharePointFileHandling');
      expect(result.current.isSharePointDialogOpen).toBe(true);
      expect(sharePoint.useSharePointFileHandlingNoChatContext).toHaveBeenLastCalledWith(
        { toolResource: undefined },
        expect.anything(),
      );
    });

    it.each([EModelEndpoint.assistants, EModelEndpoint.azureAssistants])(
      'keeps unified %s uploads on their existing source rows',
      (endpoint) => {
        expect(
          renderEntries({
            ...allCapabilities,
            isUnifiedMode: true,
            sharePointEnabled: true,
            endpoint,
          }),
        ).toEqual(['local:unified', 'sharepoint:unified']);
      },
    );

    it('labels and folds SharePoint tool destinations separately from local uploads', () => {
      const { result } = renderAttach({ isUnifiedMode: true, sharePointEnabled: true });
      expect(
        result.current.entries.filter((entry) => entry.primary).map((entry) => entry.id),
      ).toEqual(['local:unified', 'sharepoint:unified']);
      expect(
        result.current.entries.find((entry) => entry.id === 'sharepoint:file_search'),
      ).toMatchObject({ label: 'com_ui_upload_file_search (com_files_upload_sharepoint)' });
    });

    it('carries File Search through the picker without enabling it and resets the next upload', () => {
      const { result } = renderAttach({ isUnifiedMode: true });
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
      expect(result.current.ephemeralAgent?.[EToolResources.file_search]).not.toBe(true);

      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:unified')?.onSelect();
      });
      act(() => pickFile(input, result.current.onFileChange));
      expect(mockHandleFileChange).toHaveBeenLastCalledWith(expect.anything(), undefined);
    });

    it('passes a SharePoint File Search choice to its upload handler', () => {
      const { result } = renderAttach({ isUnifiedMode: true, sharePointEnabled: true });
      const sharePoint = jest.requireMock('~/hooks/Files/useSharePointFileHandling');
      act(() => {
        result.current.entries.find((entry) => entry.id === 'sharepoint:file_search')?.onSelect();
      });
      expect(result.current.isSharePointDialogOpen).toBe(true);
      expect(sharePoint.useSharePointFileHandlingNoChatContext).toHaveBeenLastCalledWith(
        { toolResource: EToolResources.file_search },
        expect.anything(),
      );
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

  describe('legacy code destinations', () => {
    it('keeps explicit local and SharePoint code uploads in nonunified mode', () => {
      const { result } = renderAttach({ isUnifiedMode: false, sharePointEnabled: true });
      expect(result.current.entries.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(['local:execute_code', 'sharepoint:execute_code']),
      );
      const input = document.createElement('input');
      Object.defineProperty(result.current.inputRef, 'current', { value: input, writable: true });

      act(() => {
        result.current.entries.find((entry) => entry.id === 'local:execute_code')?.onSelect();
      });
      act(() => pickFile(input, result.current.onFileChange));
      expect(mockHandleFileChange).toHaveBeenLastCalledWith(
        expect.anything(),
        EToolResources.execute_code,
      );

      act(() => {
        result.current.entries.find((entry) => entry.id === 'sharepoint:execute_code')?.onSelect();
      });
      const sharePoint = jest.requireMock('~/hooks/Files/useSharePointFileHandling');
      expect(sharePoint.useSharePointFileHandlingNoChatContext).toHaveBeenLastCalledWith(
        { toolResource: EToolResources.execute_code },
        expect.anything(),
      );
    });

    it.each([
      { codeEnabled: false, tools: [Tools.execute_code] },
      { codeEnabled: true, tools: [Tools.file_search] },
    ])('keeps legacy code capability and agent gates (%j)', (options) => {
      const ids = renderEntries({
        ...options,
        isUnifiedMode: false,
        sharePointEnabled: true,
        agentId: SAVED_AGENT,
      });
      expect(ids).not.toContain('local:execute_code');
      expect(ids).not.toContain('sharepoint:execute_code');
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
            <AuthContext.Provider value={allowedAccess}>
              <RecoilRoot>{children}</RecoilRoot>
            </AuthContext.Provider>
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
