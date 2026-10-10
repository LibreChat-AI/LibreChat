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

const restricted = (relativePath: string, source: string): string[] =>
  messagesFor(lintStdin(relativePath, source), 'no-restricted-imports');

test.describe('the @librechat/chat package boundary', () => {
  test.beforeEach(() => inOneProject());

  test('the chat core rejects a UI framework import @scenario:the-chat-core-rejects-a-ui-framework-import', () => {
    test.setTimeout(120_000);
    const source = "import { useState } from 'react';\nexport const probe = useState;\n";

    const core = restricted('packages/chat/src/core/probe.ts', source);
    expect(core.join('\n')).toContain("'react' import is restricted");
    expect(restricted('packages/chat/src/index.ts', source)).toHaveLength(1);
    expect(restricted('packages/chat/src/core/Probe.tsx', source)).toHaveLength(1);
    const jsx = lintStdin(
      'packages/chat/src/core/Probe.tsx',
      'export const Probe = () => <div />;\n',
    );
    expect(messagesFor(jsx, 'no-restricted-syntax')).toHaveLength(1);
    for (const entry of ['../../react', '../../components']) {
      const nested = `import * as entry from '${entry}';\nexport const probe = entry;\n`;
      expect(restricted('packages/chat/src/core/streaming/probe.ts', nested), entry).toHaveLength(
        1,
      );
    }
    expect(
      restricted(
        'packages/chat/src/core/probe.ts',
        "import { atom } from 'jotai';\nexport const a = atom;\n",
      ),
    ).toHaveLength(1);

    expect(restricted('packages/chat/src/react/probe.ts', source)).toEqual([]);
  });

  test('the chat package rejects an import from the app @scenario:the-chat-package-rejects-an-import-from-the-app', () => {
    test.setTimeout(120_000);
    const probes = [
      "import store from '~/store';\nexport const s = store;\n",
      "import { useAuthContext } from '../../../../client/src/hooks';\nexport const h = useAuthContext;\n",
      "import { useRecoilValue } from 'recoil';\nexport const r = useRecoilValue;\n",
      "export { showFilesDialogAtom } from '@librechat/frontend/src/store/filesDialog';\n",
    ];
    for (const path of [
      'packages/chat/src/react/probe.ts',
      'packages/chat/src/components/probe.tsx',
    ]) {
      for (const source of probes) {
        expect(restricted(path, source), `${path}\n${source}`).toHaveLength(1);
      }
    }
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
});
