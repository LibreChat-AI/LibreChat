import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import type { CodeWorkspaceDescriptor } from 'librechat-data-provider';
import { createAttachedWorkspaceBashTool } from './command';
import { registerCodeExecutionTools } from '~/agents/tools';

const live = process.env.LIBRECHAT_CODE_TEST_PACKAGE ? describe : describe.skip;

live('native environment integration', () => {
  test('runs a named action through the LibreChat tool, HTTP and a real native worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lc-environment-live-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const definition = join(directory, 'environment.yaml');
    await writeFile(
      definition,
      'name: project\nroot: project\nactions:\n  - name: verify\n    command: "printf verified > result.txt; printf success"\n',
    );
    const child = spawn(process.execPath, [join(__dirname, 'fixtures/environment.mjs')], {
      env: { ...process.env, LIBRECHAT_CODE_TEST_DEFINITION: definition },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    try {
      const started = new Promise<{
        port: number;
        environment: CodeWorkspaceDescriptor['environment'];
      }>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('\n')) {
            try {
              resolve(JSON.parse(output.trim()));
            } catch (error) {
              reject(error);
            }
          }
        });
      });
      const ready = await Promise.race([
        started,
        exited.then(() => {
          throw new Error(errors);
        }),
      ]);
      const tool = createAttachedWorkspaceBashTool({
        baseUrl: `http://127.0.0.1:${ready.port}/v1`,
        authHeaders: () => ({}),
        workspaceId: 'project',
        environment: ready.environment,
      });
      const definitions = registerCodeExecutionTools({
        toolRegistry: undefined,
        toolDefinitions: [],
        includeBash: true,
        workspaceTools: true,
        workspaceOperations: new Set(['execute_command']),
        workspaceEnvironment: ready.environment,
      });
      const modelSchema = definitions.toolDefinitions.find(
        (definition) => definition.name === 'bash_tool',
      )?.parameters;
      expect(modelSchema).toMatchObject({
        properties: { environmentAction: { enum: ['verify'] } },
        required: [],
      });
      await tool.invoke({ environmentAction: 'verify' });
      expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('verified');
      const stale = createAttachedWorkspaceBashTool({
        baseUrl: `http://127.0.0.1:${ready.port}/v1`,
        authHeaders: () => ({}),
        workspaceId: 'project',
        environment: { ...ready.environment!, fingerprint: 'b'.repeat(64) },
      });
      await expect(stale.invoke({ environmentAction: 'verify' })).rejects.toThrow();
    } finally {
      child.kill('SIGTERM');
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
