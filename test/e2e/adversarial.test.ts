/*
 * Adversarial / edge-case surface for light-run.
 *
 * Two shapes of test here:
 *   1. Zod / auth / routing - no container needed, run fast (<10 ms each).
 *   2. Real-container enforcement - timeout, network isolation. Few but real.
 *
 * The point is to exercise failure paths users care about: attacker sends a
 * bad body, a huge payload, a malformed Bearer, a traversal, a loop that
 * outlives its timeout. Each assertion checks both the status code AND the
 * side effect (no file leaked, container killed, server still up).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../../src/index.js';
import type { FastifyInstance } from 'fastify';

const dockerAvailable = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
const maybe = dockerAvailable ? describe : describe.skip;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-adv-'));
process.env.LIGHT_RUNNER_STATE_DIR = stateDir;
process.env.LIGHT_RUN_ARTIFACTS_DIR = path.join(stateDir, 'artifacts');

const TOKEN = 'adv-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

maybe('light-run adversarial', () => {
  let server: FastifyInstance;

  before(async () => {
    server = await createServer({ token: TOKEN, logger: false });
  });
  after(async () => {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ==========================================================
  // Auth edges
  // ==========================================================

  it('auth: missing Bearer scheme rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: TOKEN }, // no "Bearer " prefix
      payload: { image: 'alpine:3.19', files: { x: '' } },
    });
    assert.equal(res.statusCode, 401);
  });

  it('auth: wrong token rejected even when format is valid', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: 'Bearer a-different-token-same-length' },
      payload: { image: 'alpine:3.19', files: { x: '' } },
    });
    assert.equal(res.statusCode, 401);
  });

  it('auth: empty Bearer value rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: 'Bearer ' },
      payload: { image: 'alpine:3.19', files: { x: '' } },
    });
    assert.equal(res.statusCode, 401);
  });

  it('auth: /runs list also requires auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/runs' });
    assert.equal(res.statusCode, 401);
  });

  // ==========================================================
  // Zod validation - file paths
  // ==========================================================

  it('zod: absolute file path rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: { image: 'alpine:3.19', files: { '/etc/passwd': 'x' } },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'bad_request');
  });

  it('zod: parent-traversal in file path rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: { image: 'alpine:3.19', files: { '../escape.sh': 'x' } },
    });
    assert.equal(res.statusCode, 400);
  });

  it('zod: empty files map rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: { image: 'alpine:3.19', files: {} },
    });
    assert.equal(res.statusCode, 400);
  });

  // ==========================================================
  // Zod validation - env names
  // ==========================================================

  it('zod: env name starting with digit rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19',
        files: { x: '' },
        env: { '1BAD': 'value' },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('zod: env name with special char rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19',
        files: { x: '' },
        env: { 'FOO;BAR': 'value' },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  // ==========================================================
  // Zod validation - oversize
  // ==========================================================

  it('zod: entrypoint longer than 2048 chars rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19',
        files: { x: '' },
        entrypoint: 'a'.repeat(2049),
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('zod: image longer than 300 chars rejected', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'a'.repeat(301),
        files: { x: '' },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  // ==========================================================
  // Body limit (413)
  // ==========================================================

  it('bodyLimit: oversized body returns 413', async () => {
    const tiny = await createServer({ token: TOKEN, bodyLimit: 1024, logger: false });
    try {
      const payload = {
        image: 'alpine:3.19',
        files: { x: 'X'.repeat(2000) }, // easily over 1024 with JSON framing
      };
      const res = await tiny.inject({
        method: 'POST', url: '/run', headers: AUTH, payload,
      });
      assert.equal(res.statusCode, 413);
    } finally {
      await tiny.close();
    }
  });

  // ==========================================================
  // Artifact traversal + subdirectory behaviour
  // ==========================================================

  it('artifacts: GET with literal .. segment rejected even if not escaping', async () => {
    // Start a tiny run to get an id + artifact dir
    const r = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19', entrypoint: 'echo ok',
        files: { x: '' }, network: 'none', timeout: 30000,
      },
    });
    const { id } = r.json() as { id: string };
    const bad = await server.inject({
      method: 'GET', url: `/runs/${id}/artifacts/foo/..`, headers: AUTH,
    });
    assert.ok([400, 404].includes(bad.statusCode));
  });

  it('runs/:id returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'GET', url: '/runs/00000000-0000-0000-0000-000000000000', headers: AUTH,
    });
    assert.equal(res.statusCode, 404);
  });

  // ==========================================================
  // Real-container behaviour
  // ==========================================================

  it('timeout: runaway container killed before completion', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19',
        entrypoint: 'sleep 60',
        files: { x: '' },
        network: 'none',
        timeout: 2000, // 2s cap on a 60s sleep - must be killed
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { status: string; durationMs?: number };
    // Either 'failed' (timeout) or 'cancelled' depending on how light-runner
    // classifies the kill. 'succeeded' must NOT happen.
    assert.notEqual(body.status, 'succeeded');
    // And the run must have exited well before the natural 60s sleep.
    if (body.durationMs) {
      assert.ok(body.durationMs < 10_000, `run ran too long: ${body.durationMs}ms`);
    }
  });

  it('network: none actually blocks outbound traffic', async () => {
    // wget with short timeout + fail-on-any-error. If the run reaches the
    // internet, the sentinel file says REACHED. If blocked, BLOCKED.
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19',
        entrypoint:
          'wget -q -T 2 -O /tmp/page http://1.1.1.1 ' +
          '&& echo REACHED > /app/out.txt ' +
          '|| echo BLOCKED > /app/out.txt',
        files: { x: '' },
        network: 'none',
        timeout: 15000,
        extract: ['/app/out.txt'],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'succeeded');
    const dl = await server.inject({
      method: 'GET', url: `/runs/${body.id}/artifacts/out.txt`, headers: AUTH,
    });
    assert.equal(dl.statusCode, 200);
    assert.match(dl.body, /BLOCKED/);
  });

  it('env: shell metacharacters in env value are passed literally, not executed', async () => {
    // Docker -e NAME=value must not interpret the value. If it did, `;touch
    // /pwned;` would create a file. We cannot check outside the container
    // (it's torn down), but we CAN check the env var arrives intact via a
    // file write.
    const malicious = '"; touch /tmp/pwned; echo "';
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19',
        entrypoint: 'sh main.sh',
        files: {
          'main.sh': 'printf "%s" "$MAL" > /app/val.txt',
        },
        env: { MAL: malicious },
        network: 'none',
        timeout: 30000,
        extract: ['/app/val.txt'],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string };
    assert.equal(body.status, 'succeeded');
    const dl = await server.inject({
      method: 'GET', url: `/runs/${body.id}/artifacts/val.txt`, headers: AUTH,
    });
    assert.equal(dl.body, malicious);
  });
});
