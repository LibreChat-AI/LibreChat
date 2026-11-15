import api from './jest.config.mjs';
import gateway from '../channel-gateway/jest.config.mjs';

// Ignore only dependencies ignored by both workspaces. The native runtime uses Node's ESM graph.
export default {
  ...api,
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.discord.integration.spec.ts'],
  transformIgnorePatterns: [
    [...api.transformIgnorePatterns, ...gateway.transformIgnorePatterns]
      .map((pattern) => `(?=${pattern})`)
      .join(''),
  ],
};
