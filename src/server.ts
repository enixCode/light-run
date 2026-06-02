import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import {
  NetworkCleanupSchema,
  NetworkCreateSchema,
  RunRequestSchema,
  StopOptionsSchema,
} from './schemas.js';
import {
  artifactDir,
  cancelRun,
  deleteRun,
  dockerAvailable,
  getRunState,
  listRuns,
  pauseRun,
  resumeRun,
  startRun,
  stopRun,
} from './runner.js';
import {
  cleanupOrphanNetworks,
  createNetwork,
  deleteNetwork,
  networkExists,
} from './networks.js';
import type { CreateNetworkOptions } from './networks.js';

export interface CreateServerOptions {
  token?: string;
  logger?: boolean | Record<string, unknown>;
  bodyLimit?: number;
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: opts.bodyLimit ?? 10 * 1024 * 1024,
  });

  // OpenTelemetry tracing for incoming HTTP requests. Registered as a
  // Fastify plugin (the contrib instrumentation-fastify package was retired
  // in March 2026; @fastify/otel is the official replacement maintained by
  // the Fastify team). No-op at runtime when no SDK has registered a
  // TracerProvider, so this is safe even with OTEL_EXPORTER_OTLP_ENDPOINT
  // unset. Service identity is carried by the SDK's Resource (OTEL_SERVICE_NAME),
  // not by this plugin.
  const otel = new FastifyOtelInstrumentation({ recordExceptions: true });
  await fastify.register(otel.plugin());

  // Tolerate an empty body on application/json requests. Bodyless lifecycle
  // calls (POST /runs/:id/{stop,cancel,pause,resume}, DELETE /networks/:name)
  // legitimately carry no body, but a client that still sends
  // `content-type: application/json` would otherwise be rejected by Fastify's
  // default parser with 400 FST_ERR_CTP_EMPTY_JSON_BODY before the handler runs
  // (the /stop handler already reads `req.body ?? {}`). Empty -> undefined;
  // genuinely malformed JSON still 400s.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = (body as string).trim();
      if (text === '') return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  const auth = makeAuth(opts.token);

  fastify.get('/health', async (_req, reply) => {
    const docker = await dockerAvailable();
    if (!docker) return reply.code(503).send({ status: 'degraded', docker: false });
    return { status: 'ok', docker: true };
  });

  // --- run ---

  fastify.post('/run', async (req, reply) => {
    if (!auth(req, reply)) return;
    const parsed = RunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', details: parsed.error.issues });
    }
    const { id, done } = await startRun(parsed.data);
    if (parsed.data.detached) {
      return reply.code(202).send({ id, status: 'running', url: `/runs/${id}` });
    }
    return reply.send(await done);
  });

  // --- runs CRUD ---

  fastify.get('/runs', async (req, reply) => {
    if (!auth(req, reply)) return;
    return reply.send(listRuns());
  });

  fastify.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    if (!auth(req, reply)) return;
    const state = getRunState(req.params.id);
    if (!state) return reply.code(404).send({ error: 'not_found' });
    return reply.send(state);
  });

  fastify.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    if (!auth(req, reply)) return;
    if (!(await cancelRun(req.params.id))) return reply.code(404).send({ error: 'not_found_or_done' });
    return reply.code(204).send();
  });

  fastify.post<{ Params: { id: string } }>('/runs/:id/stop', async (req, reply) => {
    if (!auth(req, reply)) return;
    const parsed = StopOptionsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', details: parsed.error.issues });
    }
    if (!(await stopRun(req.params.id, parsed.data))) {
      return reply.code(404).send({ error: 'not_found_or_done' });
    }
    return reply.code(204).send();
  });

  fastify.post<{ Params: { id: string } }>('/runs/:id/pause', async (req, reply) => {
    if (!auth(req, reply)) return;
    if (!(await pauseRun(req.params.id))) {
      return reply.code(404).send({ error: 'not_found_or_done' });
    }
    return reply.code(204).send();
  });

  fastify.post<{ Params: { id: string } }>('/runs/:id/resume', async (req, reply) => {
    if (!auth(req, reply)) return;
    if (!(await resumeRun(req.params.id))) {
      return reply.code(404).send({ error: 'not_found_or_done' });
    }
    return reply.code(204).send();
  });

  fastify.delete<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    if (!auth(req, reply)) return;
    if (!deleteRun(req.params.id)) return reply.code(404).send({ error: 'not_found_or_running' });
    return reply.code(204).send();
  });

  // --- artifacts ---

  fastify.get<{ Params: { id: string } }>('/runs/:id/artifacts', async (req, reply) => {
    if (!auth(req, reply)) return;
    const state = getRunState(req.params.id);
    if (!state) return reply.code(404).send({ error: 'not_found' });
    return reply.send(state.artifacts ?? []);
  });

  fastify.get<{ Params: { id: string; '*': string } }>('/runs/:id/artifacts/*', async (req, reply) => {
    if (!auth(req, reply)) return;
    const artPath = req.params['*'];
    if (!artPath || artPath.includes('..')) {
      return reply.code(400).send({ error: 'invalid_path' });
    }
    const dir = artifactDir(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'not_found' });

    const full = path.resolve(dir, artPath);
    if (!full.startsWith(path.resolve(dir) + path.sep) && full !== path.resolve(dir)) {
      return reply.code(400).send({ error: 'path_traversal' });
    }
    if (!fs.existsSync(full)) {
      return reply.code(404).send({ error: 'artifact_not_found' });
    }
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      // List files in subdirectory
      const entries = fs.readdirSync(full, { withFileTypes: true });
      return reply.send(entries.map((e) => ({
        path: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      })));
    }
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${path.basename(full)}"`)
      .send(fs.createReadStream(full));
  });

  // --- networks (Docker network CRUD, for a remote light-process) ---

  fastify.post('/networks', async (req, reply) => {
    if (!auth(req, reply)) return;
    const parsed = NetworkCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', details: parsed.error.issues });
    }
    const { name, ...opts } = parsed.data;
    // Zod's .optional() infers `| undefined`, which exactOptionalPropertyTypes
    // rejects against light-runner's `?:` props. The shapes match field-for-field.
    const created = await createNetwork(name, opts as CreateNetworkOptions);
    return reply.code(201).send({ name, created });
  });

  fastify.get<{ Params: { name: string } }>('/networks/:name', async (req, reply) => {
    if (!auth(req, reply)) return;
    const exists = await networkExists(req.params.name);
    return reply.send({ name: req.params.name, exists });
  });

  fastify.delete<{ Params: { name: string } }>('/networks/:name', async (req, reply) => {
    if (!auth(req, reply)) return;
    try {
      await deleteNetwork(req.params.name);
      return reply.code(204).send();
    } catch (err) {
      // deleteNetwork throws when the network still has active endpoints.
      return reply.code(409).send({ error: 'network_in_use', message: (err as Error).message });
    }
  });

  fastify.post('/networks/cleanup', async (req, reply) => {
    if (!auth(req, reply)) return;
    const parsed = NetworkCleanupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', details: parsed.error.issues });
    }
    const removed = await cleanupOrphanNetworks(parsed.data);
    return reply.send({ removed });
  });

  return fastify;
}

function makeAuth(token: string | undefined): (req: FastifyRequest, reply: FastifyReply) => boolean {
  return (req, reply) => {
    if (!token) return true;
    if (req.url === '/health') return true;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    const presented = Buffer.from(header.slice(7).trim());
    const expected = Buffer.from(token);
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  };
}
