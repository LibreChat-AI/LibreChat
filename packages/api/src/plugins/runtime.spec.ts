import fs from 'fs';
import os from 'os';
import path from 'path';
import { HookRegistry, executeHooks } from '@librechat/agents';
import {
  getDeploymentPluginHookCapabilities,
  registerDeploymentPluginHooks,
  hasDeploymentPluginHooks,
  hasDeploymentPluginToolApprovalHooks,
} from './runtime';
import { getPluginHookSource, setPluginHookSource } from '~/agents/hooks';
import { initializeDeploymentPlugins } from './deployment';
import { PLUGIN_MANIFEST_SCHEMA_ID } from './constants';

let base: string;
let pluginsDir: string;
let dataDir: string;

const HOOKS_DOCUMENT = {
  hooks: {
    PreToolUse: [
      {
        matcher: '^write_file$',
        hooks: [
          {
            type: 'command',
            command: `printf '%s' '{"decision":"deny","reason":"guarded"}'`,
          },
        ],
      },
      {
        matcher: '^(Write|Edit)$',
        hooks: [
          {
            type: 'command',
            command: `node -e 'let d="";process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{const p=JSON.parse(d);const claudeShaped=p.tool_name==="Write"&&p.tool_input.file_path==="/workspace/report.md"&&p.tool_input.path===undefined;console.log(JSON.stringify(claudeShaped?{decision:"deny",reason:"alias-guarded"}:{}));});'`,
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [
          { type: 'command', command: 'echo started >> "$PLUGIN_DATA/starts.log"' },
          { type: 'command', command: 'echo sibling >> "$PLUGIN_DATA/starts.log"' },
        ],
      },
    ],
  },
};

async function writePlugin(name: string, document: object = HOOKS_DOCUMENT): Promise<void> {
  const root = path.join(pluginsDir, name);
  await fs.promises.mkdir(path.join(root, 'ai.librechat', 'hooks'), { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA_ID, name }),
  );
  await fs.promises.writeFile(
    path.join(root, 'ai.librechat', 'hooks', 'hooks.json'),
    JSON.stringify(document),
  );
}

async function initialize(): Promise<void> {
  await initializeDeploymentPlugins({
    projectRoot: base,
    env: {
      DEPLOYMENT_PLUGINS_DIR: pluginsDir,
      DEPLOYMENT_PLUGIN_DATA_DIR: dataDir,
    },
    hookCapabilities: getDeploymentPluginHookCapabilities({ DEPLOYMENT_PLUGIN_HOOKS: 'true' }),
  });
}

async function fireRunStart(sessionId: string, sessionStartSource?: string): Promise<void> {
  const registry = new HookRegistry();
  registerDeploymentPluginHooks({ registry, context: { sessionId, sessionStartSource } });
  await executeHooks({
    registry,
    input: { hook_event_name: 'RunStart', runId: `run-${Math.random()}`, messages: [] },
  });
}

beforeEach(async () => {
  base = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lc-plugin-runtime-')),
  );
  pluginsDir = path.join(base, 'plugin');
  dataDir = path.join(base, 'data');
  await fs.promises.mkdir(pluginsDir, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(base, { recursive: true, force: true });
  /** Unconfigured missing directories reset the module registry to empty. */
  await initializeDeploymentPlugins({ projectRoot: base, env: {} });
});

describe('getDeploymentPluginHookCapabilities', () => {
  it('returns undefined unless DEPLOYMENT_PLUGIN_HOOKS is enabled', () => {
    expect(getDeploymentPluginHookCapabilities({})).toBeUndefined();
    expect(
      getDeploymentPluginHookCapabilities({ DEPLOYMENT_PLUGIN_HOOKS: 'false' }),
    ).toBeUndefined();
    expect(
      getDeploymentPluginHookCapabilities({ DEPLOYMENT_PLUGIN_HOOKS: 'true' })?.handlerTypes.has(
        'command',
      ),
    ).toBe(true);
  });
});

describe('registerDeploymentPluginHooks', () => {
  it('registers nothing when plugins loaded without hook capabilities', async () => {
    await writePlugin('inert');
    await initializeDeploymentPlugins({
      projectRoot: base,
      env: { DEPLOYMENT_PLUGINS_DIR: pluginsDir, DEPLOYMENT_PLUGIN_DATA_DIR: dataDir },
    });
    expect(hasDeploymentPluginHooks()).toBe(false);
    const registry = new HookRegistry();
    expect(registerDeploymentPluginHooks({ registry })).toBe(0);
  });

  it('executes a plugin command hook end-to-end through a run hook registry', async () => {
    await writePlugin('guard');
    await initialize();
    expect(hasDeploymentPluginHooks()).toBe(true);

    const registry = new HookRegistry();
    const registered = registerDeploymentPluginHooks({
      registry,
      context: { sessionId: 'conversation-1' },
    });
    expect(registered).toBe(4);

    const result = await executeHooks({
      registry,
      matchQuery: 'write_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'write_file',
        toolInput: { path: '/etc/passwd' },
        toolUseId: 'tool-1',
      },
    });
    expect(result).toEqual(expect.objectContaining({ decision: 'deny', reason: 'guarded' }));

    const unmatched = await executeHooks({
      registry,
      matchQuery: 'read_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'read_file',
        toolInput: {},
        toolUseId: 'tool-2',
      },
    });
    expect(unmatched.decision).toBeUndefined();
  });

  it('fires Claude-alias matchers against runtime tool names with plugin-namespace payloads', async () => {
    await writePlugin('alias');
    await initialize();

    const registry = new HookRegistry();
    registerDeploymentPluginHooks({ registry, context: { sessionId: 'conversation-alias' } });

    const result = await executeHooks({
      registry,
      matchQuery: 'create_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'create_file',
        toolInput: { path: '/workspace/report.md' },
        toolUseId: 'tool-1',
      },
    });
    expect(result).toEqual(expect.objectContaining({ decision: 'deny', reason: 'alias-guarded' }));
  });

  it('keeps native payloads for matchers authored in the runtime namespace', async () => {
    await writePlugin('native', {
      hooks: {
        PreToolUse: [
          {
            matcher: '^create_file$',
            hooks: [
              {
                type: 'command',
                command: `node -e 'let d="";process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{const p=JSON.parse(d);const nativeShaped=p.tool_name==="create_file"&&p.tool_input.path==="/workspace/native.md"&&p.tool_input.file_path===undefined;console.log(JSON.stringify(nativeShaped?{decision:"deny",reason:"native-guarded"}:{}));});'`,
              },
            ],
          },
        ],
      },
    });
    await initialize();

    const registry = new HookRegistry();
    registerDeploymentPluginHooks({ registry, context: { sessionId: 'conversation-native' } });

    const result = await executeHooks({
      registry,
      matchQuery: 'create_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'create_file',
        toolInput: { path: '/workspace/native.md' },
        toolUseId: 'tool-1',
      },
    });
    expect(result).toEqual(expect.objectContaining({ decision: 'deny', reason: 'native-guarded' }));
  });

  it('keeps native payloads for the native alternative of a mixed-namespace matcher', async () => {
    await writePlugin('mixed', {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|create_file',
            hooks: [
              {
                type: 'command',
                command: `node -e 'let d="";process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{const p=JSON.parse(d);const nativeShaped=p.tool_name==="create_file"&&p.tool_input.path==="/workspace/mixed.md"&&p.tool_input.file_path===undefined;console.log(JSON.stringify(nativeShaped?{decision:"deny",reason:"mixed-native"}:{}));});'`,
              },
            ],
          },
        ],
      },
    });
    await initialize();

    const registry = new HookRegistry();
    registerDeploymentPluginHooks({ registry, context: { sessionId: 'conversation-mixed' } });

    const result = await executeHooks({
      registry,
      matchQuery: 'create_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'create_file',
        toolInput: { path: '/workspace/mixed.md' },
        toolUseId: 'tool-1',
      },
    });
    expect(result).toEqual(expect.objectContaining({ decision: 'deny', reason: 'mixed-native' }));
  });

  it('lets an overlapping once declaration fire after its sibling is spent', async () => {
    const onceHandler = {
      type: 'command',
      command: 'echo fired >> "$PLUGIN_DATA/overlap.log"',
      once: true,
    };
    await writePlugin('overlap', {
      hooks: {
        PreToolUse: [
          { matcher: 'write_file|read_file', hooks: [onceHandler] },
          { matcher: '^read_file$', hooks: [onceHandler] },
        ],
      },
    });
    await initialize();

    const firePreToolUse = async (toolName: string) => {
      const registry = new HookRegistry();
      registerDeploymentPluginHooks({ registry, context: { sessionId: 'conversation-overlap' } });
      await executeHooks({
        registry,
        matchQuery: toolName,
        input: {
          hook_event_name: 'PreToolUse',
          runId: `run-${Math.random()}`,
          toolName,
          toolInput: {},
          toolUseId: 'tool-1',
        },
      });
    };

    /** Spends the broad declaration's once key. */
    await firePreToolUse('write_file');
    /**
     * The spent broad declaration must not claim the per-input dedup slot,
     * or the narrow declaration's independent once-key would never fire.
     */
    await firePreToolUse('read_file');
    await firePreToolUse('read_file');

    const log = await fs.promises.readFile(path.join(dataDir, 'overlap', 'overlap.log'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(2);
  });

  it('serves the run seam through the plugin hook source', async () => {
    await writePlugin('seam');
    await initialize();
    setPluginHookSource({
      hasHooks: hasDeploymentPluginHooks,
      register: registerDeploymentPluginHooks,
    });
    const source = getPluginHookSource();
    expect(source?.hasHooks()).toBe(true);
    expect(hasDeploymentPluginToolApprovalHooks()).toBe(true);
    expect(hasDeploymentPluginToolApprovalHooks(['unmatched_tool'])).toBe(false);
    expect(hasDeploymentPluginToolApprovalHooks(['write_file'])).toBe(true);
    const registry = new HookRegistry();
    expect(source?.register({ registry, context: { sessionId: 'conversation-seam' } })).toBe(4);
    setPluginHookSource(undefined);
    expect(getPluginHookSource()).toBeUndefined();
  });

  it('fires every SessionStart handler once per conversation and per lifecycle source', async () => {
    await writePlugin('session');
    await initialize();

    await fireRunStart('conversation-a');
    await fireRunStart('conversation-a');
    await fireRunStart('conversation-b');
    /** A startup firing must not suppress the conversation's resume rebuild. */
    await fireRunStart('conversation-a', 'resume');
    await fireRunStart('conversation-a', 'resume');

    const log = await fs.promises.readFile(path.join(dataDir, 'session', 'starts.log'), 'utf8');
    const lines = log.trim().split('\n').sort();
    expect(lines).toEqual(['sibling', 'sibling', 'sibling', 'started', 'started', 'started']);
  });

  it("reports the caller's working directory in hook payloads", async () => {
    await writePlugin('cwd', {
      hooks: {
        PreToolUse: [
          {
            matcher: '^write_file$',
            hooks: [
              {
                type: 'command',
                command: `node -e 'let d="";process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{const p=JSON.parse(d);console.log(JSON.stringify({decision:"deny",reason:p.cwd+"|"+process.cwd()}));});'`,
              },
            ],
          },
        ],
      },
    });
    await initialize();

    const registry = new HookRegistry();
    registerDeploymentPluginHooks({
      registry,
      context: { sessionId: 'conversation-cwd', cwd: '/workspace/session' },
    });

    const result = await executeHooks({
      registry,
      matchQuery: 'write_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'write_file',
        toolInput: {},
        toolUseId: 'tool-1',
      },
    });
    /** Payload carries the session cwd; the process still runs from the plugin root. */
    expect(result).toEqual(
      expect.objectContaining({
        reason: `/workspace/session|${path.join(pluginsDir, 'cwd')}`,
      }),
    );
  });

  it('presents Claude payloads to matcherless tool guards', async () => {
    await writePlugin('wildcard', {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: `node -e 'let d="";process.stdin.on("data",(c)=>{d+=c;}).on("end",()=>{const p=JSON.parse(d);const claudeShaped=p.tool_name==="Write"&&p.tool_input.file_path==="/workspace/wild.md"&&p.tool_input.path===undefined;console.log(JSON.stringify(claudeShaped?{decision:"deny",reason:"wildcard-guarded"}:{}));});'`,
              },
            ],
          },
        ],
      },
    });
    await initialize();

    const registry = new HookRegistry();
    registerDeploymentPluginHooks({ registry, context: { sessionId: 'conversation-wild' } });

    const result = await executeHooks({
      registry,
      matchQuery: 'create_file',
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'create_file',
        toolInput: { path: '/workspace/wild.md' },
        toolUseId: 'tool-1',
      },
    });
    expect(result).toEqual(
      expect.objectContaining({ decision: 'deny', reason: 'wildcard-guarded' }),
    );
  });

  it('persists once-only state per declaration across runs of the same conversation', async () => {
    const onceHandler = {
      type: 'command',
      command: 'echo fired >> "$PLUGIN_DATA/once.log"',
      once: true,
    };
    await writePlugin('oncely', {
      hooks: {
        PreToolUse: [
          { matcher: '^write_file$', hooks: [onceHandler] },
          { matcher: '^read_file$', hooks: [onceHandler] },
        ],
      },
    });
    await initialize();

    const firePreToolUse = async (sessionId: string, toolName: string) => {
      const registry = new HookRegistry();
      registerDeploymentPluginHooks({ registry, context: { sessionId } });
      await executeHooks({
        registry,
        matchQuery: toolName,
        input: {
          hook_event_name: 'PreToolUse',
          runId: `run-${Math.random()}`,
          toolName,
          toolInput: {},
          toolUseId: 'tool-1',
        },
      });
    };

    await firePreToolUse('conversation-once', 'write_file');
    await firePreToolUse('conversation-once', 'write_file');
    /** A sibling declaration with an identical handler is independently once-only. */
    await firePreToolUse('conversation-once', 'read_file');
    await firePreToolUse('conversation-other', 'write_file');

    const log = await fs.promises.readFile(path.join(dataDir, 'oncely', 'once.log'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(3);
  });
});
