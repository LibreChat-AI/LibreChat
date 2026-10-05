import type { AttachedCodeEnvironmentPolicySettings } from './byom';
import {
  assertAttachedCodeEnvironmentApprovalSupported,
  buildAttachedCodeEnvironmentAdmissionHooks,
  collectAttachedCodeEnvironmentAgentIds,
  collectAttachedCodeEnvironmentPolicySettings,
  createAttachedCodeEnvironmentPolicyHook,
  isStatefulCodeEnvironmentToolName,
  markNativeCodeToolApprovalRequests,
  resolveAttachedCodeApprovalMode,
  resolvePersistedCodeApprovalMode,
} from './byom';
import { canAgentGraphPause } from './admission';

const signal = new AbortController().signal;

const fullAccessSettings: AttachedCodeEnvironmentPolicySettings = {
  configSchema: {
    permissions: {
      fileWrite: { allowed: ['allow', 'ask', 'deny'], default: 'ask' },
      commandExecution: { allowed: ['allow', 'ask', 'deny'], default: 'ask' },
    },
  },
};

describe('full access', () => {
  test('allows native writes and commands while preserving mandatory skill review', async () => {
    const settings = new Map([['attached-agent', fullAccessSettings]]);
    const mode = resolveAttachedCodeApprovalMode('fullAccess', settings);
    const hook = createAttachedCodeEnvironmentPolicyHook(new Set(settings.keys()), settings, mode);
    for (const toolName of ['create_file', 'edit_file', 'bash_tool', 'execute_code']) {
      await expect(
        hook(
          {
            toolName,
            executingAgentId: 'attached-agent',
            toolInput: { path: 'output.txt' },
          } as never,
          signal,
        ),
      ).resolves.toEqual({ decision: 'allow' });
    }
    await expect(
      hook(
        {
          toolName: 'create_file',
          executingAgentId: 'attached-agent',
          toolInput: { path: 'skills/reviewer/SKILL.md' },
        } as never,
        signal,
      ),
    ).resolves.toMatchObject({ decision: 'ask' });
    await expect(hook({ toolName: 'bash_tool' } as never, signal)).resolves.toMatchObject({
      decision: 'deny',
    });
    await expect(
      hook({ toolName: 'mcp_example', executingAgentId: 'attached-agent' } as never, signal),
    ).resolves.toEqual({});
  });

  test.each([false, true])(
    'rejects restrictive siblings regardless of traversal order: %s',
    (reverse) => {
      const entries: Array<[string, AttachedCodeEnvironmentPolicySettings]> = [
        ['permissive', fullAccessSettings],
        [
          'restricted',
          { configSchema: { permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } } } },
        ],
      ];
      expect(() =>
        resolveAttachedCodeApprovalMode(
          'fullAccess',
          new Map(reverse ? entries.reverse() : entries),
        ),
      ).toThrow('not permitted');
    },
  );

  test('rechecks changed and newly discovered machine restrictions before execution', async () => {
    const settings = new Map([['attached-agent', fullAccessSettings]]);
    const attachedIds = new Set(settings.keys());
    const hook = createAttachedCodeEnvironmentPolicyHook(
      attachedIds,
      settings,
      resolveAttachedCodeApprovalMode('fullAccess', settings),
    );
    settings.set('attached-agent', {
      ...fullAccessSettings,
      settings: { permissions: { commandExecution: 'deny' } },
    });
    await expect(
      hook({ toolName: 'bash_tool', executingAgentId: 'attached-agent' } as never, signal),
    ).resolves.toMatchObject({ decision: 'deny' });
    attachedIds.add('lazy-agent');
    settings.set('lazy-agent', {});
    await expect(
      hook({ toolName: 'bash_tool', executingAgentId: 'lazy-agent' } as never, signal),
    ).resolves.toMatchObject({ decision: 'ask' });
    expect(() => resolveAttachedCodeApprovalMode('fullAccess', settings, false)).toThrow(
      'not permitted',
    );
  });
});

test('identifies every built-in tool that can touch a stateful code target', () => {
  for (const toolName of [
    'read_file',
    'write_file',
    'edit_file',
    'create_file',
    'bash_tool',
    'execute_code',
    'search_workspace',
    'list_workspace_files',
  ]) {
    expect(isStatefulCodeEnvironmentToolName(toolName)).toBe(true);
  }
  expect(isStatefulCodeEnvironmentToolName('mcp__github__create_issue')).toBe(false);
});

describe('markNativeCodeToolApprovalRequests', () => {
  const payload = {
    type: 'tool_approval' as const,
    action_requests: [
      { name: 'create_file', arguments: { path: 'one.ts' }, tool_call_id: 'call-1' },
    ],
    review_configs: [
      {
        action_name: 'create_file',
        tool_call_id: 'call-1',
        allowed_decisions: ['approve' as const],
      },
    ],
  };

  test('marks a server-registered native code tool', () => {
    expect(
      markNativeCodeToolApprovalRequests(payload, [
        { toolDefinitions: [{ name: 'create_file', toolType: 'builtin' }] },
      ]).action_requests[0],
    ).toMatchObject({ source: 'librechat_code' });
  });

  test('keeps a same-name user tool generic and strips a forged source', () => {
    const forged = {
      ...payload,
      action_requests: [{ ...payload.action_requests[0], source: 'librechat_code' as const }],
    };
    expect(
      markNativeCodeToolApprovalRequests(forged, [
        { toolDefinitions: [{ name: 'create_file', toolType: 'action' }] },
      ]).action_requests[0],
    ).not.toHaveProperty('source');
  });

  test('falls back to generic when reachable agents expose conflicting definitions', () => {
    expect(
      markNativeCodeToolApprovalRequests(payload, [
        { toolDefinitions: [{ name: 'create_file', toolType: 'builtin' }] },
        { toolRegistry: new Map([['create_file', { name: 'create_file', toolType: 'mcp' }]]) },
      ]).action_requests[0],
    ).not.toHaveProperty('source');
  });
});

describe('createAttachedCodeEnvironmentPolicyHook', () => {
  test.each(['bash_tool', 'run_tools_with_bash'])(
    'asks before a shell action in an attached environment: %s',
    async (toolName) => {
      const hook = createAttachedCodeEnvironmentPolicyHook(new Set(['attached-agent']));

      await expect(
        hook({ toolName, executingAgentId: 'attached-agent' } as never, signal),
      ).resolves.toEqual({
        decision: 'ask',
        reason: `${toolName} can modify your attached code environment`,
      });
    },
  );

  test('allows the baseline policy to auto-approve read-only coding actions', async () => {
    const hook = createAttachedCodeEnvironmentPolicyHook(new Set(['attached-agent']));

    await expect(
      hook({ toolName: 'read_file', executingAgentId: 'attached-agent' } as never, signal),
    ).resolves.toEqual({});
  });

  test('does not apply the BYOM baseline to a managed-environment sibling agent', async () => {
    const hook = createAttachedCodeEnvironmentPolicyHook(new Set(['attached-agent']));

    await expect(
      hook({ toolName: 'bash_tool', executingAgentId: 'managed-agent' } as never, signal),
    ).resolves.toEqual({});
  });

  test('fails closed when a risky call cannot be attributed to an agent', async () => {
    const hook = createAttachedCodeEnvironmentPolicyHook(new Set(['attached-agent']));

    await expect(hook({ toolName: 'write_file' } as never, signal)).resolves.toMatchObject({
      decision: 'deny',
    });
  });

  test.each(['create_file', 'edit_file'])(
    'asks before the canonical host file action %s',
    async (toolName) => {
      const hook = createAttachedCodeEnvironmentPolicyHook(new Set(['attached-agent']));

      await expect(
        hook({ toolName, executingAgentId: 'attached-agent' } as never, signal),
      ).resolves.toMatchObject({ decision: 'ask' });
    },
  );
  test('applies admin-exposed environment settings by permission category', async () => {
    const hook = createAttachedCodeEnvironmentPolicyHook(
      new Set(['attached-agent']),
      new Map([
        [
          'attached-agent',
          {
            configSchema: {
              permissions: {
                fileWrite: { allowed: ['allow', 'ask', 'deny'], default: 'ask' },
                commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
              },
            },
            settings: {
              permissions: { fileWrite: 'allow' as const, commandExecution: 'deny' as const },
            },
          },
        ],
      ]),
    );

    await expect(
      hook({ toolName: 'write_file', executingAgentId: 'attached-agent' } as never, signal),
    ).resolves.toEqual({ decision: 'allow' });
    await expect(
      hook({ toolName: 'bash_tool', executingAgentId: 'attached-agent' } as never, signal),
    ).resolves.toMatchObject({ decision: 'deny' });
  });

  test('accept edits allows workspace writes but continues asking for commands', async () => {
    const settings = new Map<string, AttachedCodeEnvironmentPolicySettings>([
      [
        'attached-agent',
        {
          configSchema: {
            permissions: {
              fileWrite: { allowed: ['allow', 'ask'], default: 'ask' },
              commandExecution: { allowed: ['allow', 'ask'], default: 'ask' },
            },
          },
        },
      ],
    ]);
    const mode = resolveAttachedCodeApprovalMode('acceptEdits', settings);
    const hook = createAttachedCodeEnvironmentPolicyHook(
      new Set(['attached-agent']),
      settings,
      mode,
    );

    await expect(
      hook({ toolName: 'write_file', executingAgentId: 'attached-agent' } as never, signal),
    ).resolves.toEqual({ decision: 'allow' });
    await expect(
      hook({ toolName: 'bash_tool', executingAgentId: 'attached-agent' } as never, signal),
    ).resolves.toMatchObject({ decision: 'ask' });
  });

  test('rejects accept edits when the attached machine excludes file-write allow', () => {
    expect(() =>
      resolveAttachedCodeApprovalMode(
        'acceptEdits',
        new Map([
          [
            'attached-agent',
            {
              configSchema: {
                permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } },
              },
            },
          ],
        ]),
      ),
    ).toThrow('not permitted');
  });

  test('keeps a restrictive sibling asking without disabling accept edits elsewhere', async () => {
    const settings = new Map<string, AttachedCodeEnvironmentPolicySettings>([
      [
        'permissive-agent',
        {
          configSchema: {
            permissions: { fileWrite: { allowed: ['allow', 'ask'], default: 'ask' } },
          },
        },
      ],
      [
        'restrictive-agent',
        {
          configSchema: {
            permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } },
          },
        },
      ],
    ]);
    const mode = resolveAttachedCodeApprovalMode('acceptEdits', settings);
    const hook = createAttachedCodeEnvironmentPolicyHook(
      new Set(['permissive-agent', 'restrictive-agent']),
      settings,
      mode,
    );

    await expect(
      hook({ toolName: 'write_file', executingAgentId: 'permissive-agent' } as never, signal),
    ).resolves.toEqual({ decision: 'allow' });
    await expect(
      hook({ toolName: 'write_file', executingAgentId: 'restrictive-agent' } as never, signal),
    ).resolves.toMatchObject({ decision: 'ask' });
  });

  test('applies a restrictive policy discovered after lazy agent resolution', async () => {
    const attachedIds = new Set<string>(['eager-agent']);
    const settings = new Map<string, AttachedCodeEnvironmentPolicySettings>([
      [
        'eager-agent',
        {
          configSchema: {
            permissions: { fileWrite: { allowed: ['allow', 'ask'], default: 'ask' } },
          },
        },
      ],
    ]);
    const mode = resolveAttachedCodeApprovalMode('acceptEdits', settings);
    const hook = createAttachedCodeEnvironmentPolicyHook(attachedIds, settings, mode);

    attachedIds.add('lazy-agent');
    settings.set('lazy-agent', {
      configSchema: {
        permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } },
      },
    });

    await expect(
      hook({ toolName: 'write_file', executingAgentId: 'lazy-agent' } as never, signal),
    ).resolves.toMatchObject({ decision: 'ask' });
  });

  test('rejects an explicit mode when approvals are disabled by the administrator', () => {
    expect(resolveAttachedCodeApprovalMode('ask', new Map(), false)).toBeUndefined();
    expect(() => resolveAttachedCodeApprovalMode('acceptEdits', new Map(), false)).toThrow(
      'not permitted',
    );
    expect(resolveAttachedCodeApprovalMode(undefined, new Map(), false)).toBeUndefined();
  });

  test.each(['create_file', 'edit_file'])(
    'keeps persistent skill write %s approval-gated when BYOM file writes are allowed',
    async (toolName) => {
      const hook = createAttachedCodeEnvironmentPolicyHook(
        new Set(['attached-agent']),
        new Map([
          [
            'attached-agent',
            {
              configSchema: {
                permissions: {
                  fileWrite: { allowed: ['allow', 'ask'], default: 'ask' },
                },
              },
              settings: { permissions: { fileWrite: 'allow' as const } },
              skillAuthoringAvailable: true,
            },
          ],
        ]),
      );

      await expect(
        hook(
          {
            toolName,
            toolInput: { path: 'skills/reviewer/SKILL.md' },
            executingAgentId: 'attached-agent',
          } as never,
          signal,
        ),
      ).resolves.toEqual({
        decision: 'ask',
        reason: `${toolName} can modify a persistent LibreChat skill`,
      });
      await expect(
        hook(
          {
            toolName,
            toolInput: { path: '/mnt/data/output.txt' },
            executingAgentId: 'attached-agent',
          } as never,
          signal,
        ),
      ).resolves.toEqual({ decision: 'allow' });
    },
  );

  test.each([
    '/skills/reviewer/SKILL.md',
    './skills/reviewer/SKILL.md',
    'skills\\reviewer\\SKILL.md',
    'workspace/../skills/reviewer/SKILL.md',
  ])('applies the BYOM file policy to sandbox-routed path %s', async (filePath) => {
    const hook = createAttachedCodeEnvironmentPolicyHook(
      new Set(['attached-agent']),
      new Map([
        [
          'attached-agent',
          {
            configSchema: {
              permissions: { fileWrite: { allowed: ['ask', 'deny'], default: 'deny' } },
            },
            settings: { permissions: { fileWrite: 'deny' as const } },
            skillAuthoringAvailable: true,
          },
        ],
      ]),
    );

    await expect(
      hook(
        {
          toolName: 'create_file',
          toolInput: { path: filePath },
          executingAgentId: 'attached-agent',
        } as never,
        signal,
      ),
    ).resolves.toMatchObject({ decision: 'deny' });
  });
});

describe('buildAttachedCodeEnvironmentAdmissionHooks', () => {
  const bypassPolicy = { enabled: true, mode: 'bypass' as const };

  test('does not classify allow/deny-only BYOM tools as pause-capable', () => {
    const attachedIds = new Set(['attached-agent']);
    const settings = new Map<string, AttachedCodeEnvironmentPolicySettings>([
      [
        'attached-agent',
        {
          configSchema: {
            permissions: {
              fileWrite: { allowed: ['allow', 'ask', 'deny'], default: 'ask' },
              commandExecution: {
                allowed: ['allow', 'ask', 'deny'],
                default: 'ask',
              },
            },
          },
          settings: {
            permissions: { fileWrite: 'allow' as const, commandExecution: 'deny' as const },
          },
          skillAuthoringAvailable: true,
        },
      ],
    ]);
    const hooks = buildAttachedCodeEnvironmentAdmissionHooks(attachedIds, settings);

    expect(
      canAgentGraphPause({
        policy: bypassPolicy,
        agents: [{ id: 'attached-agent', tools: ['write_file', 'bash_tool'] }],
        resolvedProgrammaticHooks: hooks,
      }),
    ).toBe(false);
    expect(
      canAgentGraphPause({
        policy: bypassPolicy,
        agents: [{ id: 'attached-agent', tools: ['create_file'] }],
        resolvedProgrammaticHooks: hooks,
      }),
    ).toBe(true);
  });

  test('scopes BYOM pause capability to the attached agent that can ask', () => {
    const attachedIds = new Set(['attached-agent']);
    const hooks = buildAttachedCodeEnvironmentAdmissionHooks(
      attachedIds,
      new Map<string, AttachedCodeEnvironmentPolicySettings>([
        [
          'attached-agent',
          {
            configSchema: {
              permissions: {
                commandExecution: { allowed: ['allow', 'ask'], default: 'allow' },
              },
            },
            settings: { permissions: { commandExecution: 'allow' as const } },
          },
        ],
      ]),
    );

    expect(
      canAgentGraphPause({
        policy: bypassPolicy,
        agents: [
          { id: 'attached-agent', tools: ['read_file'] },
          { id: 'managed-agent', tools: ['bash_tool'] },
        ],
        resolvedProgrammaticHooks: hooks,
      }),
    ).toBe(false);
  });

  test('keeps the safe default ask-capable when no user setting is configured', () => {
    const attachedIds = new Set(['attached-agent']);
    expect(
      canAgentGraphPause({
        policy: bypassPolicy,
        agents: [{ id: 'attached-agent', tools: ['bash_tool'] }],
        resolvedProgrammaticHooks: buildAttachedCodeEnvironmentAdmissionHooks(attachedIds),
      }),
    ).toBe(true);
  });

  test('does not add a skill pause branch when skill authoring is unavailable', () => {
    const attachedIds = new Set(['attached-agent']);
    const settings = new Map<string, AttachedCodeEnvironmentPolicySettings>([
      [
        'attached-agent',
        {
          configSchema: {
            permissions: { fileWrite: { allowed: ['allow', 'deny'], default: 'allow' } },
          },
          settings: { permissions: { fileWrite: 'allow' } },
          skillAuthoringAvailable: false,
        },
      ],
    ]);
    expect(
      canAgentGraphPause({
        policy: bypassPolicy,
        agents: [{ id: 'attached-agent', tools: ['create_file', 'edit_file'] }],
        resolvedProgrammaticHooks: buildAttachedCodeEnvironmentAdmissionHooks(
          attachedIds,
          settings,
        ),
      }),
    ).toBe(false);
  });
});

describe('collectAttachedCodeEnvironmentAgentIds', () => {
  test('finds attached agents across eager and graph subagents without including managed agents', () => {
    const agents = [
      {
        id: 'root',
        codeExecutionContext: { environmentType: 'managed' },
        subagentAgentConfigs: [
          {
            id: 'attached-child',
            skillAuthoringAvailable: true,
            codeExecutionContext: {
              environmentType: 'attached',
              codeEnvironmentSettings: { permissions: { fileWrite: 'allow' as const } },
            },
          },
        ],
        lazySubagentConfigs: [
          {
            id: 'attached-lazy',
            skillAuthoringAvailable: true,
            codeExecutionContext: { environmentType: 'attached' },
          },
        ],
        subagentGraphConfigs: [
          {
            memberConfigs: [
              { id: 'managed-member', codeExecutionContext: { environmentType: 'managed' } },
              { id: 'attached-member', codeExecutionContext: { environmentType: 'attached' } },
            ],
          },
        ],
      },
    ];

    expect(collectAttachedCodeEnvironmentAgentIds(agents)).toEqual(
      new Set(['attached-child', 'attached-lazy', 'attached-member']),
    );
    expect(collectAttachedCodeEnvironmentPolicySettings(agents).get('attached-child')).toEqual({
      configSchema: undefined,
      settings: { permissions: { fileWrite: 'allow' } },
      skillAuthoringAvailable: true,
    });
    expect(collectAttachedCodeEnvironmentPolicySettings(agents).get('attached-lazy')).toEqual({
      configSchema: undefined,
      settings: undefined,
      skillAuthoringAvailable: true,
    });
  });
});

describe('assertAttachedCodeEnvironmentApprovalSupported', () => {
  test('rejects attached environments on callers without an approval/resume surface', () => {
    expect(() =>
      assertAttachedCodeEnvironmentApprovalSupported({
        hasAttachedCodeEnvironment: true,
        hitlCapable: false,
        approvalExplicitlyDisabled: false,
      }),
    ).toThrow('Attached code environments require a tool-approval capable client');
  });

  test('allows the admin emergency override and non-attached environments', () => {
    expect(() =>
      assertAttachedCodeEnvironmentApprovalSupported({
        hasAttachedCodeEnvironment: true,
        hitlCapable: false,
        approvalExplicitlyDisabled: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertAttachedCodeEnvironmentApprovalSupported({
        hasAttachedCodeEnvironment: false,
        hitlCapable: false,
        approvalExplicitlyDisabled: false,
      }),
    ).not.toThrow();
  });
});

for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  test.each(['dontAsk', 'bypass'] as const)(
    `${placement} BYOM hooks cannot predict review of statically denied tools under %s`,
    (mode) => {
      const graph = {
        id: 'root',
        tools: ['read_file'],
        [placement]: [
          {
            id: 'attached-member',
            codeExecutionContext: { environmentType: 'attached' },
            skillAuthoringAvailable: true,
          },
        ],
      };
      const ids = collectAttachedCodeEnvironmentAgentIds([graph]);
      const settings = collectAttachedCodeEnvironmentPolicySettings([graph]);
      const hooks = buildAttachedCodeEnvironmentAdmissionHooks(ids, settings);
      expect(hooks.every((h) => h.toolNames?.length)).toBe(true);
      const denied = {
        enabled: true,
        mode,
        allow: ['read_file'],
        ...(mode === 'bypass'
          ? {
              deny: [
                'write_file',
                'edit_file',
                'create_file',
                'bash_tool',
                'execute_code',
                'run_tools_with_bash',
                'run_tools_with_code',
                'compile_check',
              ],
            }
          : {}),
      };
      expect(
        canAgentGraphPause({ policy: denied, agents: [graph], resolvedProgrammaticHooks: hooks }),
      ).toBe(false);
      expect(
        canAgentGraphPause({
          policy: { enabled: true, mode: 'dontAsk', allow: ['read_file', 'bash_tool'] },
          agents: [graph],
          resolvedProgrammaticHooks: hooks,
        }),
      ).toBe(true);
      expect(
        canAgentGraphPause({
          policy: {
            enabled: true,
            mode: 'dontAsk',
            allow: ['read_file', 'bash_tool'],
            deny: ['bash_tool'],
          },
          agents: [graph],
          resolvedProgrammaticHooks: hooks,
        }),
      ).toBe(false);
      expect(
        canAgentGraphPause({
          policy: { enabled: true, mode: 'dontAsk', allow: ['read_file', 'create_file'] },
          agents: [graph],
          resolvedProgrammaticHooks: hooks,
        }),
      ).toBe(true);
      expect(
        canAgentGraphPause({
          policy: { enabled: true, mode: 'bypass', deny: ['*'] },
          agents: [graph],
          resolvedProgrammaticHooks: hooks,
        }),
      ).toBe(false);
    },
  );
}

describe('approval mode without attached targets', () => {
  const restrictedSettings: AttachedCodeEnvironmentPolicySettings = {
    configSchema: { permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } } },
  };
  const attachedContext = (settings: AttachedCodeEnvironmentPolicySettings) => ({
    environmentType: 'attached',
    codeEnvironmentConfigSchema: settings.configSchema,
    codeEnvironmentSettings: settings.settings,
  });

  test.each(['ask', 'acceptEdits', 'fullAccess'] as const)(
    'accepts a remembered %s mode for a turn that has nothing attached, resolving it to ask',
    (requested) => {
      const settings = collectAttachedCodeEnvironmentPolicySettings([
        { id: 'terra', codeExecutionContext: { environmentType: 'managed' } },
      ]);
      expect(settings.size).toBe(0);
      expect(resolveAttachedCodeApprovalMode(requested, settings)).toBe('ask');
    },
  );

  test('still rejects values that are not approval modes and treats an absent mode as none', () => {
    for (const requested of ['unrestricted', 'FULLACCESS', 1, {}]) {
      expect(() => resolveAttachedCodeApprovalMode(requested, new Map())).toThrow('not permitted');
    }
    expect(resolveAttachedCodeApprovalMode(undefined, new Map())).toBeUndefined();
    expect(resolveAttachedCodeApprovalMode(null, new Map())).toBeUndefined();
  });

  test('keeps strict validation once any attached target exists', () => {
    const unconfigured = new Map([['attached-agent', {}]]);
    expect(resolveAttachedCodeApprovalMode('ask', unconfigured)).toBe('ask');
    expect(() => resolveAttachedCodeApprovalMode('acceptEdits', unconfigured)).toThrow(
      'not permitted',
    );
    expect(() => resolveAttachedCodeApprovalMode('fullAccess', unconfigured)).toThrow(
      'not permitted',
    );
  });

  test('validates against a subagent machine when the parent runs without a workspace', () => {
    const parent = (child: Parameters<typeof collectAttachedCodeEnvironmentPolicySettings>[0][0]) =>
      collectAttachedCodeEnvironmentPolicySettings([
        { id: 'parent', lazySubagentConfigs: [child] },
      ]);
    const restricted = parent({
      id: 'child',
      codeExecutionContext: attachedContext(restrictedSettings),
    });
    expect([...restricted.keys()]).toEqual(['child']);
    expect(() => resolveAttachedCodeApprovalMode('fullAccess', restricted)).toThrow(
      'not permitted',
    );
    const permissive = parent({
      id: 'child',
      codeExecutionContext: attachedContext(fullAccessSettings),
    });
    expect(resolveAttachedCodeApprovalMode('fullAccess', permissive)).toBe('fullAccess');
    const graphMember = collectAttachedCodeEnvironmentPolicySettings([
      {
        id: 'parent',
        subagentGraphConfigs: [
          {
            memberConfigs: [
              { id: 'member', codeExecutionContext: attachedContext(restrictedSettings) },
            ],
          },
        ],
      },
    ]);
    expect(() => resolveAttachedCodeApprovalMode('fullAccess', graphMember)).toThrow(
      'not permitted',
    );
  });

  test('leaves the approvals-disabled contract unchanged', () => {
    expect(() => resolveAttachedCodeApprovalMode('fullAccess', new Map(), false)).toThrow(
      'not permitted',
    );
    expect(
      resolvePersistedCodeApprovalMode({
        requested: 'ask',
        conversationId: 'convo-1',
        conversation: { conversationId: 'convo-1', codeApprovalMode: 'fullAccess' },
        settingsByAgentId: new Map(),
        approvalsEnabled: false,
      }),
    ).toBeUndefined();
  });

  describe('persisted mode', () => {
    const persist = (
      requested: unknown,
      stored?: string,
      settingsByAgentId: Map<string, AttachedCodeEnvironmentPolicySettings> = new Map(),
      storedConversationId = 'convo-1',
    ) =>
      resolvePersistedCodeApprovalMode({
        requested,
        conversationId: 'convo-1',
        conversation:
          stored == null
            ? null
            : { conversationId: storedConversationId, codeApprovalMode: stored },
        settingsByAgentId,
      });

    test('keeps the stored mode through a turn with nothing attached', () => {
      expect(persist('ask', 'fullAccess')).toBe('fullAccess');
      expect(persist('fullAccess', 'acceptEdits')).toBe('acceptEdits');
      expect(persist(undefined, 'acceptEdits')).toBe('acceptEdits');
    });

    test('records no mode from the request when nothing valid is stored for this chat', () => {
      expect(persist('fullAccess')).toBeUndefined();
      expect(persist('ask')).toBeUndefined();
      expect(persist(undefined)).toBeUndefined();
      expect(persist('acceptEdits', 'fullAccess', new Map(), 'other-convo')).toBeUndefined();
      expect(persist('acceptEdits', 'unrestricted')).toBeUndefined();
      expect(() => persist('unrestricted', 'fullAccess')).toThrow('not permitted');
    });

    test('never carries the loaded row into a turn saved under another conversation', () => {
      const persistUnder = (overrideConversationId: unknown) =>
        resolvePersistedCodeApprovalMode({
          requested: 'ask',
          conversationId: 'convo-1',
          overrideConversationId,
          conversation: { conversationId: 'convo-1', codeApprovalMode: 'fullAccess' },
          settingsByAgentId: new Map(),
        });
      expect(persistUnder('convo-2__0')).toBeUndefined();
      expect(persistUnder('convo-2')).toBeUndefined();
      expect(persistUnder('convo-1__0')).toBe('fullAccess');
      expect(persistUnder('')).toBe('fullAccess');
      expect(persistUnder(undefined)).toBe('fullAccess');
    });

    test('records exactly the validated mode once a target is attached', () => {
      const permissive = new Map([['attached-agent', fullAccessSettings]]);
      expect(persist('acceptEdits', 'fullAccess', permissive)).toBe('acceptEdits');
      expect(persist(undefined, 'fullAccess', permissive)).toBeUndefined();
      expect(() =>
        persist('fullAccess', 'fullAccess', new Map([['attached-agent', restrictedSettings]])),
      ).toThrow('not permitted');
    });
  });
});
