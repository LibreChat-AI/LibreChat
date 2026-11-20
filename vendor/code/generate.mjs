import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const sourceUrl = new URL('./browser-enrollment-protocol.ts', import.meta.url);
const metadata = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(sourceUrl, 'utf8');
if (createHash('sha256').update(source).digest('hex') !== metadata.librechatUpstream.sha256) {
  throw new Error('Pinned upstream protocol integrity check failed');
}
const javascript = stripTypeScriptTypes(source).replace(/[ \t]+$/gm, '');
fs.writeFileSync(new URL('./browser-enrollment-protocol.js', import.meta.url), javascript);
