import { z } from 'zod';
import type { RunRequest as RunnerRunRequest } from 'light-runner';

const FilePathKey = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith('/'), { message: 'file paths must be relative' })
  .refine((p) => !p.split(/[/\\]/).includes('..'), { message: 'file paths cannot contain ..' });

export const RunRequestSchema = z.object({
  image: z.string().min(1).max(300),
  entrypoint: z.string().min(1).max(2048).optional(),
  /* Build-time setup steps. Each entry becomes a RUN line in a generated
     Dockerfile, the result is cached as light-runner-cache:<sha256(image+run)>
     and reused on identical requests. Executed once at build time, not on every
     container start. Operator-trusted input - never pass user-supplied strings:
     docker build does not inherit the runtime sandbox. */
  run: z.array(z.string().min(1).max(2048)).max(50).optional(),
  files: z.record(FilePathKey, z.string()).refine(
    (r) => Object.keys(r).length > 0,
    { message: 'files must contain at least one entry' },
  ),
  input: z.unknown().optional(),
  timeout: z.number().int().positive().max(60 * 60 * 1000).optional(),
  network: z.string().max(100).optional(),
  workdir: z.string().max(200).optional(),
  env: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid env name'),
      z.string(),
    )
    .optional(),
  /* Paths inside the container to extract after success. No "to" - light-run
     stores artifacts internally and serves them via GET /runs/:id/artifacts. */
  extract: z.array(z.string().min(1).max(1024)).max(20).optional(),
  detached: z.boolean().optional(),
  callbackUrl: z.string().url().optional(),
  callbackSecret: z.string().min(16).max(200).optional(),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;

/* Compile-time drift guard: fields that pass straight through to light-runner
   must stay assignable to light-runner's RunRequest. If light-runner widens or
   tightens one of these types, this line fails the build and forces a sync.
   Zod schemas live at runtime so true inheritance is impossible - this catches
   the next-best thing (type-level mismatch) at zero runtime cost. */
type _SharedFields = 'image' | 'entrypoint' | 'timeout' | 'network' | 'env' | 'workdir' | 'input' | 'run' | 'detached';
type _Assert<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RunRequestSharedAlignment = _Assert<
  Pick<RunRequest, _SharedFields> extends Pick<RunnerRunRequest, _SharedFields> ? true : never
>;

/* Body of POST /runs/:id/stop. Mirrors light-runner's StopOptions: graceful
   SIGTERM (or `signal`) then SIGKILL after `grace` ms. */
export const StopOptionsSchema = z.object({
  signal: z.string().min(1).max(20).optional(),
  grace: z.number().int().nonnegative().max(300000).optional(),
});
export type StopOptions = z.infer<typeof StopOptionsSchema>;

export const ArtifactEntrySchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  type: z.enum(['file', 'directory']),
});
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const RunStatusSchema = z.enum(['running', 'succeeded', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStateSchema = z.object({
  id: z.string().uuid(),
  status: RunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  artifacts: z.array(ArtifactEntrySchema).optional(),
  error: z.string().optional(),
  logs: z.array(z.string()).optional(),
});
export type RunState = z.infer<typeof RunStateSchema>;
