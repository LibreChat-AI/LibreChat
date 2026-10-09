#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  if (!process.argv[index].startsWith('--')) continue;
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
  index += 1;
}

const baseDir = args.get('base-dir');
const currentDir = args.get('current-dir');
if (!baseDir || !currentDir) {
  console.error('Usage: merge-locize-download.mjs --base-dir <path> --current-dir <path>');
  process.exit(2);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function leafCount(value) {
  if (!isObject(value)) return 1;
  return Object.values(value).reduce((count, child) => count + leafCount(child), 0);
}

function mergeValues(base, current) {
  if (!isObject(base) || !isObject(current)) return { value: current, restored: 0 };

  let restored = 0;
  const value = {};
  for (const [key, baseValue] of Object.entries(base)) {
    if (!Object.hasOwn(current, key)) {
      value[key] = baseValue;
      restored += leafCount(baseValue);
      continue;
    }
    const merged = mergeValues(baseValue, current[key]);
    value[key] = merged.value;
    restored += merged.restored;
  }

  for (const [key, currentValue] of Object.entries(current)) {
    if (!Object.hasOwn(base, key)) value[key] = currentValue;
  }

  return { value, restored };
}

async function jsonFiles(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await jsonFiles(directory, entryRelative)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryRelative);
  }
  return files;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

let restored = 0;
let changedFiles = 0;
for (const relative of await jsonFiles(baseDir)) {
  const basePath = path.join(baseDir, relative);
  const currentPath = path.join(currentDir, relative);
  const base = await readJson(basePath);
  let current;
  try {
    current = await readJson(currentPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    current = {};
  }

  const merged = mergeValues(base, current);
  if (merged.restored === 0) continue;
  await mkdir(path.dirname(currentPath), { recursive: true });
  await writeFile(currentPath, `${JSON.stringify(merged.value, null, 2)}\n`);
  restored += merged.restored;
  changedFiles += 1;
}

console.log(`Preserved ${restored} repository translation value(s) across ${changedFiles} file(s).`);
