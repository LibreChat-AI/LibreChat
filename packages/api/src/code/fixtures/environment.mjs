import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const source = process.env.LIBRECHAT_CODE_TEST_PACKAGE;
const { loadCodeEnvironment, EnvironmentWorkspaceTools } = await import(
  pathToFileURL(join(source, 'dist/environment.js'))
);
const { LocalWorkspaceTools, SandboxWorkspaceTools } = await import(
  pathToFileURL(join(source, 'dist/workspace.js'))
);
const { NativeProcessWorkspaceCommandSandbox } = await import(
  pathToFileURL(join(source, 'dist/native-process.js'))
);
const definition = await loadCodeEnvironment(process.env.LIBRECHAT_CODE_TEST_DEFINITION);
const id = definition.definition.name;
const sandbox = new NativeProcessWorkspaceCommandSandbox({
  workspaceRoot: definition.definition.root,
});
await sandbox.prepare();
const tools = new EnvironmentWorkspaceTools(
  new SandboxWorkspaceTools({
    workspaceTools: await LocalWorkspaceTools.create({
      workspaces: [{ id, root: definition.definition.root }],
    }),
    commandWorkspaces: [id],
    commandSandbox: sandbox,
  }),
  [definition],
);
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await tools.execute(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Environment action rejected' }));
  }
});
server.listen(0, '127.0.0.1', () =>
  process.stdout.write(
    JSON.stringify({
      port: server.address().port,
      environment: tools.capabilities.workspaces[0].environment,
    }) + '\n',
  ),
);
process.on('SIGTERM', async () => {
  server.closeAllConnections();
  await sandbox.close();
  server.close(() => process.exit(0));
});
