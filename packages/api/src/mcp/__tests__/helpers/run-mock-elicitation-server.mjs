/**
 * Runnable wrapper around the mock elicitation server for zero-effort manual
 * testing: start it, point LibreChat at `http://localhost:3111/mcp`, ask an
 * agent to call `get_secret`, click the authorization link the chat renders,
 * then retry — the second call returns `s3cr3t-payload`.
 *
 * Run from `packages/api` (Node >= 22 strips the imported .ts types; the
 * `package.json` in this directory marks it as an ES module so the import
 * resolves):
 *
 *   node ./src/mcp/__tests__/helpers/run-mock-elicitation-server.mjs
 *
 * Env:
 *   MOCK_ELICITATION_PORT   (default 3111)
 *   MOCK_ELICITATION_SHAPE  'http-401' (default) | 'jsonrpc-200'
 *   MOCK_ELICITATION_FORMAT 'compact' (default) | 'pretty'
 */
import { startMockElicitationServer } from './mockElicitationServer.ts';

const port = Number(process.env.MOCK_ELICITATION_PORT ?? 3111);
const wireShape = process.env.MOCK_ELICITATION_SHAPE ?? 'http-401';
const bodyFormat = process.env.MOCK_ELICITATION_FORMAT ?? 'compact';

const server = await startMockElicitationServer({ port, wireShape, bodyFormat });

console.log(
  [
    '',
    `Mock AgentCore elicitation server listening on ${server.url}`,
    `  wire shape : ${wireShape}`,
    `  body format: ${bodyFormat}`,
    `  consent URL: ${server.consentUrl}`,
    `  reset URL  : ${server.resetUrl}  (GET flips authorized=false for a fresh round)`,
    '',
    'librechat.yaml:',
    '  mcpServers:',
    '    mock-elicitation:',
    '      type: streamable-http',
    `      url: http://localhost:${server.port}/mcp`,
    '',
    'Ask the agent to call "get_secret", click the authorization link, then retry.',
    'Press Ctrl+C to stop.',
    '',
  ].join('\n'),
);

const shutdown = () => {
  server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
