#!/usr/bin/env node
// IMPORTANT: ./instrumentation must be the very first import. It bootstraps
// the OpenTelemetry SDK before Fastify and any HTTP module is loaded, so
// auto-instrumentations can hook the right runtime objects. Moving any
// import above this line silently breaks tracing.
//
// For the canonical ESM monkey-patch path (http, undici), users should
// additionally launch the bin with:
//   node --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
//        --import ./dist/src/instrumentation.js dist/src/bin/light-run.js serve
// Without the loader, @fastify/otel still works (it is a Fastify plugin,
// no monkey-patching needed) so server-side spans are emitted correctly.
import '../instrumentation.js';

import { parseArgs } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { DockerRunner } from 'light-runner';
import { createServer } from '../server.js';

const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function sweepCache(log: FastifyBaseLogger): Promise<void> {
  try {
    const removed = await DockerRunner.cleanupOrphanCache();
    if (removed > 0) log.info({ event: 'cache_cleanup', removed }, 'cache cleanup');
  } catch (err) {
    log.warn(
      { event: 'cache_cleanup_failed', err: (err as Error).message },
      'cache cleanup failed',
    );
  }
}

const USAGE = `light-run - HTTP wrapper around light-runner

Usage:
  light-run serve [options]

Options:
  --port <n>         Listen port (default 3000, env LIGHT_RUN_PORT)
  --host <h>         Listen host (default 127.0.0.1, env LIGHT_RUN_HOST)
  --token <t>        Bearer token required on every write endpoint
                     (env LIGHT_RUN_TOKEN; omit to leave open)
  --body-limit <n>   Max POST body size in bytes (default 10485760 = 10 MiB,
                     env LIGHT_RUN_BODY_LIMIT). Raise this if you intend to
                     send large files inline. Each request is parsed in
                     memory, so a big cap is a memory-per-request cost.
  --help, -h         Show this message
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    token: { type: 'string' },
    'body-limit': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length === 0 || positionals[0] !== 'serve') {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}

const port = Number(values.port ?? process.env.LIGHT_RUN_PORT ?? 3000);
const host = values.host ?? process.env.LIGHT_RUN_HOST ?? '127.0.0.1';
const token = values.token ?? process.env.LIGHT_RUN_TOKEN;
const bodyLimitRaw = values['body-limit'] ?? process.env.LIGHT_RUN_BODY_LIMIT;
const bodyLimit = bodyLimitRaw === undefined ? undefined : Number(bodyLimitRaw);

if (!Number.isFinite(port) || port < 1 || port > 65535) {
  process.stderr.write(`invalid --port: ${values.port}\n`);
  process.exit(2);
}

if (bodyLimit !== undefined && (!Number.isFinite(bodyLimit) || bodyLimit < 1)) {
  process.stderr.write(`invalid --body-limit: ${bodyLimitRaw}\n`);
  process.exit(2);
}

if (!token) {
  process.stderr.write(
    'warning: starting without --token. /run is open to any caller.\n',
  );
}

const fastify = await createServer({ token, bodyLimit, logger: true });

const cacheSweepTimer = setInterval(() => { void sweepCache(fastify.log); }, CACHE_SWEEP_INTERVAL_MS);
cacheSweepTimer.unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    fastify.log.info({ event: 'shutdown', signal: sig }, 'shutting down');
    clearInterval(cacheSweepTimer);
    await sweepCache(fastify.log);
    await fastify.close();
    process.exit(0);
  });
}

await fastify.listen({ port, host });
void sweepCache(fastify.log);
