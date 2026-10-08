import type { HookRegistry } from '@librechat/agents';
import type { PluginHookRuntimeContext } from './runtime';

export interface PluginHookSourceOptions {
  registry: HookRegistry;
  context?: PluginHookRuntimeContext;
  /** Whether the run can raise resumable `ask` interrupts (HITL wiring attached). */
  askDecisionSupported?: boolean;
}

/**
 * Host-supplied provider of plugin hooks for agent runs. Keeps the dependency
 * direction one-way: the run seam reads hooks through this seam while the
 * plugins package (which imports agents code) registers the implementation at
 * startup — mirroring the tool-approval hook registry pattern.
 */
export interface PluginHookSource {
  hasHooks(): boolean;
  /** Whether a ready deployment hook can participate in tool-approval decisions. */
  hasToolApprovalHooks?(toolNames?: readonly string[]): boolean;
  register(options: PluginHookSourceOptions): number;
}

let source: PluginHookSource | undefined;

export function setPluginHookSource(next: PluginHookSource | undefined): void {
  source = next;
}

export function getPluginHookSource(): PluginHookSource | undefined {
  return source;
}
