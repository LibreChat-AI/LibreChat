import type { TurnCodeInputs } from '../../../core';
import type { TurnServices } from '../host';

/** A send's code inputs with no code execution behind them, so no workspace is required. */
export const createTurnCodeInputs = (
  workspace: Partial<TurnCodeInputs['workspace']> = {},
  latest: TurnCodeInputs['latest'] = null,
): TurnCodeInputs => ({
  workspace: {
    conversation: null,
    canRunCode: false,
    configurationLoaded: true,
    recoveryPending: false,
    replacingDecision: false,
    statuses: {},
    getPreferredWorkspace: () => undefined,
    ...workspace,
  },
  approval: { conversation: null, reachable: { agents: [], complete: true } },
  latest,
});

/** Turn services with no app behind them: agents-only, no catalogs, and every effect a spy. */
export const createTurnServices = (overrides: Partial<TurnServices> = {}): TurnServices => ({
  logger: { log: jest.fn(), dir: jest.fn(), warn: jest.fn() },
  isTemporary: false,
  getEndpointsConfig: () => undefined,
  getEphemeralAgent: () => null,
  getUserKey: () => undefined,
  getRouteProjectId: () => null,
  readCodeInputs: () => createTurnCodeInputs(),
  openNewChat: jest.fn(),
  releaseFiles: jest.fn(),
  clearFilesToDelete: jest.fn(),
  ...overrides,
});
