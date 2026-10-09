#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
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
  console.error('Usage: validate-locize-download.mjs --base-dir <path> --current-dir <path>');
  process.exit(2);
}

const errors = [];
const placeholderPattern = /\{\{[^{}]+\}\}|\{[^{}]+\}|%[-+0-9.#]*[a-zA-Z]/g;

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

async function loadJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function flatten(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output);
    }
  } else if (prefix) {
    output.set(prefix, value);
  }
  return output;
}

function placeholders(value) {
  return (value.match(placeholderPattern) ?? []).sort().join('\u0000');
}

function boundaryWhitespace(value) {
  return [value.match(/^\s*/u)?.[0] ?? '', value.match(/\s*$/u)?.[0] ?? ''].join('\u0000');
}

function compareFile(relative, base, current) {
  const baseValues = flatten(base);
  const currentValues = flatten(current);
  for (const [key] of baseValues) {
    if (!currentValues.has(key)) {
      errors.push(`${relative}: deleted key ${key}`);
    }
  }
}

const [baseFiles, currentFiles] = await Promise.all([jsonFiles(baseDir), jsonFiles(currentDir)]);
const baseSet = new Set(baseFiles);
const currentSet = new Set(currentFiles);
const baselineValuesByFile = new Map();
for (const relative of baseFiles) {
  if (!currentSet.has(relative)) {
    errors.push(`deleted file ${relative}`);
    continue;
  }
  const [base, current] = await Promise.all([
    loadJson(path.join(baseDir, relative), `baseline/${relative}`),
    loadJson(path.join(currentDir, relative), `download/${relative}`),
  ]);
  if (base !== null && current !== null) {
    baselineValuesByFile.set(relative, flatten(base));
    compareFile(relative, base, current);
  }
}

const englishRelative = path.join('en', 'translation.json');
if (currentSet.has(englishRelative)) {
  const english = await loadJson(path.join(currentDir, englishRelative), `download/${englishRelative}`);
  if (english !== null) {
    const englishValues = flatten(english);
    for (const relative of currentFiles) {
      if (relative === englishRelative) continue;
      const locale = await loadJson(path.join(currentDir, relative), `download/${relative}`);
      if (locale === null) continue;
      for (const [key, value] of flatten(locale)) {
        const source = englishValues.get(key);
        const baseline = baselineValuesByFile.get(relative)?.get(key);
        const changedSinceBaseline = baseline === undefined || baseline !== value;
        if (changedSinceBaseline && typeof source === 'string' && typeof value === 'string') {
          if (placeholders(source) !== placeholders(value)) {
            errors.push(`${relative}: placeholder mismatch with English for ${key}`);
          }
          if (value !== value.trim() && boundaryWhitespace(source) !== boundaryWhitespace(value)) {
            errors.push(`${relative}: introduced leading/trailing whitespace for ${key}`);
          }
        }
      }
    }
  }
} else {
  errors.push(`missing required source file ${englishRelative}`);
}

if (errors.length > 0) {
  console.error(`Locize translation validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Locize translation validation passed (${baseSet.size} baseline JSON files checked).`);
