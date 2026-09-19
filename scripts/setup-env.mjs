#!/usr/bin/env node
/**
 * `pnpm setup:env` — make a working `.env` on a fresh clone.
 *
 * Two jobs, both idempotent:
 *   1. If `.env` does not exist, copy `.env.example` over it.
 *   2. Fill any secret whose value is still empty with fresh randomness.
 *
 * It never overwrites a value that is already set, so running it twice cannot invalidate
 * everyone's session cookies or point the app at a different database. The alternative —
 * a committed default secret — is how placeholder keys end up in production.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(repoRoot, '.env');
const examplePath = resolve(repoRoot, '.env.example');

/** Keys this script is allowed to invent a value for, and how many bytes each needs. */
const GENERATED_KEYS = {
  // 48 bytes -> 64 base64url characters, comfortably over the 32-character minimum.
  SESSION_SECRET: { bytes: 48, encoding: 'base64url' },
  // Exactly 32 bytes: AES-256. Plain base64 rather than base64url because that is what
  // `openssl rand -base64 32` and most secret managers emit, and config.ts decodes both.
  MFA_ENCRYPTION_KEY: { bytes: 32, encoding: 'base64' },
};

function randomSecret({ bytes, encoding }) {
  return randomBytes(bytes).toString(encoding);
}

if (!existsSync(examplePath)) {
  console.error('No .env.example found; nothing to copy from.');
  process.exit(1);
}

let created = false;
if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  created = true;
}

const original = readFileSync(envPath, 'utf8');
const filled = [];
const missing = [];

let contents = original;
for (const [key, spec] of Object.entries(GENERATED_KEYS)) {
  // Matches `KEY=` with nothing (or only whitespace) after it, anywhere in the file.
  const empty = new RegExp(`^(${key}=)[ \\t]*$`, 'm');
  if (empty.test(contents)) {
    contents = contents.replace(empty, `$1${randomSecret(spec)}`);
    filled.push(key);
  } else if (!new RegExp(`^${key}=`, 'm').test(contents)) {
    // The key is absent entirely (an older .env from before this milestone): append it
    // rather than rewriting the file, so hand-edited values and comments survive.
    contents += `${contents.endsWith('\n') ? '' : '\n'}${key}=${randomSecret(spec)}\n`;
    missing.push(key);
  }
}

if (contents !== original) writeFileSync(envPath, contents);

if (created) console.log('Created .env from .env.example.');
if (filled.length > 0) console.log(`Generated a value for: ${filled.join(', ')}`);
if (missing.length > 0) console.log(`Appended missing key(s): ${missing.join(', ')}`);
if (!created && filled.length === 0 && missing.length === 0) {
  console.log('.env already has every generated secret; nothing to do.');
}
