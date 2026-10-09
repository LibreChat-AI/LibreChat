const fs = require('node:fs');
const path = require('node:path');
const z = require('zod/v4');

const DEFAULT_STATE_PATH = path.join('/tmp', 'librechat-e2e-mcp-tool-state.json');
const POLL_INTERVAL_MS = 50;

function getStatePath() {
  return process.env.E2E_MCP_STATE_PATH || DEFAULT_STATE_PATH;
}

function emptyState() {
  return { revision: 0, tool: null };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
    if (typeof parsed.revision !== 'number') {
      throw new Error('revision must be a number');
    }
    if (
      parsed.tool !== null &&
      (typeof parsed.tool !== 'object' || typeof parsed.tool.description !== 'string')
    ) {
      throw new Error('tool must be null or contain a description');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return emptyState();
    }
    throw error;
  }
}

function writeState(state) {
  const statePath = getStatePath();
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`);
  fs.renameSync(temporaryPath, statePath);
}

function resetState() {
  writeState(emptyState());
}

function schemaForVersion(schemaVersion) {
  if (schemaVersion === 2) {
    return {
      value: z.string(),
      uppercase: z.boolean().optional(),
    };
  }
  return { value: z.string() };
}

function toolCallback({ value, uppercase = false }) {
  const text = uppercase ? value.toUpperCase() : value;
  return Promise.resolve({ content: [{ type: 'text', text }] });
}

/**
 * Keeps one SDK McpServer's live registry synchronized with the shared e2e state file.
 * registerTool/update/remove intentionally exercise the SDK's real list-changed notifications.
 */
function watchDynamicTool(server) {
  let lastRevision = -1;
  let registeredTool;

  const sync = () => {
    const state = readState();
    if (state.revision === lastRevision) {
      return;
    }
    lastRevision = state.revision;

    if (state.tool == null) {
      registeredTool?.remove();
      registeredTool = undefined;
      console.error(
        `[dynamic-mcp-tools] applied revision ${state.revision}: removed runtime_probe`,
      );
      return;
    }

    const paramsSchema = schemaForVersion(state.tool.schemaVersion);
    if (registeredTool) {
      registeredTool.update({
        description: state.tool.description,
        paramsSchema,
        callback: toolCallback,
      });
      console.error(
        `[dynamic-mcp-tools] applied revision ${state.revision}: updated runtime_probe`,
      );
      return;
    }

    registeredTool = server.registerTool(
      'runtime_probe',
      {
        description: state.tool.description,
        inputSchema: paramsSchema,
      },
      toolCallback,
    );
    console.error(`[dynamic-mcp-tools] applied revision ${state.revision}: added runtime_probe`);
  };

  sync();
  const timer = setInterval(() => {
    try {
      sync();
    } catch (error) {
      console.error('[dynamic-mcp-tools] failed to synchronize tool state', error);
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}

module.exports = {
  emptyState,
  getStatePath,
  resetState,
  watchDynamicTool,
  writeState,
};
