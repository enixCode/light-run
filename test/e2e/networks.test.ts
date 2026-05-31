import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../../src/index.js';
import { deleteNetwork } from '../../src/networks.js';
import type { FastifyInstance } from 'fastify';

const dockerAvailable = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
const maybe = dockerAvailable ? describe : describe.skip;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-networks-'));
process.env.LIGHT_RUNNER_STATE_DIR = stateDir;
process.env.LIGHT_RUN_ARTIFACTS_DIR = path.join(stateDir, 'artifacts');

const TOKEN = 'test-token-12345';
const AUTH = { authorization: `Bearer ${TOKEN}` };

maybe('light-run network CRUD', () => {
  let server: FastifyInstance;
  // Track every network created so we can guarantee no orphans are left on the
  // host daemon, even if an assertion fails mid-test.
  const created: string[] = [];

  const uniqueName = (tag: string): string => {
    const n = `light-runner-test-${tag}-${created.length}-${process.pid}`;
    created.push(n);
    return n;
  };

  before(async () => {
    server = await createServer({ token: TOKEN, logger: false });
  });

  after(async () => {
    await server.close();
    for (const n of created) {
      try { await deleteNetwork(n); } catch { /* already gone */ }
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('create then exists then delete round-trip', async () => {
    const name = uniqueName('roundtrip');

    const create = await server.inject({
      method: 'POST', url: '/networks', headers: AUTH, payload: { name },
    });
    assert.equal(create.statusCode, 201);
    const created1 = create.json() as { name: string; created: boolean };
    assert.equal(created1.name, name);
    assert.equal(created1.created, true);

    const exists = await server.inject({
      method: 'GET', url: `/networks/${name}`, headers: AUTH,
    });
    assert.equal(exists.statusCode, 200);
    assert.deepEqual(exists.json(), { name, exists: true });

    const del = await server.inject({
      method: 'DELETE', url: `/networks/${name}`, headers: AUTH,
    });
    assert.equal(del.statusCode, 204);

    const gone = await server.inject({
      method: 'GET', url: `/networks/${name}`, headers: AUTH,
    });
    assert.deepEqual(gone.json(), { name, exists: false });
  });

  it('create is idempotent (second create still 201, created true)', async () => {
    const name = uniqueName('idem');
    const a = await server.inject({ method: 'POST', url: '/networks', headers: AUTH, payload: { name } });
    assert.equal(a.statusCode, 201);
    const b = await server.inject({ method: 'POST', url: '/networks', headers: AUTH, payload: { name } });
    assert.equal(b.statusCode, 201);
    assert.equal((b.json() as { created: boolean }).created, true);
    await server.inject({ method: 'DELETE', url: `/networks/${name}`, headers: AUTH });
  });

  it('create with an IPAM subnet', async () => {
    const name = uniqueName('ipam');
    const res = await server.inject({
      method: 'POST', url: '/networks', headers: AUTH,
      payload: { name, ipam: { subnet: '100.64.231.0/24' } },
    });
    assert.equal(res.statusCode, 201);
    assert.equal((res.json() as { created: boolean }).created, true);
    await server.inject({ method: 'DELETE', url: `/networks/${name}`, headers: AUTH });
  });

  it('create with a missing name returns 400', async () => {
    const res = await server.inject({
      method: 'POST', url: '/networks', headers: AUTH, payload: { driver: 'bridge' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('exists on an unknown network returns exists:false', async () => {
    const res = await server.inject({
      method: 'GET', url: '/networks/light-runner-test-does-not-exist-xyz', headers: AUTH,
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { exists: boolean }).exists, false);
  });

  it('delete on an unknown network is idempotent (204)', async () => {
    const res = await server.inject({
      method: 'DELETE', url: '/networks/light-runner-test-never-created-xyz', headers: AUTH,
    });
    assert.equal(res.statusCode, 204);
  });

  it('POST /networks without Bearer returns 401', async () => {
    const res = await server.inject({
      method: 'POST', url: '/networks', payload: { name: 'whatever' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /networks/cleanup returns a removed count', async () => {
    const res = await server.inject({
      method: 'POST', url: '/networks/cleanup', headers: AUTH, payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { removed: number };
    assert.equal(typeof body.removed, 'number');
    assert.ok(body.removed >= 0);
  });
});
