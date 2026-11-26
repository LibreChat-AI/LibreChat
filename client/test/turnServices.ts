import type { TurnServices } from '@librechat/chat/react';

/** Turn services with no app behind them, for specs that mock `~/hooks/Chat/services` because
 *  they exercise the chat hooks without a router, query client or agent settings. */
export const createTestTurnServices = (): TurnServices => ({
  logger: { log: jest.fn(), dir: jest.fn(), warn: jest.fn() },
  isTemporary: false,
  getEndpointsConfig: () => undefined,
  getEphemeralAgent: () => null,
  getUserKey: () => undefined,
  getRouteProjectId: () => null,
  readCodeInputs: () => ({
    workspace: {
      conversation: null,
      canRunCode: false,
      configurationLoaded: true,
      recoveryPending: true,
      replacingDecision: false,
      statuses: {},
      getPreferredWorkspace: () => undefined,
    },
    approval: { conversation: null, reachable: { agents: [], complete: true } },
    latest: null,
  }),
  openNewChat: jest.fn(),
  releaseFiles: jest.fn(),
  clearFilesToDelete: jest.fn(),
});
