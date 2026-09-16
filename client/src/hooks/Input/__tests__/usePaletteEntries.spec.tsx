import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { ArtifactModes, PermissionTypes } from 'librechat-data-provider';
import usePaletteEntries from '../usePaletteEntries';
import store from '~/store';

/**
 * What the palette is offered, before it decides how to draw it. Every row here
 * is gated twice (by a permission and by an agent capability) and a row that
 * appears without both is a tool the user cannot actually use.
 */

let mockPermissions: Record<string, boolean>;
let mockMemoryAccess: boolean;
let mockCapabilities: Record<string, boolean>;
let mockContext: Record<string, unknown> | null;
let mockSkills: Array<Record<string, unknown>>;
let mockAgentsMap: Record<string, Record<string, unknown>>;
let mockSkillsActive: boolean;
let mockUser: { personalization?: { memories?: boolean } } | undefined;
let mockSkillsQuery: Record<string, unknown>;

jest.mock('~/hooks', () => ({
  useHasAccess: ({ permissionType }: { permissionType: string }) =>
    mockPermissions[permissionType] ?? false,
  useHasMemoryAccess: () => mockMemoryAccess,
  useAuthContext: () => ({ user: mockUser }),
  useAgentCapabilities: () => mockCapabilities,
  /* The real popover filter is used here, and it drops anything the user
     cannot invoke or that is not active for them. */
  useSkillActiveState: () => ({ isActive: () => mockSkillsActive }),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => mockContext,
  useAgentsMapContext: () => mockAgentsMap,
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: () => mockSkillsQuery,
}));

const toggle = (state: unknown, isPinned = false): ToggleFixture => ({
  toggleState: state,
  isPinned,
  debouncedChange: jest.fn(),
  setIsPinned: jest.fn(),
});

interface ServerFixture {
  serverName: string;
  config?: { title?: string; description?: string; iconPath?: string };
}

interface ToggleFixture {
  toggleState: unknown;
  isPinned: boolean;
  debouncedChange: jest.Mock;
  setIsPinned: jest.Mock;
}

interface ContextFixture {
  webSearch: ToggleFixture;
  codeInterpreter: ToggleFixture;
  artifacts: ToggleFixture;
  mcpServerManager: {
    selectableServers?: ServerFixture[];
    mcpValues: string[];
    toggleServerSelection: jest.Mock;
    connectionStatus?: Record<string, { connectionState: string }>;
    initializeServer?: jest.Mock;
    getServerStatusIconProps?: jest.Mock;
  };
  [key: string]: unknown;
}

const fullContext = (): ContextFixture => ({
  webSearch: toggle(false),
  codeInterpreter: toggle(false),
  fileSearch: toggle(false),
  skills: toggle(false),
  memory: toggle(false),
  artifacts: toggle(''),
  mcpServerManager: {
    selectableServers: [
      { serverName: 'github', config: { title: 'Github', description: 'Repos' } },
      { serverName: 'spotify', config: {} },
    ],
    mcpValues: [],
    toggleServerSelection: jest.fn(),
  },
  agentsConfig: { capabilities: [] },
});

const allPermissions = {
  [PermissionTypes.WEB_SEARCH]: true,
  [PermissionTypes.RUN_CODE]: true,
  [PermissionTypes.FILE_SEARCH]: true,
  [PermissionTypes.MCP_SERVERS]: true,
  [PermissionTypes.SKILLS]: true,
};

const allCapabilities = {
  codeEnabled: true,
  memoryEnabled: true,
  webSearchEnabled: true,
  artifactsEnabled: true,
  fileSearchEnabled: true,
  skillsEnabled: true,
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

const entries = (agentId?: string | null) =>
  renderHook(() => usePaletteEntries({ conversationId: 'convo-1', agentId }), { wrapper });

const keysOf = (result: { current: Array<{ key: string }> }) =>
  result.current.map((item) => item.key);

describe('usePaletteEntries', () => {
  beforeEach(() => {
    mockPermissions = { ...allPermissions };
    mockMemoryAccess = true;
    mockUser = { personalization: { memories: true } };
    mockCapabilities = { ...allCapabilities };
    mockContext = fullContext();
    mockSkills = [];
    mockAgentsMap = {};
    mockSkillsActive = true;
    mockSkillsQuery = {
      get data() {
        return { pages: [{ skills: mockSkills }] };
      },
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
      refetch: jest.fn(),
    };
  });

  it('retries a failed catalog walk when the palette opens again', () => {
    const refetch = jest.fn();
    mockSkillsQuery = {
      data: undefined,
      isError: true,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
      refetch,
    };
    const { rerender } = renderHook(
      ({ revision }) =>
        usePaletteEntries({
          conversationId: 'convo-1',
          catalogEnabled: true,
          catalogOpenRevision: revision,
        }),
      { wrapper, initialProps: { revision: 1 } },
    );

    expect(refetch).not.toHaveBeenCalled();
    rerender({ revision: 2 });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('offers nothing before the badge row has a context to read', () => {
    mockContext = null;
    expect(keysOf(entries().result)).toEqual([]);
  });

  it('lists the built-in tools in a fixed order, servers last', () => {
    expect(keysOf(entries().result)).toEqual([
      'builtin:web_search',
      'builtin:execute_code',
      'builtin:file_search',
      'builtin:skills',
      'builtin:memory',
      'builtin:artifacts',
      'mcp:github',
      'mcp:spotify',
    ]);
  });

  it('exposes an inactive built-in tool that is pinned to the prompt bar', () => {
    const codeInterpreter = toggle(false, true);
    mockContext = { ...fullContext(), codeInterpreter };

    const row = entries().result.current.find((item) => item.key === 'builtin:execute_code');
    expect(row).toEqual(expect.objectContaining({ active: false, pinned: true }));
    act(() => row?.onUnpin?.());
    expect(codeInterpreter.setIsPinned).toHaveBeenCalledWith(false);
  });

  describe('the two gates on every tool', () => {
    it.each([
      [PermissionTypes.WEB_SEARCH, 'builtin:web_search'],
      [PermissionTypes.RUN_CODE, 'builtin:execute_code'],
      [PermissionTypes.FILE_SEARCH, 'builtin:file_search'],
      [PermissionTypes.SKILLS, 'builtin:skills'],
      [PermissionTypes.MCP_SERVERS, 'mcp:github'],
    ])('withholds %s without the permission', (permission, key) => {
      mockPermissions = { ...allPermissions, [permission]: false };
      expect(keysOf(entries().result)).not.toContain(key);
    });

    it.each([
      ['webSearchEnabled', 'builtin:web_search'],
      ['codeEnabled', 'builtin:execute_code'],
      ['fileSearchEnabled', 'builtin:file_search'],
      ['skillsEnabled', 'builtin:skills'],
      ['memoryEnabled', 'builtin:memory'],
      ['artifactsEnabled', 'builtin:artifacts'],
    ])('withholds %s without the capability', (capability, key) => {
      mockCapabilities = { ...allCapabilities, [capability]: false };
      expect(keysOf(entries().result)).not.toContain(key);
    });

    it('withholds memory without access, whatever the capability says', () => {
      mockMemoryAccess = false;
      expect(keysOf(entries().result)).not.toContain('builtin:memory');
    });

    it('withholds memory from a user who opted out in personalization', () => {
      mockUser = { personalization: { memories: false } };
      expect(keysOf(entries().result)).not.toContain('builtin:memory');
    });
  });

  describe('on state', () => {
    it('reads each tool from its own toggle', () => {
      mockContext = { ...fullContext(), webSearch: toggle(true) };
      const listed = entries().result.current;
      expect(listed.find((item) => item.key === 'builtin:web_search')?.active).toBe(true);
      expect(listed.find((item) => item.key === 'builtin:execute_code')?.active).toBe(false);
    });

    it('marks a server on when it is among the selected values', () => {
      const context = fullContext();
      context.mcpServerManager.mcpValues = ['spotify'];
      mockContext = context;
      const listed = entries().result.current;
      expect(listed.find((item) => item.key === 'mcp:spotify')?.active).toBe(true);
      expect(listed.find((item) => item.key === 'mcp:github')?.active).toBe(false);
    });
  });

  describe('choosing a row', () => {
    it('flips each tool through its own toggle', () => {
      const context = fullContext();
      mockContext = context;
      const listed = entries().result.current;
      act(() => listed.find((item) => item.key === 'builtin:web_search')?.onSelect());
      expect(context.webSearch.debouncedChange).toHaveBeenCalledWith({ value: true });
      expect(context.codeInterpreter.debouncedChange).not.toHaveBeenCalled();
    });

    it('turns a tool back off from its on state', () => {
      const context = { ...fullContext(), webSearch: toggle(true) };
      mockContext = context;
      const listed = entries().result.current;
      act(() => listed.find((item) => item.key === 'builtin:web_search')?.onSelect());
      expect(context.webSearch.debouncedChange).toHaveBeenCalledWith({ value: false });
    });

    it('returns a mode pill to the default when it is already the stored mode', () => {
      const context = { ...fullContext(), artifacts: toggle(ArtifactModes.SHADCNUI) };
      mockContext = context;
      const modes = entries().result.current.find(
        (item) => item.key === 'builtin:artifacts',
      )?.modes;
      act(() => modes?.find((mode) => mode.id === 'shadcn')?.onSelect());
      expect(context.artifacts.debouncedChange).toHaveBeenCalledWith({
        value: ArtifactModes.DEFAULT,
      });
    });
  });

  describe('artifacts, which carries its modes on the row', () => {
    const artifactsRow = () =>
      entries().result.current.find((item) => item.key === 'builtin:artifacts');

    it('offers no modes while it is off', () => {
      mockContext = { ...fullContext(), artifacts: toggle('') };
      const row = artifactsRow();
      expect(row?.active).toBe(false);
      expect(row?.modes).toBeUndefined();
    });

    it('offers three modes once it is on', () => {
      mockContext = { ...fullContext(), artifacts: toggle(ArtifactModes.DEFAULT) };
      const row = artifactsRow();
      expect(row?.active).toBe(true);
      expect(row?.modes?.map((mode) => mode.id)).toEqual(['default', 'shadcn', 'custom']);
      expect(row?.modes?.find((mode) => mode.id === 'default')?.active).toBe(true);
    });

    it('marks the stored mode, and only it', () => {
      mockContext = { ...fullContext(), artifacts: toggle(ArtifactModes.SHADCNUI) };
      const modes = artifactsRow()?.modes;
      expect(modes?.find((mode) => mode.id === 'shadcn')?.active).toBe(true);
      expect(modes?.find((mode) => mode.id === 'default')?.active).toBe(false);
    });

    /* The toggle has historically also held a bare `true`, which names no mode
       and would otherwise leave every one of them unchecked. */
    it('reads a bare true as the default mode', () => {
      mockContext = { ...fullContext(), artifacts: toggle(true) };
      const row = artifactsRow();
      expect(row?.active).toBe(true);
      expect(row?.modes?.find((mode) => mode.id === 'default')?.active).toBe(true);
    });
  });

  describe('skills', () => {
    beforeEach(() => {
      mockSkills = [
        { _id: 's1', name: 'writer', displayTitle: 'Writing Helper', description: 'Drafts' },
        { _id: 's2', name: 'writer', displayTitle: 'Writing Helper (copy)' },
        { _id: 's3', name: 'researcher' },
      ];
    });

    /* Manual skills are primed by name server-side, so records sharing a name
       are one selectable thing however many the catalog holds. */
    it('lists one row per name, not per record', () => {
      expect(keysOf(entries().result).filter((key) => key.startsWith('skill:'))).toEqual([
        'skill:s1',
        'skill:s3',
      ]);
    });

    it('falls back to the name when a skill has no title', () => {
      const listed = entries().result.current;
      expect(listed.find((item) => item.key === 'skill:s3')?.label).toBe('researcher');
      expect(listed.find((item) => item.key === 'skill:s1')?.label).toBe('Writing Helper');
    });

    it('marks a skill on once it is staged', () => {
      const { result } = renderHook(
        () => usePaletteEntries({ conversationId: 'convo-1', agentId: null }),
        {
          wrapper: ({ children }: { children: React.ReactNode }) => (
            <RecoilRoot
              initializeState={({ set }) =>
                set(store.pendingManualSkillsByConvoId('convo-1'), ['writer'])
              }
            >
              {children}
            </RecoilRoot>
          ),
        },
      );
      expect(result.current.find((item) => item.key === 'skill:s1')?.active).toBe(true);
      expect(result.current.find((item) => item.key === 'skill:s3')?.active).toBe(false);
    });

    it('stages and unstages a skill through the same row', () => {
      const { result } = entries(null);
      const row = () => result.current.find((item) => item.key === 'skill:s1');

      act(() => row()?.onSelect());
      expect(row()?.active).toBe(true);

      act(() => row()?.onSelect());
      expect(row()?.active).toBe(false);
    });

    it('lists none of them when skills are not listable', () => {
      mockCapabilities = { ...allCapabilities, skillsEnabled: false };
      expect(keysOf(entries().result).filter((key) => key.startsWith('skill:'))).toEqual([]);
    });

    it('marks a staged placeholder as non-favoritable before its record loads', () => {
      mockSkills = [];
      const { result } = renderHook(
        () => usePaletteEntries({ conversationId: 'convo-1', agentId: null }),
        {
          wrapper: ({ children }: { children: React.ReactNode }) => (
            <RecoilRoot
              initializeState={({ set }) =>
                set(store.pendingManualSkillsByConvoId('convo-1'), ['writer'])
              }
            >
              {children}
            </RecoilRoot>
          ),
        },
      );

      expect(result.current.find((item) => item.key === 'skill:staged:writer')).toEqual(
        expect.objectContaining({ favoritable: false }),
      );
    });
  });

  /* A third gate, and the one that fails closed: a persisted agent sees only
     the skills it was built with, and none at all until the map has loaded. */
  describe('which skills an agent may see', () => {
    beforeEach(() => {
      mockSkills = [
        { _id: 's1', name: 'writer', displayTitle: 'Writing Helper' },
        { _id: 's2', name: 'researcher', displayTitle: 'Researcher' },
      ];
    });

    const skillKeys = (agentId?: string | null) =>
      keysOf(entries(agentId).result).filter((key) => key.startsWith('skill:'));

    it('lists the whole catalog for an ephemeral agent', () => {
      expect(skillKeys('openAI__gpt-5___GPT-5')).toEqual(['skill:s1', 'skill:s2']);
    });

    it('lists nothing for a persisted agent that has skills switched off', () => {
      mockAgentsMap = { agent_1: { skills_enabled: false } };
      expect(skillKeys('agent_1')).toEqual([]);
    });

    it('lists nothing while the agents map is still loading', () => {
      mockAgentsMap = {};
      expect(skillKeys('agent_1')).toEqual([]);
    });

    it('lists only the skills a persisted agent was built with', () => {
      mockAgentsMap = { agent_1: { skills_enabled: true, skills: ['s2'] } };
      expect(skillKeys('agent_1')).toEqual(['skill:s2']);
    });

    it('lists agent skills even when endpoint tools are hidden', () => {
      mockAgentsMap = { agent_1: { skills_enabled: true, skills: ['s2'] } };
      const { result } = renderHook(
        () =>
          usePaletteEntries({
            conversationId: 'convo-1',
            agentId: 'agent_1',
            enabled: true,
            toolsEnabled: false,
          }),
        { wrapper },
      );

      expect(keysOf(result)).toEqual(['skill:s2']);
    });
  });

  describe('servers', () => {
    it('titles a server by its config, falling back to its name', () => {
      const listed = entries().result.current;
      expect(listed.find((item) => item.key === 'mcp:github')?.label).toBe('Github');
      expect(listed.find((item) => item.key === 'mcp:spotify')?.label).toBe('spotify');
    });

    it('toggles a server by its own name, not by its title', () => {
      const context = fullContext();
      /* Already connected, so the row goes straight to the toggle rather than
         through the initialize/configure branch an unknown status now takes. */
      context.mcpServerManager.connectionStatus = { github: { connectionState: 'connected' } };
      mockContext = context;
      const row = entries().result.current.find((item) => item.key === 'mcp:github');
      act(() => row?.onSelect());
      expect(context.mcpServerManager.toggleServerSelection).toHaveBeenCalledWith('github');
    });

    it('initializes rather than toggles a server whose connection status is still unknown', () => {
      const context = fullContext();
      context.mcpServerManager.initializeServer = jest.fn();
      mockContext = context;
      const row = entries().result.current.find((item) => item.key === 'mcp:github');
      act(() => row?.onSelect());
      expect(context.mcpServerManager.initializeServer).toHaveBeenCalledWith('github');
      expect(context.mcpServerManager.toggleServerSelection).not.toHaveBeenCalled();
    });

    it('offers cancellation while an OAuth initialization is cancellable', () => {
      const context = fullContext();
      const onCancel = jest.fn();
      context.mcpServerManager.getServerStatusIconProps = jest.fn(() => ({
        isInitializing: true,
        canCancel: true,
        onCancel,
      }));
      mockContext = context;
      const cancel = entries()
        .result.current.find((item) => item.key === 'mcp:github')
        ?.modes?.find((mode) => mode.id === 'cancel');

      act(() => cancel?.onSelect());

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('lists none while the manager has no selectable servers', () => {
      const context = fullContext();
      context.mcpServerManager = { ...context.mcpServerManager, selectableServers: undefined };
      mockContext = context;
      expect(keysOf(entries().result).filter((key) => key.startsWith('mcp:'))).toEqual([]);
    });
  });
});
