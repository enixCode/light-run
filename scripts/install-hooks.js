#!/usr/bin/env node
/*
 * Copies git hooks from scripts/hooks/ into .git/hooks/ and marks them
 * executable. Cross-platform (Node fs), no bash dependency.
 *
 * Run via: npm run setup:hooks
 *
 * Why not husky: husky = one more runtime dep, one more magic layer. This
 * repo is small and solo-dev. A 30-line Node script copies files once and
 * we move on. If we ever go multi-contributor with complex hook needs,
 * swap to husky then.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const src = path.join(here, 'hooks');
const dst = path.join(repoRoot, '.git', 'hooks');

if (!fs.existsSync(path.join(repoRoot, '.git'))) {
  console.error('[install-hooks] No .git directory found. Run this inside a git checkout.');
  process.exit(1);
}

fs.mkdirSync(dst, { recursive: true });

let installed = 0;
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  const to = path.join(dst, name);
  fs.copyFileSync(from, to);
  // Git on Windows respects the executable bit only if core.fileMode is set,
  // but chmod is harmless on Windows and required on POSIX.
  try {
    fs.chmodSync(to, 0o755);
  } catch {
    // Best-effort: some Windows filesystems reject chmod; git still runs the hook.
  }
  console.log(`[install-hooks] ${name} -> .git/hooks/${name}`);
  installed += 1;
}

console.log(`[install-hooks] installed ${installed} hook(s).`);
