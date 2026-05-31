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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-lifecycle-'));
process.env.LIGHT_RUNNER_STATE_DIR = stateDir;
process.env.LIGHT_RUN_ARTIFACTS_DIR = path.join(stateDir, 'artifacts');

const TOKEN = 'test-token-12345';
const AUTH = { authorization: `Bearer ${TOKEN}` };

maybe('light-run run lifecycle', () => {
  let server: FastifyInstance;

  before(async () => {
    server = await createServer({ token: TOKEN, logger: false });
  });

  after(async () => {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // Start a long-lived detached run and wait until it is actually running.
  const startLiveRun = async (): Promise<string> => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: AUTH,
      payload: {
        image: 'alpine:3.19', entrypoint: 'sleep 60',
        files: { 'x': '' }, networks: ['none'], timeout: 120000, detached: true,
      },
    });
    assert.equal(res.statusCode, 202);
    const { id } = res.json() as { id: string };
    // seed + docker run -d takes a few seconds on Docker Desktop Windows.
    await new Promise((r) => setTimeout(r, 4000));
    return id;
  };

  // --- real health ---

  it('GET /health pings Docker and reports docker:true', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { status: string; docker: boolean };
    assert.equal(body.status, 'ok');
    assert.equal(body.docker, true);
  });

  // --- pause / resume / stop on a live run ---

  it('pause then resume then stop a running detached run', async () => {
    const id = await startLiveRun();

    const pause = await server.inject({ method: 'POST', url: `/runs/${id}/pause`, headers: AUTH });
    assert.equal(pause.statusCode, 204);

    const resume = await server.inject({ method: 'POST', url: `/runs/${id}/resume`, headers: AUTH });
    assert.equal(resume.statusCode, 204);

    const stop = await server.inject({
      method: 'POST', url: `/runs/${id}/stop`, headers: AUTH,
      payload: { grace: 1000 },
    });
    assert.equal(stop.statusCode, 204);

    // After a graceful stop the run leaves the running state.
    const deadline = Date.now() + 30000;
    let state: { status: string } | undefined;
    while (Date.now() < deadline) {
      const g = await server.inject({ method: 'GET', url: `/runs/${id}`, headers: AUTH });
      state = g.json() as { status: string };
      if (state.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.notEqual(state?.status, 'running');
  });

  // --- 404 on unknown ids ---

  it('stop unknown id returns 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/runs/nope/stop', headers: AUTH });
    assert.equal(res.statusCode, 404);
  });

  it('pause unknown id returns 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/runs/nope/pause', headers: AUTH });
    assert.equal(res.statusCode, 404);
  });

  it('resume unknown id returns 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/runs/nope/resume', headers: AUTH });
    assert.equal(res.statusCode, 404);
  });

  // --- invalid stop body ---

  it('stop with a negative grace returns 400', async () => {
    const id = await startLiveRun();
    const res = await server.inject({
      method: 'POST', url: `/runs/${id}/stop`, headers: AUTH,
      payload: { grace: -1 },
    });
    assert.equal(res.statusCode, 400);
    // cleanup: kill the still-running container
    await server.inject({ method: 'POST', url: `/runs/${id}/cancel`, headers: AUTH });
  });

  // --- auth ---

  it('lifecycle route without Bearer returns 401', async () => {
    const res = await server.inject({ method: 'POST', url: '/runs/whatever/stop' });
    assert.equal(res.statusCode, 401);
  });

  // --- finished run is no longer controllable ---

  it('stop a finished run returns 404', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: AUTH,
      payload: {
        image: 'alpine:3.19', entrypoint: 'echo done',
        files: { 'x': '' }, networks: ['none'], timeout: 30000,
      },
    });
    assert.equal(res.statusCode, 200);
    const { id } = res.json() as { id: string };

    const stop = await server.inject({ method: 'POST', url: `/runs/${id}/stop`, headers: AUTH });
    assert.equal(stop.statusCode, 404);
  });
});
