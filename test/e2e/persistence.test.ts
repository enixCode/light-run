import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../../src/index.js';
import { readState } from 'light-runner';
import type { FastifyInstance } from 'fastify';

const dockerAvailable = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
const maybe = dockerAvailable ? describe : describe.skip;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-persist-'));
process.env.LIGHT_RUNNER_STATE_DIR = stateDir;
process.env.LIGHT_RUN_ARTIFACTS_DIR = path.join(stateDir, 'artifacts');

const TOKEN = 'test-token-12345';
const AUTH = { authorization: `Bearer ${TOKEN}` };

maybe('light-run state persistence (light-runner as source of truth)', () => {
  let server: FastifyInstance;

  before(async () => {
    server = await createServer({ token: TOKEN, logger: false });
  });

  after(async () => {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const runSync = async (tag: string): Promise<{ id: string; status: string }> => {
    const res = await server.inject({
      method: 'POST', url: '/run', headers: AUTH,
      payload: {
        image: 'alpine:3.19', entrypoint: `echo ${tag}`,
        files: { x: '' }, networks: ['none'], timeout: 30000,
      },
    });
    assert.equal(res.statusCode, 200);
    return res.json() as { id: string; status: string };
  };

  it('run id is the light-runner container name, not a UUID', async () => {
    const { id } = await runSync('id-shape');
    assert.match(id, /^light-runner-[0-9a-f]{12}$/);
  });

  it('GET /runs/:id is served from the light-runner state dir', async () => {
    const { id } = await runSync('from-disk');

    // The run must exist on disk as a light-runner state file.
    const onDisk = readState(id);
    assert.ok(onDisk, 'state file should exist');
    assert.equal(onDisk.id, id);
    assert.equal(onDisk.status, 'exited');
    assert.equal(onDisk.exitCode, 0);

    // The HTTP projection maps the disk state to the HTTP status.
    const g = await server.inject({ method: 'GET', url: `/runs/${id}`, headers: AUTH });
    assert.equal(g.statusCode, 200);
    const state = g.json() as { id: string; status: string; exitCode: number };
    assert.equal(state.id, id);
    assert.equal(state.status, 'succeeded');
    assert.equal(state.exitCode, 0);
  });

  it('a fresh server instance recovers runs from disk (restart proxy)', async () => {
    const { id } = await runSync('restart');

    // A brand-new server instance has never tracked this run in its own
    // request flow; it can only know it by reading the state dir.
    const server2 = await createServer({ token: TOKEN, logger: false });
    try {
      const g = await server2.inject({ method: 'GET', url: `/runs/${id}`, headers: AUTH });
      assert.equal(g.statusCode, 200);
      assert.equal((g.json() as { id: string }).id, id);

      const list = await server2.inject({ method: 'GET', url: '/runs', headers: AUTH });
      const ids = (list.json() as { id: string }[]).map((r) => r.id);
      assert.ok(ids.includes(id), 'restarted server should list the run');
    } finally {
      await server2.close();
    }
  });

  it('DELETE removes the state file (deleteState is wired)', async () => {
    const { id } = await runSync('delete');
    assert.ok(readState(id), 'precondition: state exists');

    const del = await server.inject({ method: 'DELETE', url: `/runs/${id}`, headers: AUTH });
    assert.equal(del.statusCode, 204);

    assert.equal(readState(id), null, 'state file should be gone');
    const g = await server.inject({ method: 'GET', url: `/runs/${id}`, headers: AUTH });
    assert.equal(g.statusCode, 404);
  });

  it('GET /runs lists finished runs from the state dir', async () => {
    const { id } = await runSync('list');
    const res = await server.inject({ method: 'GET', url: '/runs', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const list = res.json() as { id: string; status: string }[];
    const found = list.find((r) => r.id === id);
    assert.ok(found, 'the run should appear in the list');
    assert.equal(found.status, 'succeeded');
  });
});
