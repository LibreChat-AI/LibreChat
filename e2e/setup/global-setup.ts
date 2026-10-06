import { FullConfig } from '@playwright/test';
import { writeUploadFixtures } from './uploads';
import authenticate from './authenticate';
import { getE2EUser } from './user';

async function globalSetup(config: FullConfig) {
  writeUploadFixtures();
  await authenticate(config, getE2EUser());
}

export default globalSetup;
