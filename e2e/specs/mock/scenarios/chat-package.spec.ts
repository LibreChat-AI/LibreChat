import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  run,
  repoRoot,
  lintStdin,
  messagesFor,
  inOneProject,
  designRuleSeverities,
} from './lint.helpers';

/**
 * `@librechat/chat` is the package the chat hooks and components move into. Its
 * boundaries are what make it reusable: the core runs without a UI framework, and
 * nothing in the package reaches back into the app. These scenarios ask the real
 * flat config and the real build whether that holds, before any code has moved in.
 */

const UI_MODULES = [
  'react',
  'react-dom',
  'jotai',
  'recoil',
  '@tanstack/react-query',
  '@librechat/client',
];

/** The forms a source can load a module in; the boundary judges each the same way. */
const FORMS = (specifier: string): string[] => [
  `import x from '${specifier}';\nexport default x;\n`,
  `export * from '${specifier}';\n`,
  `export const load = () => import('${specifier}');\n`,
  `export const load = () => import(\`${specifier}\`);\n`,
  `export const load = () => require('${specifier}');\n`,
  `export type X = typeof import('${specifier}');\n`,
];

/** One row of the boundary table: a file, a specifier, and whether the boundary rejects it. */
type BoundaryRow = { file: string; specifier: string; rejected: boolean };

const CORE = 'packages/chat/src/core/streaming/probe.ts';
const BINDING = 'packages/chat/src/react/probe.ts';
const COMPONENT = 'packages/chat/src/components/Probe.tsx';

/** Every spelling of the `/react` and `/components` entries from a nested core file. */
const ENTRY_SPELLINGS = ['react', 'components'].flatMap((entry) => [
  `../../${entry}`,
  `../../${entry}/`,
  `../../${entry}.ts`,
  `../../${entry}.tsx`,
  `../../${entry}.js`,
  `../../${entry}.mjs`,
  `../../${entry}.cjs`,
  `../../${entry}/index`,
  `../../${entry}/index.js`,
]);

const row = (file: string, rejected: boolean) => (specifier: string) => ({
  file,
  specifier,
  rejected,
});

const CORE_TABLE: BoundaryRow[] = [
  ...ENTRY_SPELLINGS.map(row(CORE, true)),
  ...[
    'react',
    'react/jsx-runtime',
    'react-dom/client',
    'jotai/utils',
    '@tanstack/react-query',
    '@librechat/client',
    '@librechat/chat/react',
    '@librechat/chat/components',
  ].map(row(CORE, true)),
  ...['react', './components/'].map(row('packages/chat/src/index.ts', true)),
  ...['librechat-data-provider', '../types', '../types.js', './react-utils', '../reactive.js'].map(
    row(CORE, false),
  ),
  ...['react', 'jotai', '../core', '../components'].map(row(BINDING, false)),
];

const APP_TABLE: BoundaryRow[] = [BINDING, COMPONENT, CORE].flatMap((file) =>
  [
    '~/store',
    '@librechat/frontend',
    '@librechat/frontend/src/store/filesDialog',
    'recoil',
    '@librechat/chat',
    '@librechat/chat/components',
  ].map(row(file, true)),
);

/**
 * Lints every row in every form through the real flat config in one process, and returns the
 * sources whose verdict differs from the table, so a failure names the spelling that slipped.
 */
function boundaryMismatches(rows: BoundaryRow[]): string[] {
  const sources = rows.flatMap((entry) =>
    FORMS(entry.specifier).map((code) => ({ ...entry, code })),
  );
  const query = `
    const { ESLint } = require('eslint');
    const sources = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    (async () => {
      const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
      const verdicts = [];
      for (const source of sources) {
        const [result] = await eslint.lintText(source.code, { filePath: source.file });
        verdicts.push(result.messages.filter((m) => m.ruleId === 'chat/boundary').length);
      }
      process.stdout.write(JSON.stringify(verdicts));
    })();
  `;
  const answered = run(process.execPath, ['-e', query], { input: JSON.stringify(sources) });
  if (answered.status !== 0) throw new Error(`no lint verdicts: ${answered.output}`);
  const verdicts = JSON.parse(answered.stdout) as number[];
  return sources.flatMap((source, index) =>
    verdicts[index] > 0 === source.rejected
      ? []
      : [
          `${source.file}: ${source.code.trim()} should be ${source.rejected ? 'rejected' : 'allowed'}`,
        ],
  );
}

test.describe('the @librechat/chat package boundary', () => {
  test.beforeEach(() => inOneProject());

  test('the chat core rejects a UI framework import @scenario:the-chat-core-rejects-a-ui-framework-import', () => {
    test.setTimeout(180_000);
    expect(boundaryMismatches(CORE_TABLE)).toEqual([]);

    const jsx = lintStdin(
      'packages/chat/src/core/Probe.tsx',
      'export const Probe = () => <div />;\n',
    );
    expect(messagesFor(jsx, 'no-restricted-syntax')).toHaveLength(1);
  });

  test('the chat package rejects an import from the app @scenario:the-chat-package-rejects-an-import-from-the-app', () => {
    test.setTimeout(180_000);
    expect(boundaryMismatches(APP_TABLE)).toEqual([]);
  });

  test('chat components reject literal copy @scenario:chat-components-reject-literal-copy', () => {
    test.setTimeout(120_000);
    const path = 'packages/chat/src/components/Probe.tsx';
    const literal = lintStdin(path, 'export function Probe() {\n  return <p>Hello world</p>;\n}\n');
    expect(messagesFor(literal, 'i18next/no-literal-string')).toHaveLength(1);

    const labels = lintStdin(
      path,
      'export function Probe() {\n  return <button title="Stop generating" aria-label={`Stop generating`} />;\n}\n',
    );
    expect(messagesFor(labels, 'no-restricted-syntax')).toHaveLength(2);
    const props = lintStdin(
      path,
      'export function Probe() {\n  return <img alt="" className="size-4" role="presentation" />;\n}\n',
    );
    expect(messagesFor(props, 'no-restricted-syntax')).toEqual([]);

    const localized = lintStdin(
      path,
      'export function Probe({ label }: { label: string }) {\n  return <p>{label}</p>;\n}\n',
    );
    expect(messagesFor(localized, 'i18next/no-literal-string')).toEqual([]);
  });

  test('the design rules police the chat components @scenario:the-design-rules-police-the-chat-components', () => {
    test.setTimeout(120_000);
    const path = 'packages/chat/src/components/Probe.tsx';
    const severities = designRuleSeverities([path])[path];
    for (const rule of [
      'shadcn/no-restyle',
      'shadcn/no-raw-colors',
      'shadcn/no-arbitrary-values',
      'shadcn/no-inline-styles',
      'shadcn/require-static-classes',
      'shadcn/no-unknown-classes',
    ]) {
      expect(severities[rule], rule).toBe(2);
    }

    const messages = lintStdin(
      path,
      'export function Probe() {\n  return <p className="bg-red-500">x</p>;\n}\n',
    );
    expect(messagesFor(messages, 'shadcn/no-raw-colors').length).toBeGreaterThan(0);
  });
});

test.describe('the built @librechat/chat package', () => {
  test.beforeEach(() => inOneProject());

  test('the chat core loads without React, Jotai or Recoil @scenario:the-chat-core-loads-without-react-jotai-or-recoil', () => {
    test.setTimeout(120_000);
    const dist = resolve(repoRoot, 'packages/chat/dist');
    expect(existsSync(dist), 'packages/chat/dist is missing: run npm run build').toBe(true);

    /** Every UI module fails to resolve in this process, so loading the core
     *  succeeds only when nothing it reaches imports one. */
    const probe = `
      const Module = require('node:module');
      const blocked = new Set(${JSON.stringify(UI_MODULES)});
      const resolveFilename = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (blocked.has(request)) throw new Error('the core reached ' + request);
        return resolveFilename.call(this, request, ...rest);
      };
      const core = require('@librechat/chat');
      const answer = {
        contentTypesText: core.ContentTypes.TEXT,
        toUIMessage: typeof core.toUIMessage,
        react: require.resolve('@librechat/chat/react'),
        components: require.resolve('@librechat/chat/components'),
      };
      import('@librechat/chat').then((esm) => {
        answer.esmToUIMessage = typeof esm.toUIMessage;
        process.stdout.write(JSON.stringify(answer));
      });
    `;
    const loaded = run(process.execPath, ['-e', probe]);
    expect(loaded.status, loaded.output).toBe(0);
    const answer = JSON.parse(loaded.stdout) as Record<string, string>;
    expect(answer.contentTypesText).toBe('text');
    expect(answer.toUIMessage).toBe('function');
    expect(answer.esmToUIMessage).toBe('function');
    expect(answer.react).toBe(resolve(dist, 'react.cjs'));
    expect(answer.components).toBe(resolve(dist, 'components.cjs'));
  });

  test('the client resolves the stream core from the built package @scenario:the-client-resolves-the-stream-core-from-the-built-package', () => {
    test.setTimeout(120_000);
    const dist = resolve(repoRoot, 'packages/chat/dist');
    expect(existsSync(dist), 'packages/chat/dist is missing: run npm run build').toBe(true);

    /** Resolved from the client workspace, the way Vite and the client's jest see it,
     *  with every UI module blocked so the stream code proves it stays framework-free. */
    const probe = `
      const Module = require('node:module');
      const blocked = new Set(${JSON.stringify(UI_MODULES)});
      const resolveFilename = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (blocked.has(request)) throw new Error('the core reached ' + request);
        return resolveFilename.call(this, request, ...rest);
      };
      const core = require('@librechat/chat');
      const names = ['createSSETransport', 'normalizeFrame', 'applyMessageDelta', 'applyToolCallDelta', 'isAnsweredAskUserQuestionPart', 'reduceStep', 'createStreamState'];
      const answer = { entry: require.resolve('@librechat/chat'), cjs: {}, esm: {} };
      for (const name of names) answer.cjs[name] = typeof core[name];
      import('@librechat/chat').then((esm) => {
        for (const name of names) answer.esm[name] = typeof esm[name];
        process.stdout.write(JSON.stringify(answer));
      });
    `;
    const loaded = run(process.execPath, ['-e', probe], { cwd: resolve(repoRoot, 'client') });
    expect(loaded.status, loaded.output).toBe(0);
    const answer = JSON.parse(loaded.stdout) as {
      entry: string;
      cjs: Record<string, string>;
      esm: Record<string, string>;
    };
    expect(answer.entry).toBe(resolve(dist, 'index.cjs'));
    for (const exports of [answer.cjs, answer.esm]) {
      expect(Object.values(exports)).toEqual(Array(7).fill('function'));
    }
  });

  test('a host runs a turn through the built chat core @scenario:a-host-runs-a-turn-through-the-built-chat-core', () => {
    test.setTimeout(120_000);
    const dist = resolve(repoRoot, 'packages/chat/dist');
    expect(existsSync(dist), 'packages/chat/dist is missing: run npm run build').toBe(true);

    /** The core `Chat` drives a turn over a substitute transport with every UI module blocked;
     *  the `/react` entry then backs a second chat with the React Query message cache. */
    const probe = `
      const Module = require('node:module');
      const blocked = new Set(${JSON.stringify(UI_MODULES)});
      const resolveFilename = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (blocked.has(request)) throw new Error('the core reached ' + request);
        return resolveFilename.call(this, request, ...rest);
      };
      const { Chat } = require('@librechat/chat');
      const events = [
        { type: 'created', data: { created: true } },
        { type: 'final', data: { final: true, responseMessage: { messageId: 'r1', text: 'Hello' } } },
      ];
      const stream = {
        close() {},
        async *[Symbol.asyncIterator]() { yield* events; },
      };
      let messages = [];
      const statuses = [];
      const state = {
        error: undefined,
        connection: 'idle',
        get status() { return statuses[statuses.length - 1] || 'ready'; },
        set status(value) { statuses.push(value); },
        get messages() { return messages; },
        replaceMessages(next) { messages = next; },
      };
      const chat = new Chat({
        id: 'convo-1',
        state,
        transport: {
          sendMessages: async () => ({ status: 'stream', stream }),
          reconnectToStream: async () => null,
          abort: async () => ({ success: true }),
        },
        prepareRequest: () => ({
          payload: { endpoint: 'agents' },
          messages: [{ messageId: 'r1', text: '' }],
        }),
      });
      chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }).then(() => {
        Module._resolveFilename = resolveFilename;
        const { QueryClient } = require('@tanstack/react-query');
        const { ReactQueryChatState } = require('@librechat/chat/react');
        const queryClient = new QueryClient();
        const cached = new ReactQueryChatState({ queryClient, key: 'convo-1' });
        cached.replaceMessages(messages);
        process.stdout.write(JSON.stringify({
          statuses,
          text: messages[0].text,
          cached: queryClient.getQueryData(['messages', 'convo-1']).length,
        }));
      });
    `;
    const loaded = run(process.execPath, ['-e', probe], { cwd: resolve(repoRoot, 'client') });
    expect(loaded.status, loaded.output).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({
      statuses: ['submitted', 'streaming', 'ready'],
      text: 'Hello',
      cached: 1,
    });
  });

  test('a host sees a start it stopped before the answer as possibly still running @scenario:a-host-sees-a-stopped-start-as-possibly-still-running', () => {
    test.setTimeout(120_000);
    const dist = resolve(repoRoot, 'packages/chat/dist');
    expect(existsSync(dist), 'packages/chat/dist is missing: run npm run build').toBe(true);

    /** The start reaches the transport and never answers; the stop cannot name the generation,
     *  so the turn finishes as a disconnect and every later stop stays the host's to make. */
    const probe = `
      const { Chat } = require('@librechat/chat');
      let messages = [];
      const statuses = [];
      const finishes = [];
      const chat = new Chat({
        id: 'convo-1',
        state: {
          error: undefined,
          connection: 'idle',
          get status() { return statuses[statuses.length - 1] || 'ready'; },
          set status(value) { statuses.push(value); },
          get messages() { return messages; },
          replaceMessages(next) { messages = next; },
        },
        transport: {
          sendMessages: () => new Promise(() => {}),
          reconnectToStream: async () => null,
          abort: async () => { throw new Error('no stop should be sent'); },
        },
        prepareRequest: () => ({
          payload: { endpoint: 'agents' },
          messages: [{ messageId: 'r1', text: '' }],
        }),
        onFinish: ({ isAbort, isDisconnect }) => finishes.push({ isAbort, isDisconnect }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      setTimeout(async () => {
        const first = await chat.stop();
        await sent;
        const second = await chat.stop();
        process.stdout.write(JSON.stringify({ first, second, finishes, status: chat.status }));
      }, 0);
    `;
    const loaded = run(process.execPath, ['-e', probe], { cwd: resolve(repoRoot, 'client') });
    expect(loaded.status, loaded.output).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({
      first: { status: 'unaddressable' },
      second: { status: 'unaddressable' },
      finishes: [{ isAbort: false, isDisconnect: true }],
      status: 'error',
    });
  });

  test('a host sees a pause retired when its expiry passes with no later frame @scenario:a-host-sees-an-expired-pause-retired-without-a-frame', () => {
    test.setTimeout(120_000);
    const dist = resolve(repoRoot, 'packages/chat/dist');
    expect(existsSync(dist), 'packages/chat/dist is missing: run npm run build').toBe(true);

    /** A reload restores a pause that expires shortly; nothing else arrives before it does. */
    const probe = `
      const { Chat } = require('@librechat/chat');
      let messages = [];
      const sends = [];
      const chat = new Chat({
        id: 'convo-1',
        state: { error: undefined, connection: 'idle', status: 'ready',
          get messages() { return messages; },
          replaceMessages(next) { messages = next; } },
        transport: {
          sendMessages: (request) => { sends.push(request.trigger); return new Promise(() => {}); },
          reconnectToStream: async () => null,
          abort: async () => ({ success: true }),
        },
        prepareRequest: () => ({ payload: { endpoint: 'agents' } }),
      });
      let notified = 0;
      chat.subscribe(() => { notified += 1; });
      chat.restorePendingAction({
        actionId: 'action-1', streamId: 'convo-1', conversationId: 'convo-1', createdAt: 1,
        expiresAt: Date.now() + 50,
        payload: { type: 'ask_user_question', question: { question: 'Which?' }, tool_call_id: 'ask-1' },
      }, 500);
      const held = chat.pendingAction != null;
      const before = notified;
      setTimeout(async () => {
        const retired = chat.pendingAction === undefined && notified > before;
        chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        process.stdout.write(JSON.stringify({ held, retired, sends }));
        chat.dispose();
        process.exit(0);
      }, 150);
    `;
    const loaded = run(process.execPath, ['-e', probe], { cwd: resolve(repoRoot, 'client') });
    expect(loaded.status, loaded.output).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({
      held: true,
      retired: true,
      sends: ['submit-message'],
    });
  });

  test('a host answers a pause on a stream that names no generation @scenario:a-host-answers-a-pause-on-a-stream-without-a-generation', () => {
    test.setTimeout(120_000);
    const dist = resolve(repoRoot, 'packages/chat/dist');
    expect(existsSync(dist), 'packages/chat/dist is missing: run npm run build').toBe(true);

    /** An older server streams the pause without dating its generation; the action id fences the answer. */
    const probe = `
      const { Chat } = require('@librechat/chat');
      let messages = [];
      const events = [];
      let push;
      const stream = {
        streamId: 'convo-1',
        close() {},
        async *[Symbol.asyncIterator]() {
          while (true) {
            const event = events.shift() ?? (await new Promise((resolve) => { push = resolve; }));
            yield event;
            if (event.type === 'final') return;
          }
        },
      };
      const emit = (event) => { if (push) { const p = push; push = undefined; p(event); } else events.push(event); };
      const answers = [];
      const chat = new Chat({
        id: 'convo-1',
        state: { error: undefined, connection: 'idle', status: 'ready',
          get messages() { return messages; },
          replaceMessages(next) { messages = next; } },
        transport: {
          sendMessages: async () => ({ status: 'stream', stream }),
          reconnectToStream: async () => null,
          abort: async () => ({ success: true }),
          resume: async (request) => {
            answers.push(request);
            return { status: 'resuming', streamId: 'convo-1', conversationId: 'convo-1' };
          },
        },
        prepareRequest: () => ({ payload: { endpoint: 'agents' } }),
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      (async () => {
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await tick();
        emit({ type: 'pending_action', data: {
          actionId: 'action-1', streamId: 'convo-1', conversationId: 'convo-1', createdAt: 1,
          payload: { type: 'ask_user_question', question: { question: 'Which?' }, tool_call_id: 'ask-1' },
        } });
        await tick();
        await chat.addToolOutput({ toolCallId: 'ask-1', output: 'yes' });
        const cleared = chat.pendingAction === undefined;
        emit({ type: 'final', data: { final: true, responseMessage: { messageId: 'r1', text: 'Done' } } });
        await sent;
        const [answer] = answers;
        process.stdout.write(JSON.stringify({
          answered: answers.length,
          actionId: answer.actionId,
          answer: answer.answer,
          dated: 'generationCreatedAt' in answer,
          cleared,
          status: chat.status,
        }));
      })();
    `;
    const loaded = run(process.execPath, ['-e', probe], { cwd: resolve(repoRoot, 'client') });
    expect(loaded.status, loaded.output).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({
      answered: 1,
      actionId: 'action-1',
      answer: 'yes',
      dated: false,
      cleared: true,
      status: 'ready',
    });
  });
});
