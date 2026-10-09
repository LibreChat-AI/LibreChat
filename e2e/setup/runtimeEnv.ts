import fs from 'fs';
import { getRuntimeEnvPath } from './env';

export function applyRuntimeEnv() {
  const runtimeEnvPath = getRuntimeEnvPath();

  if (!fs.existsSync(runtimeEnvPath)) {
    return;
  }

  const runtimeEnv = JSON.parse(fs.readFileSync(runtimeEnvPath, 'utf8')) as Record<
    string,
    string | undefined
  >;

  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value != null) {
      process.env[key] = value;
    }
  }
}
