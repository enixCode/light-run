import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerRunner } from 'light-runner';
import type { ArtifactEntry, RunRequest, RunState } from './schemas.js';

const DEFAULT_MAX_ARTIFACTS_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB

function artifactRoot(): string {
  return (
    process.env.LIGHT_RUN_ARTIFACTS_DIR ??
    path.join(os.homedir(), '.light-run', 'artifacts')
  );
}

function maxArtifactsBytes(): number {
  const raw = process.env.LIGHT_RUN_MAX_ARTIFACTS_BYTES;
  if (!raw) return DEFAULT_MAX_ARTIFACTS_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ARTIFACTS_BYTES;
}

export interface ActiveRun {
  state: RunState;
  cancel: (() => void) | null;
  artifactDir: string;
}

const runs = new Map<string, ActiveRun>();

export function getRun(id: string): ActiveRun | undefined {
  return runs.get(id);
}

export function listRuns(): RunState[] {
  return Array.from(runs.values()).map((r) => r.state);
}

export function deleteRun(id: string): boolean {
  const r = runs.get(id);
  if (!r) return false;
  if (r.state.status === 'running') return false;
  fs.rmSync(r.artifactDir, { recursive: true, force: true });
  runs.delete(id);
  return true;
}

export function artifactDir(id: string): string | null {
  const r = runs.get(id);
  if (!r) return null;
  return r.artifactDir;
}

export async function startRun(req: RunRequest): Promise<{ id: string; done: Promise<RunState> }> {
  const id = crypto.randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-'));
  const artDir = path.join(artifactRoot(), id);
  fs.mkdirSync(artDir, { recursive: true });

  for (const [relPath, content] of Object.entries(req.files)) {
    const dest = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  const parts: string[] = [];
  if (req.setup?.length) parts.push(...req.setup);
  if (req.entrypoint) parts.push(req.entrypoint);
  const command = parts.length ? parts.join(' && ') : undefined;

  const extractSpecs = req.extract?.map((from) => ({
    from,
    to: artDir,
  }));

  const runner = new DockerRunner();
  const execution = runner.run({
    image: req.image,
    command,
    dir: tmpDir,
    input: req.async ? undefined : req.input,
    timeout: req.timeout,
    network: req.network,
    workdir: req.workdir,
    env: req.env,
    extract: extractSpecs,
    detached: !!req.async,
  });

  const startedAt = new Date().toISOString();
  const tracked: ActiveRun = {
    state: { id, status: 'running', startedAt },
    cancel: () => execution.cancel(),
    artifactDir: artDir,
  };
  runs.set(id, tracked);

  const done = execution.result.then(
    (result) => {
      const artifacts = scanArtifacts(artDir);
      const final: RunState = {
        id,
        status: result.cancelled ? 'cancelled' : result.success ? 'succeeded' : 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        durationMs: result.duration,
        artifacts: artifacts.length ? artifacts : undefined,
      };
      tracked.state = final;
      tracked.cancel = null;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      evictOldArtifacts(id);
      return final;
    },
    (err) => {
      const final: RunState = {
        id,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
      tracked.state = final;
      tracked.cancel = null;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return final;
    },
  );

  if (req.async && req.callbackUrl) {
    const url = req.callbackUrl;
    const secret = req.callbackSecret;
    done.then((state) => postCallback(url, secret, state)).catch(() => {});
  }

  return { id, done };
}

export function cancelRun(id: string): boolean {
  const r = runs.get(id);
  if (!r?.cancel) return false;
  r.cancel();
  return true;
}

/* When total bytes under artifactRoot() exceed LIGHT_RUN_MAX_ARTIFACTS_BYTES,
   remove oldest-created run directories until we fit under the cap. The
   currently-running runs and the just-finished run (keepId) are never
   evicted - evicting them would nuke artifacts a client is about to fetch. */
function evictOldArtifacts(keepId: string): void {
  const cap = maxArtifactsBytes();
  const root = artifactRoot();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  const runningIds = new Set(
    Array.from(runs.values())
      .filter((r) => r.state.status === 'running')
      .map((r) => r.state.id),
  );

  type Dir = { id: string; path: string; bytes: number; createdMs: number };
  const evictable: Dir[] = [];
  let total = 0;

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    const bytes = dirBytes(full);
    total += bytes;
    if (e.name === keepId || runningIds.has(e.name)) continue;
    let createdMs: number;
    try {
      const st = fs.statSync(full);
      createdMs = st.birthtimeMs || st.mtimeMs;
    } catch {
      continue;
    }
    evictable.push({ id: e.name, path: full, bytes, createdMs });
  }

  if (total <= cap) return;

  evictable.sort((a, b) => a.createdMs - b.createdMs);
  for (const d of evictable) {
    if (total <= cap) break;
    fs.rmSync(d.path, { recursive: true, force: true });
    runs.delete(d.id);
    total -= d.bytes;
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += dirBytes(full);
    } else if (e.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {}
    }
  }
  return total;
}

function scanArtifacts(dir: string, rel = ''): ArtifactEntry[] {
  const out: ArtifactEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ path: p, bytes: 0, type: 'directory' });
      out.push(...scanArtifacts(path.join(dir, e.name), p));
    } else if (e.isFile()) {
      const stat = fs.statSync(path.join(dir, e.name));
      out.push({ path: p, bytes: stat.size, type: 'file' });
    }
  }
  return out;
}

async function postCallback(url: string, secret: string | undefined, state: RunState): Promise<void> {
  const body = JSON.stringify(state);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['x-light-run-signature'] = `sha256=${sig}`;
  }
  try {
    await fetch(url, { method: 'POST', headers, body });
  } catch {}
}
