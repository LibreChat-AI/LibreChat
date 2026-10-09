import fs from 'fs';
import type { PluginDiagnostic, PluginHookContribution } from './types';
import type { PluginHookCapabilities } from '~/agents/hooks';
import { EXTENSION_HOOKS_FILE, LIBRECHAT_EXTENSION_NAMESPACE } from './constants';
import { parsePluginHooks, planPluginHooks } from '~/agents/hooks';
import { resolveWithinRoot } from './paths';

export interface PluginHooksResult {
  hooks?: PluginHookContribution;
  diagnostics: PluginDiagnostic[];
}

/**
 * Reports a package that declares hooks when the host has registered no hook
 * capabilities (execution not opted into via `DEPLOYMENT_PLUGIN_HOOKS`).
 * Silently ignoring the document would leave an operator believing it runs.
 */
export async function reportUnexecutedHooks(realRoot: string): Promise<PluginDiagnostic[]> {
  const location = `${LIBRECHAT_EXTENSION_NAMESPACE}/${EXTENSION_HOOKS_FILE}`;
  const hooksPath = await resolveWithinRoot(realRoot, location);
  if (hooksPath === null) {
    return [];
  }
  try {
    await fs.promises.access(hooksPath);
  } catch {
    return [];
  }
  return [
    {
      code: 'hooks_unsupported',
      severity: 'warning',
      message:
        'This plugin declares hooks, but plugin hook execution is disabled; set DEPLOYMENT_PLUGIN_HOOKS=true to run them. The document was ignored',
      location,
    },
  ];
}

/**
 * Hooks are outside the portable Agent Plugins v1 format, so LibreChat reads
 * them from its own extension directory (§8.2). Absence is normal; a malformed
 * document disables only this plugin's hooks.
 */
export async function loadPluginHooks(
  realRoot: string,
  capabilities: PluginHookCapabilities,
): Promise<PluginHooksResult> {
  const location = `${LIBRECHAT_EXTENSION_NAMESPACE}/${EXTENSION_HOOKS_FILE}`;
  const hooksPath = await resolveWithinRoot(realRoot, location);
  if (hooksPath === null) {
    return {
      diagnostics: [
        {
          code: 'path_escape',
          severity: 'warning',
          message: 'The extension hooks document resolves outside the plugin root',
          location,
        },
      ],
    };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(hooksPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { diagnostics: [] };
    }
    return {
      diagnostics: [
        {
          code: 'hooks_invalid',
          severity: 'warning',
          message: `Extension hooks document could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
          location,
        },
      ],
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return {
      diagnostics: [
        {
          code: 'hooks_invalid',
          severity: 'warning',
          message: `Extension hooks document is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          location,
        },
      ],
    };
  }

  const parsed = parsePluginHooks(document);
  if (!parsed.success) {
    return {
      diagnostics: [
        {
          code: 'hooks_invalid',
          severity: 'warning',
          message: parsed.issues
            .map((issue) => `${issue.path || 'hooks'}: ${issue.message}`)
            .join('; '),
          location,
        },
      ],
    };
  }

  const plan = planPluginHooks(parsed.document, capabilities);
  const diagnostics: PluginDiagnostic[] = [];
  if (plan.summary.unsupported > 0) {
    diagnostics.push({
      code: 'hooks_unsupported',
      severity: 'warning',
      message: `${plan.summary.unsupported} of ${plan.summary.declared} hook declaration(s) are unsupported and will not run`,
      location,
    });
  }

  return { hooks: { plan, document: parsed.document, location }, diagnostics };
}
