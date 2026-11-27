import { KeyvFile } from 'keyv-file';

export const logFile: KeyvFile = new KeyvFile({ filename: './data/logs.json' }).setMaxListeners(20);
export const violationFile: KeyvFile = new KeyvFile({
  filename: './data/violations.json',
}).setMaxListeners(20);
