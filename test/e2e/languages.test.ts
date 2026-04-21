/*
 * Multi-language + real-functionality tests.
 *
 * Every test in this file spawns a real Docker container through light-runner
 * and asserts on actual container output (artifacts), not just exit code. The
 * point is to catch regressions in the wrapper's file-seeding, stdin plumbing,
 * env pass-through, workdir, setup chaining, and artifact extraction - the
 * things a unit test cannot see.
 *
 * Image mix kept deliberately small: alpine:3.19 (already warm), python:3.12-
 * alpine (~45 MB), node:22-alpine (~150 MB). First CI run eats the pulls, all
 * subsequent tests are cache hits.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../../src/index.js';
import type { FastifyInstance } from 'fastify';

const dockerAvailable = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
const maybe = dockerAvailable ? describe : describe.skip;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-lang-'));
process.env.LIGHT_RUNNER_STATE_DIR = stateDir;
process.env.LIGHT_RUN_ARTIFACTS_DIR = path.join(stateDir, 'artifacts');

const TOKEN = 'lang-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function postRun(server: FastifyInstance, payload: Record<string, unknown>) {
  return server.inject({ method: 'POST', url: '/run', headers: AUTH, payload });
}

async function fetchArtifact(server: FastifyInstance, id: string, rel: string): Promise<string> {
  const r = await server.inject({
    method: 'GET', url: `/runs/${id}/artifacts/${rel}`, headers: AUTH,
  });
  assert.equal(r.statusCode, 200, `expected 200 for ${rel}, got ${r.statusCode}`);
  return r.body;
}

maybe('light-run multi-language + functional', () => {
  let server: FastifyInstance;

  before(async () => {
    server = await createServer({ token: TOKEN, logger: false });
  });
  after(async () => {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ---------- Python: stdin -> JSON compute -> artifact ----------

  it('python: reads stdin JSON, computes, writes artifact', async () => {
    const res = await postRun(server, {
      image: 'python:3.12-alpine',
      entrypoint: 'python main.py',
      files: {
        'main.py': [
          'import json, sys',
          'data = json.load(sys.stdin)',
          'result = {"sum": sum(data["nums"]), "count": len(data["nums"])}',
          'with open("/app/out.json", "w") as f:',
          '    json.dump(result, f)',
        ].join('\n'),
      },
      input: { nums: [1, 2, 3, 4, 5, 6, 7] },
      extract: ['/app/out.json'],
      network: 'none',
      timeout: 60000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string; exitCode: number };
    assert.equal(body.status, 'succeeded');
    assert.equal(body.exitCode, 0);
    const out = await fetchArtifact(server, body.id, 'out.json');
    assert.deepEqual(JSON.parse(out), { sum: 28, count: 7 });
  });

  // ---------- Python: multi-file, local module import ----------

  it('python: multi-file project, imports local helper', async () => {
    const res = await postRun(server, {
      image: 'python:3.12-alpine',
      entrypoint: 'python main.py',
      files: {
        'main.py': 'from helper import greet\nopen("/app/g.txt","w").write(greet("world"))',
        'helper.py': 'def greet(name):\n    return f"hello, {name}!"',
      },
      extract: ['/app/g.txt'],
      network: 'none',
      timeout: 60000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'succeeded');
    const out = await fetchArtifact(server, body.id, 'g.txt');
    assert.equal(out, 'hello, world!');
  });

  // ---------- Node: crypto hash ----------

  it('node: runs Node.js, computes sha256 deterministically', async () => {
    const res = await postRun(server, {
      image: 'node:22-alpine',
      entrypoint: 'node main.js',
      files: {
        'main.js': [
          'const crypto = require("crypto");',
          'const fs = require("fs");',
          'const h = crypto.createHash("sha256").update("light-run").digest("hex");',
          'fs.writeFileSync("/app/hash.txt", h);',
        ].join('\n'),
      },
      extract: ['/app/hash.txt'],
      network: 'none',
      timeout: 60000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'succeeded');
    const out = await fetchArtifact(server, body.id, 'hash.txt');
    const expected = crypto.createHash('sha256').update('light-run').digest('hex');
    assert.equal(out.trim(), expected);
  });

  // ---------- env vars pass through ----------

  it('env: custom env vars reach the container', async () => {
    const res = await postRun(server, {
      image: 'alpine:3.19',
      entrypoint: 'sh main.sh',
      files: {
        'main.sh': 'printf "%s|%s" "$FOO" "$BAR" > /app/env.txt',
      },
      env: { FOO: 'one', BAR: 'two-value' },
      extract: ['/app/env.txt'],
      network: 'none',
      timeout: 30000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'succeeded');
    const out = await fetchArtifact(server, body.id, 'env.txt');
    assert.equal(out, 'one|two-value');
  });

  // ---------- setup commands chained with && ----------

  it('setup: pre-commands run before entrypoint', async () => {
    const res = await postRun(server, {
      image: 'alpine:3.19',
      setup: [
        'echo "step1" >> /app/log.txt',
        'echo "step2" >> /app/log.txt',
      ],
      entrypoint: 'echo "main" >> /app/log.txt',
      files: { 'x': '' },
      extract: ['/app/log.txt'],
      network: 'none',
      timeout: 30000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'succeeded');
    const out = await fetchArtifact(server, body.id, 'log.txt');
    assert.equal(out, 'step1\nstep2\nmain\n');
  });

  // ---------- nested artifact directory ----------

  it('extract: directory with nested files is walked recursively', async () => {
    const res = await postRun(server, {
      image: 'alpine:3.19',
      entrypoint: 'sh main.sh',
      files: {
        'main.sh': [
          'mkdir -p /app/out/sub/deeper',
          'echo aaa > /app/out/top.txt',
          'echo bbb > /app/out/sub/mid.txt',
          'echo ccc > /app/out/sub/deeper/bottom.txt',
        ].join('\n'),
      },
      extract: ['/app/out'],
      network: 'none',
      timeout: 30000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      id: string; artifacts: { path: string; type: string }[];
    };
    const paths = body.artifacts.map((a) => a.path).sort();
    // Every file + every traversed directory must be listed
    assert.ok(paths.some((p) => p.endsWith('top.txt')), `top.txt missing: ${paths.join(',')}`);
    assert.ok(paths.some((p) => p.endsWith('mid.txt')));
    assert.ok(paths.some((p) => p.endsWith('bottom.txt')));

    // Download the deepest leaf, verify content
    const deepest = paths.find((p) => p.endsWith('bottom.txt'))!;
    const out = await fetchArtifact(server, body.id, deepest);
    assert.equal(out.trim(), 'ccc');
  });

  // ---------- large binary artifact ----------

  it('extract: multi-MB binary artifact streams correctly', async () => {
    const res = await postRun(server, {
      image: 'alpine:3.19',
      entrypoint: 'dd if=/dev/urandom of=/app/big.bin bs=1M count=3 2>/dev/null',
      files: { 'x': '' },
      extract: ['/app/big.bin'],
      network: 'none',
      timeout: 60000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      id: string; artifacts: { path: string; bytes: number }[];
    };
    const big = body.artifacts.find((a) => a.path.endsWith('big.bin'))!;
    assert.ok(big, 'big.bin should be in artifacts');
    assert.ok(big.bytes >= 3 * 1024 * 1024, `expected >=3 MiB, got ${big.bytes}`);
  });

  // ---------- unicode content round-trip ----------

  it('unicode: non-ASCII file content round-trips through tmpdir + extract', async () => {
    const contents = 'Hello, Monde! Japanese characters and a multi-byte line.';
    const res = await postRun(server, {
      image: 'alpine:3.19',
      entrypoint: 'cp in.txt /app/out.txt',
      files: { 'in.txt': contents },
      extract: ['/app/out.txt'],
      network: 'none',
      timeout: 30000,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'succeeded');
    const out = await fetchArtifact(server, body.id, 'out.txt');
    assert.equal(out, contents);
  });
});
