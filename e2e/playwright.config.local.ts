import { PlaywrightTestConfig } from '@playwright/test';
import mainConfig from './playwright.config';
import { getLocalE2EEnv } from './setup/env';
import path from 'path';
const rootPath = path.resolve(__dirname, '..');
const serverPath = path.resolve(rootPath, 'e2e/setup/start-server.js');
import dotenv from 'dotenv';
dotenv.config();

const e2eEnv = getLocalE2EEnv();
Object.assign(process.env, e2eEnv);

const config: PlaywrightTestConfig = {
  ...mainConfig,
  retries: 0,
  globalSetup: require.resolve('./setup/global-setup.local'),
  globalTeardown: require.resolve('./setup/global-teardown.local'),
  webServer: {
    ...mainConfig.webServer,
    command: `node ${serverPath}`,
    cwd: rootPath,
  },
  fullyParallel: false, // if you are on Windows, keep this as `false`. On a Mac, `true` could make tests faster (maybe on some Windows too, just try)
  // workers: 1,
  // testMatch: /messages/,
  // retries: 0,
};

export default config;
