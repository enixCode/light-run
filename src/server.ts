import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { RunRequestSchema } from './schemas.js';
import { artifactDir, cancelRun, deleteRun, getRun, listRuns, startRun } from './runner.js';

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

  const auth = makeAuth(opts.token);

  fastify.get('/health', async () => ({ status: 'ok' }));

  // --- run ---

  fastify.post('/run', async (req, reply) => {
    if (!auth(req, reply)) return;
    const parsed = RunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', details: parsed.error.issues });
    }
    const { id, done } = await startRun(parsed.data);
    if (parsed.data.async) {
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
    const r = getRun(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.send(r.state);
  });

  fastify.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    if (!auth(req, reply)) return;
    if (!cancelRun(req.params.id)) return reply.code(404).send({ error: 'not_found_or_done' });
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
    const r = getRun(req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.send(r.state.artifacts ?? []);
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
