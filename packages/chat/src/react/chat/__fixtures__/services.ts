import type { TurnServices } from '../host';

/** Turn services with no app behind them: agents-only, no catalogs, and every effect a spy. */
export const createTurnServices = (overrides: Partial<TurnServices> = {}): TurnServices => ({
  logger: { log: jest.fn(), dir: jest.fn(), warn: jest.fn() },
  isTemporary: false,
  getEndpointsConfig: () => undefined,
  getEphemeralAgent: () => null,
  getUserKey: () => undefined,
  getRouteProjectId: () => null,
  resolveCode: () => ({
    code: { approvalMode: undefined, environmentMode: undefined, workspaces: undefined },
    apply: (conversation) => conversation,
  }),
  openNewChat: jest.fn(),
  releaseFiles: jest.fn(),
  clearFilesToDelete: jest.fn(),
  ...overrides,
});
