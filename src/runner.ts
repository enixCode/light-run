import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DockerRunner,
  cleanupOrphanNetworks,
  deleteState,
  listStates,
  readState,
} from 'light-runner';
import type { Execution, RunState as RunnerState } from 'light-runner';
import type { ArtifactEntry, RunRequest, RunState, RunStatus } from './schemas.js';

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

/* In-memory cache of runs launched by THIS process. It is no longer the source
   of truth (light-runner's state dir is) - it only holds the live Execution so
   lifecycle controls can act, plus the onLog buffer (light-runner does not
   replay logs on a re-attached run). */
interface LiveRun {
  execution: Execution | null;
  logs: string[];
}

const live = new Map<string, LiveRun>();

/* Map light-runner's internal status to the HTTP-serialized one. */
function toHttpStatus(s: RunnerState): RunStatus {
  if (s.cancelled || s.status === 'cancelled') return 'cancelled';
  if (s.status === 'running') return 'running';
  if (s.status === 'failed') return 'failed';
  // 'exited'
  return s.exitCode === 0 ? 'succeeded' : 'failed';
}

function toHttpState(s: RunnerState): RunState {
  const dir = path.join(artifactRoot(), s.id);
  const artifacts = scanArtifacts(dir);
  const logs = live.get(s.id)?.logs;
  return {
    id: s.id,
    status: toHttpStatus(s),
    startedAt: s.startedAt,
    ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
    ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(logs && logs.length ? { logs } : {}),
  };
}

export function getRunState(id: string): RunState | null {
  const s = readState(id);
  return s ? toHttpState(s) : null;
}

export function listRuns(): RunState[] {
  return listStates().map(toHttpState);
}

export function deleteRun(id: string): boolean {
  const s = readState(id);
  if (!s && !live.has(id)) return false;
  if (s?.status === 'running') return false;
  fs.rmSync(path.join(artifactRoot(), id), { recursive: true, force: true });
  deleteState(id);
  live.delete(id);
  return true;
}

export function artifactDir(id: string): string | null {
  const dir = path.join(artifactRoot(), id);
  if (live.has(id) || readState(id) || fs.existsSync(dir)) return dir;
  return null;
}

export async function startRun(req: RunRequest): Promise<{ id: string; done: Promise<RunState> }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-'));
  // Extract into a temp dir on the SAME filesystem as the artifact root so the
  // post-run move is an atomic rename (no EXDEV). The final id (container name)
  // is only known after run() returns, so we cannot extract straight to it.
  fs.mkdirSync(artifactRoot(), { recursive: true });
  const extractTmp = fs.mkdtempSync(path.join(artifactRoot(), '.pending-'));

  for (const [relPath, content] of Object.entries(req.files)) {
    const dest = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  const extractSpecs = req.extract?.map((from) => ({ from, to: extractTmp }));

  const startedAt = new Date().toISOString();
  const logs: string[] = [];

  const runner = new DockerRunner();
  const execution = runner.run({
    image: req.image,
    entrypoint: req.entrypoint,
    run: req.run,
    dir: tmpDir,
    input: req.detached ? undefined : req.input,
    timeout: req.timeout,
    networks: req.networks,
    workdir: req.workdir,
    env: req.env,
    extract: extractSpecs,
    detached: !!req.detached,
    onLog: (line: string) => {
      logs.push(line);
    },
  });

  const id = execution.id;
  const artDir = path.join(artifactRoot(), id);
  const tracked: LiveRun = { execution, logs };
  live.set(id, tracked);

  const done = execution.result.then(
    (result) => {
      finalizeArtifacts(extractTmp, artDir);
      const artifacts = scanArtifacts(artDir);
      const final: RunState = {
        id,
        status: result.cancelled ? 'cancelled' : result.success ? 'succeeded' : 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        durationMs: result.duration,
        ...(artifacts.length ? { artifacts } : {}),
        logs,
      };
      tracked.execution = null;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      evictOldArtifacts(id);
      return final;
    },
    (err) => {
      finalizeArtifacts(extractTmp, artDir);
      const final: RunState = {
        id,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
        logs,
      };
      tracked.execution = null;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return final;
    },
  );

  if (req.detached && req.callbackUrl) {
    const url = req.callbackUrl;
    const secret = req.callbackSecret;
    done.then((state) => postCallback(url, secret, state)).catch(() => {});
  }

  return { id, done };
}

/* Resolve a live Execution for lifecycle controls. Prefer the in-process one
   (carries the onLog stream); otherwise re-attach to a still-running run from a
   previous process via its persisted state. Returns null when the run is gone
   or already finished. */
function liveExecution(id: string): Execution | null {
  const r = live.get(id);
  if (r?.execution) return r.execution;
  const s = readState(id);
  if (!s || s.status !== 'running') return null;
  return DockerRunner.attach(id);
}

export async function cancelRun(id: string): Promise<boolean> {
  const exec = liveExecution(id);
  if (!exec) return false;
  exec.cancel();
  return true;
}

export async function stopRun(
  id: string,
  opts?: { signal?: string; grace?: number },
): Promise<boolean> {
  const exec = liveExecution(id);
  if (!exec) return false;
  await exec.stop(opts);
  return true;
}

export async function pauseRun(id: string): Promise<boolean> {
  const exec = liveExecution(id);
  if (!exec) return false;
  await exec.pause();
  return true;
}

export async function resumeRun(id: string): Promise<boolean> {
  const exec = liveExecution(id);
  if (!exec) return false;
  await exec.resume();
  return true;
}

/* Docker daemon reachability, surfaced by GET /health. */
export function dockerAvailable(): Promise<boolean> {
  return DockerRunner.isAvailable();
}

/* Boot + periodic state maintenance. cleanupOrphanStates reconciles runs left
   'running' by a crashed process (their container is gone) to 'failed';
   cleanupOldStates evicts terminal state files past the size budget. */
export async function reconcileStates(): Promise<{ reconciled: number; gc: number }> {
  const reconciled = await DockerRunner.cleanupOrphanStates();
  const gc = DockerRunner.cleanupOldStates();
  return { reconciled, gc };
}

/* light-process names its run-scoped networks `lp-<runId>-<alias>`. A periodic
   sweep of this prefix reclaims networks orphaned when a light-process worker
   is hard-killed before its teardown runs (a normal finish deletes them
   itself). light-runner's own `light-runner-isolated` network is never matched. */
const LP_NETWORK_PREFIX = 'lp-';

export interface MaintenanceReport {
  reconciled: number;
  statesEvicted: number;
  containers: number;
  volumes: number;
  cacheImages: number;
  networks: number;
  danglingImages: number;
}

/* Periodic maintenance sweep, armed by the CLI on boot, on an interval, and at
   shutdown (see src/bin/light-run.ts). Per-run resources (container, volume,
   tmpdir) are already freed the instant a run ends in startRun; THIS is the
   safety net for what crashes, size caps and TTLs leave behind, so the system
   reclaims disk over time instead of only when a new run trips a cap.

   Every step is best-effort and isolated: a daemon hiccup in one reclaimer must
   not stop the others. The reclaim policies (TTLs, ages, byte budgets) live in
   light-runner; light-run only schedules them. */
export async function runMaintenance(): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    reconciled: 0,
    statesEvicted: 0,
    containers: 0,
    volumes: 0,
    cacheImages: 0,
    networks: 0,
    danglingImages: 0,
  };

  try {
    const s = await reconcileStates();
    report.reconciled = s.reconciled;
    report.statesEvicted = s.gc;
  } catch { /* best-effort */ }

  try {
    const o = await DockerRunner.reapOrphans();
    report.containers = o.containers;
    report.volumes = o.volumes;
  } catch { /* best-effort */ }

  try {
    report.cacheImages = await DockerRunner.cleanupOrphanCache();
  } catch { /* best-effort */ }

  try {
    report.networks = await cleanupOrphanNetworks({ prefix: LP_NETWORK_PREFIX });
  } catch { /* best-effort */ }

  try {
    report.danglingImages = await DockerRunner.cleanupDanglingImages();
  } catch { /* best-effort */ }

  return report;
}

/* Move the extracted files into the run's final artifact dir. Same-filesystem
   rename is atomic; cpSync is the cross-device fallback. */
function finalizeArtifacts(extractTmp: string, artDir: string): void {
  try {
    fs.rmSync(artDir, { recursive: true, force: true });
    fs.renameSync(extractTmp, artDir);
  } catch {
    try {
      fs.cpSync(extractTmp, artDir, { recursive: true });
      fs.rmSync(extractTmp, { recursive: true, force: true });
    } catch {
      /* best-effort: leave whatever landed */
    }
  }
}

/* When total bytes under artifactRoot() exceed LIGHT_RUN_MAX_ARTIFACTS_BYTES,
   remove oldest-created run directories until we fit under the cap. Running runs
   (per the state dir) and the just-finished run (keepId) are never evicted. An
   evicted run's state file is dropped too, so it stops showing up in GET /runs.
   `.pending-*` extraction temps are ignored. */
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
    listStates().filter((s) => s.status === 'running').map((s) => s.id),
  );

  type Dir = { id: string; path: string; bytes: number; createdMs: number };
  const evictable: Dir[] = [];
  let total = 0;

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
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
    deleteState(d.id);
    live.delete(d.id);
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
