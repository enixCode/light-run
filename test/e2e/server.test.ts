import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createServer } from '../../src/index.js';
import type { FastifyInstance } from 'fastify';

const dockerAvailable = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
const maybe = dockerAvailable ? describe : describe.skip;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-test-'));
process.env.LIGHT_RUNNER_STATE_DIR = stateDir;
process.env.LIGHT_RUN_ARTIFACTS_DIR = path.join(stateDir, 'artifacts');

const TOKEN = 'test-token-12345';

maybe('light-run server', () => {
  let server: FastifyInstance;

  before(async () => {
    server = await createServer({ token: TOKEN, logger: false });
  });

  after(async () => {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // --- auth + health ---

  it('GET /health without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
  });

  it('POST /run without auth returns 401', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      payload: { image: 'alpine:3.19', files: { 'x.sh': 'true' } },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /run with bad body returns 400', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { image: 'alpine:3.19', files: {} },
    });
    assert.equal(res.statusCode, 400);
  });

  // --- sync runs ---

  it('sync: echo succeeds', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        image: 'alpine:3.19',
        entrypoint: 'sh main.sh',
        files: { 'main.sh': 'echo ok' },
        network: 'none', timeout: 30000,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { status: string; exitCode: number; id: string };
    assert.equal(body.status, 'succeeded');
    assert.equal(body.exitCode, 0);
    assert.match(body.id, /^[0-9a-f-]{36}$/);
  });

  it('sync: non-zero exit = failed', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        image: 'alpine:3.19', entrypoint: 'sh -c "exit 7"',
        files: { 'noop': '' }, network: 'none', timeout: 30000,
      },
    });
    const body = res.json() as { status: string; exitCode: number };
    assert.equal(body.status, 'failed');
    assert.equal(body.exitCode, 7);
  });

  // --- extract + artifacts API ---

  it('sync: extract file + list artifacts + download artifact', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        image: 'alpine:3.19',
        entrypoint: 'sh main.sh',
        files: { 'main.sh': 'echo "artifact-content" > /app/report.txt' },
        network: 'none', timeout: 30000,
        extract: ['/app/report.txt'],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; status: string; artifacts: { path: string; bytes: number }[] };
    assert.equal(body.status, 'succeeded');
    assert.ok(body.artifacts);
    assert.ok(body.artifacts.length > 0);
    const art = body.artifacts.find((a) => a.path.includes('report.txt'));
    assert.ok(art, 'report.txt should be in artifacts');
    assert.ok(art!.bytes > 0);

    // List artifacts via GET
    const listRes = await server.inject({
      method: 'GET', url: `/runs/${body.id}/artifacts`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(listRes.statusCode, 200);
    const list = listRes.json() as { path: string }[];
    assert.ok(list.length > 0);

    // Download the artifact
    const dlRes = await server.inject({
      method: 'GET', url: `/runs/${body.id}/artifacts/report.txt`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(dlRes.statusCode, 200);
    assert.ok(dlRes.body.includes('artifact-content'));
    assert.equal(dlRes.headers['content-disposition'], 'attachment; filename="report.txt"');
  });

  it('artifacts: path traversal blocked', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        image: 'alpine:3.19', entrypoint: 'echo ok',
        files: { 'x': '' }, network: 'none', timeout: 30000,
      },
    });
    const { id } = res.json() as { id: string };

    const bad = await server.inject({
      method: 'GET', url: `/runs/${id}/artifacts/../../../etc/passwd`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.ok([400, 404].includes(bad.statusCode), `expected 400 or 404, got ${bad.statusCode}`);
  });

  // --- async + poll + callback ---

  it('async: returns 202, poll until done', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        image: 'alpine:3.19', entrypoint: 'echo async-ok',
        files: { 'x': '' }, network: 'none', timeout: 30000, async: true,
      },
    });
    assert.equal(res.statusCode, 202);
    const { id, status } = res.json() as { id: string; status: string };
    assert.equal(status, 'running');

    let final: { status: string; exitCode?: number } | undefined;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const g = await server.inject({
        method: 'GET', url: `/runs/${id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const s = g.json() as { status: string; exitCode?: number };
      if (s.status !== 'running') { final = s; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(final);
    assert.equal(final.status, 'succeeded');
    assert.equal(final.exitCode, 0);
  });

  it('async: callback with HMAC signature', async () => {
    const secret = 'callback-secret-long-enough';
    const received = await new Promise<{ body: string; sig: string | undefined }>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          resolve({ body, sig: req.headers['x-light-run-signature'] as string | undefined });
          res.writeHead(200).end();
          srv.close();
        });
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', async () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') return reject(new Error('no addr'));
        await server.inject({
          method: 'POST', url: '/run',
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: {
            image: 'alpine:3.19', entrypoint: 'echo cb',
            files: { 'x': '' }, network: 'none', timeout: 30000,
            async: true, callbackUrl: `http://127.0.0.1:${addr.port}/`, callbackSecret: secret,
          },
        });
      });
    });
    const parsed = JSON.parse(received.body) as { status: string };
    assert.equal(parsed.status, 'succeeded');
    const expected = crypto.createHmac('sha256', secret).update(received.body).digest('hex');
    assert.equal(received.sig, `sha256=${expected}`);
  });

  // --- cancel ---

  it('cancel: stops a running async run', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        image: 'alpine:3.19', entrypoint: 'sleep 60',
        files: { 'x': '' }, network: 'none', timeout: 120000, async: true,
      },
    });
    const { id } = res.json() as { id: string };

    // Wait for the container to actually be running (seed + docker run -d
    // takes 2-5s on Docker Desktop Windows).
    await new Promise((r) => setTimeout(r, 4000));

    const cancel = await server.inject({
      method: 'POST', url: `/runs/${id}/cancel`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(cancel.statusCode, 204);

    const deadline = Date.now() + 30000;
    let state: { status: string } | undefined;
    while (Date.now() < deadline) {
      const g = await server.inject({
        method: 'GET', url: `/runs/${id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      state = g.json() as { status: string };
      if (state.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(state?.status, 'cancelled');
  });

  // --- delete ---

  it('delete: removes a finished run + artifacts from disk', async () => {
    const res = await server.inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        image: 'alpine:3.19', entrypoint: 'echo del',
        files: { 'x': '' }, network: 'none', timeout: 30000,
      },
    });
    const { id } = res.json() as { id: string };

    const del = await server.inject({
      method: 'DELETE', url: `/runs/${id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(del.statusCode, 204);

    const after = await server.inject({
      method: 'GET', url: `/runs/${id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(after.statusCode, 404);
  });

  // --- list ---

  it('GET /runs lists tracked runs', async () => {
    const res = await server.inject({
      method: 'GET', url: '/runs',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    const list = res.json() as unknown[];
    assert.ok(Array.isArray(list));
  });

  // --- auto-eviction ---

  it('storage cap: oldest artifact dirs are evicted when cap exceeded', async () => {
    const evictStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-evict-'));
    const evictArtDir = path.join(evictStateDir, 'artifacts');
    const prevArtDir = process.env.LIGHT_RUN_ARTIFACTS_DIR;
    const prevCap = process.env.LIGHT_RUN_MAX_ARTIFACTS_BYTES;
    process.env.LIGHT_RUN_ARTIFACTS_DIR = evictArtDir;
    process.env.LIGHT_RUN_MAX_ARTIFACTS_BYTES = '200'; // 200 bytes

    const evictServer = await createServer({ token: TOKEN, logger: false });
    try {
      const mkRun = async (tag: string) => {
        const r = await evictServer.inject({
          method: 'POST', url: '/run',
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: {
            image: 'alpine:3.19',
            entrypoint: `sh -c 'head -c 180 /dev/urandom | base64 > /app/${tag}.txt'`,
            files: { 'x': '' }, network: 'none', timeout: 30000,
            extract: [`/app/${tag}.txt`],
          },
        });
        const body = r.json() as { id: string; status: string };
        assert.equal(body.status, 'succeeded');
        return body.id;
      };

      const id1 = await mkRun('one');
      // birthtime resolution on some filesystems is 1s - space the runs out
      await new Promise((r) => setTimeout(r, 1100));
      const id2 = await mkRun('two');
      await new Promise((r) => setTimeout(r, 1100));
      const id3 = await mkRun('three');

      // After id3, total > 200: id1 (oldest) must be evicted, id3 (just-finished) kept
      const r1 = await evictServer.inject({
        method: 'GET', url: `/runs/${id1}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const r3 = await evictServer.inject({
        method: 'GET', url: `/runs/${id3}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(r1.statusCode, 404, 'oldest run should be evicted');
      assert.equal(r3.statusCode, 200, 'newest run should be kept');
      assert.equal(fs.existsSync(path.join(evictArtDir, id1)), false);
      assert.equal(fs.existsSync(path.join(evictArtDir, id3)), true);
      void id2; // may or may not be evicted depending on size
    } finally {
      await evictServer.close();
      fs.rmSync(evictStateDir, { recursive: true, force: true });
      if (prevArtDir !== undefined) process.env.LIGHT_RUN_ARTIFACTS_DIR = prevArtDir;
      else delete process.env.LIGHT_RUN_ARTIFACTS_DIR;
      if (prevCap !== undefined) process.env.LIGHT_RUN_MAX_ARTIFACTS_BYTES = prevCap;
      else delete process.env.LIGHT_RUN_MAX_ARTIFACTS_BYTES;
    }
  });
});
