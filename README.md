<h1 align="center">light-run</h1>

<p align="center">
  <b>Run a Docker container from an HTTP request.</b><br>
  Thin wrapper around <a href="https://github.com/enixCode/light-runner">light-runner</a> - send files + image + entrypoint over HTTP, get back exit code and extracted artifacts.
</p>

<p align="center">
  <a href="#install">Install</a> -
  <a href="#quick-start">Quick start</a> -
  <a href="#api">API</a> -
  <a href="#request-body">Request body</a> -
  <a href="#security">Security</a> -
  <a href="#ecosystem">Ecosystem</a>
</p>

<p align="center">
  <img alt="status: experimental" src="https://img.shields.io/badge/status-experimental-orange">
  <img alt="under heavy development" src="https://img.shields.io/badge/under-heavy%20development-red">
</p>

> **Experimental - do not use in production.** APIs, defaults and on-disk layout can still change without notice. Pin a commit SHA if you depend on it today.

---

## Ecosystem

`light-run` is the HTTP layer in a family of small, composable tools.

| Project         | Role                                                         | Status        |
| --------------- | ------------------------------------------------------------ | ------------- |
| `light-runner`  | Docker execution SDK - one container, exit code, files       | released      |
| `light-run`     | HTTP wrapper around `light-runner`                           | **this repo** |
| `light-process` | DAG orchestration on top of `light-run`                      | planned       |

Use `light-runner` when you already have a folder on disk. Use `light-run` when you want to post files + an image + a command over HTTP.

---

## Install

```bash
npm install -g light-run
# or
npm install light-run      # use as a library
```

**Requirements**

- Node.js >= 22
- A running Docker daemon on the host (Docker Desktop, `dockerd`, Lima, OrbStack, ...)

---

## Quick start

### 1. Start the server

```bash
light-run serve --token $(openssl rand -hex 32)
```

Or as a library:

```ts
import { createServer } from 'light-run';

const server = await createServer({
  token: process.env.LIGHT_RUN_TOKEN,
  logger: true,
});
await server.listen({ port: 3000, host: '0.0.0.0' });
```

Or with Docker Compose (dev):

```bash
cp .env.example .env           # set LIGHT_RUN_TOKEN if you want auth
npm run dev                    # = docker compose up --build
# -> server on http://localhost:3001
```

The compose file mounts the host Docker socket so `light-runner` can spawn
workload containers as siblings on the host daemon, and bind-mounts
`./.artifacts` so extracted files are inspectable from the host.

### 2. Post a run

```bash
curl -X POST http://localhost:3000/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "alpine:3.19",
    "entrypoint": "sh main.sh",
    "files": { "main.sh": "echo hello > /app/out.txt" },
    "extract": ["/app/out.txt"],
    "network": "none",
    "timeout": 30000
  }'
```

You get back the final run state once the container exits:

```json
{
  "id": "a1b2c3d4-...",
  "status": "succeeded",
  "startedAt": "2026-04-20T10:00:00.000Z",
  "finishedAt": "2026-04-20T10:00:03.421Z",
  "exitCode": 0,
  "durationMs": 3421,
  "artifacts": [
    { "path": "out.txt", "bytes": 6, "type": "file" }
  ]
}
```

Pass `"async": true` to get `202 Accepted` with an id immediately, then poll `GET /runs/:id` or receive a signed callback on `callbackUrl`.

### 3. Download artifacts

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/runs/$ID/artifacts/out.txt
```

---

## API

All endpoints except `/health` require `Authorization: Bearer <token>` when the server is started with a token. Without a token, every route is open (the CLI prints a warning at startup).

| Method | Path                            | Description                                                |
| ------ | ------------------------------- | ---------------------------------------------------------- |
| GET    | `/health`                       | Liveness (no auth)                                         |
| POST   | `/run`                          | Start a run. Sync by default, `async: true` returns 202.   |
| GET    | `/runs`                         | List tracked runs                                          |
| GET    | `/runs/:id`                     | Full state of one run                                      |
| POST   | `/runs/:id/cancel`              | Cancel a running execution                                 |
| DELETE | `/runs/:id`                     | Remove a terminal run + its artifact folder                |
| GET    | `/runs/:id/artifacts`           | List files extracted from the run                          |
| GET    | `/runs/:id/artifacts/*`         | Download a file (or list a subdirectory)                   |

---

## Request body

`POST /run` accepts a JSON body validated by Zod (`src/schemas.ts`).

```ts
{
  image: string;                      // Docker image reference (required)
  files: Record<string, string>;      // relative path -> text content (required, >= 1 entry)
  entrypoint?: string;                // shell command, executed via "sh -c"
  setup?: string[];                   // commands chained with && before entrypoint
  input?: unknown;                    // JSON piped to stdin (sync runs only)
  timeout?: number;                   // ms, max 60 * 60 * 1000
  network?: string;                   // "none", "bridge", or a named network
  workdir?: string;                   // working directory inside the container
  env?: Record<string, string>;       // env vars (name must match [A-Za-z_][A-Za-z0-9_]*)
  extract?: string[];                 // container paths to pull back after exit
  async?: boolean;                    // if true, respond 202 and run in background
  callbackUrl?: string;               // async only: POSTed final RunState
  callbackSecret?: string;            // async only: HMAC-SHA256 signs callback body
}
```

File paths in `files`:
- must be relative (no leading `/`)
- cannot contain `..` segments
- max 1024 characters

`extract` paths are container-absolute (e.g. `/app/out.txt`). Extracted files land in an internal artifact directory and are served via `GET /runs/:id/artifacts/*` - clients never specify a host destination.

### Async + callback

```bash
curl -X POST http://localhost:3000/run \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "image": "alpine:3.19",
    "entrypoint": "echo done",
    "files": { "x": "" },
    "async": true,
    "callbackUrl": "https://my-app.example.com/hook",
    "callbackSecret": "a-secret-of-16-chars-or-more"
  }'
```

When the run finishes, `light-run` POSTs the final `RunState` as JSON to `callbackUrl` with header `X-Light-Run-Signature: sha256=<hex>`, where `<hex>` = `HMAC_SHA256(secret, rawBody)`.

---

## CLI

```
light-run - HTTP wrapper around light-runner

Usage:
  light-run serve [options]

Options:
  --port <n>         Listen port (default 3000, env LIGHT_RUN_PORT)
  --host <h>         Listen host (default 127.0.0.1, env LIGHT_RUN_HOST)
  --token <t>        Bearer token required on every non-/health endpoint
                     (env LIGHT_RUN_TOKEN; omit to leave open)
  --body-limit <n>   Max POST body size in bytes (default 10485760 = 10 MiB,
                     env LIGHT_RUN_BODY_LIMIT). Each request is parsed in
                     memory, so a big cap is a memory-per-request cost.
  --help, -h         Show this message
```

---

## Shared types with light-runner

`light-run` is a thin HTTP boundary over `light-runner` - the two packages share several field shapes (`image`, `timeout`, `network`, `env`, `workdir`, `input`, `extract` semantics). Rather than redefine everything, `light-run` re-exports the 1:1 types directly from `light-runner`:

```ts
import type { Runtime, RunnerOptions, ExtractResult } from 'light-run';
// identical to `import type { ... } from 'light-runner'`
```

The Zod schema for `RunRequest` cannot literally inherit from a TypeScript interface (Zod lives at runtime, interfaces at compile time), so the shared fields are duplicated structurally. A compile-time alignment check in `src/schemas.ts` fails the build if `light-runner` ever widens or tightens any of those shared shapes - drift is caught, never silent.

---

## Security

`light-run` sits on top of `light-runner`, which means every run inherits the hardened defaults of that SDK (dropped capabilities, `no-new-privileges`, pids / memory / CPU caps, isolated network). See the [light-runner security model](https://github.com/enixCode/light-runner#security-model).

On top of that, the HTTP layer adds:

- **Bearer token** with timing-safe comparison on every route except `/health`. Set via `--token` or `LIGHT_RUN_TOKEN`. Starting without a token prints a warning.
- **Body validation** via Zod on every request - no free-form fields reach the runner.
- **File-map validation**: relative paths only, no `..` segments, max 1024 chars each.
- **Path-traversal guard** on `GET /runs/:id/artifacts/*`: literal `..` rejected, and the resolved host path is asserted to stay inside the run's artifact directory.
- **Body limit**: 10 MiB default. Configurable three ways: `createServer({ bodyLimit })` for library use, `--body-limit <bytes>` on the CLI, or `LIGHT_RUN_BODY_LIMIT` env var. This is a `light-run` cap - `light-runner` reads from disk and does not see the HTTP body.

### Terminate TLS at a reverse proxy

Do not expose `light-run` directly on the public internet. Run it behind Caddy, nginx, Traefik, or a managed TLS terminator.

### What it does not cover

No rate limiting, no concurrency cap, no repo fetch. Kernel exploits, `runc` CVEs, side-channel attacks are out of scope - for genuinely hostile code, configure `light-runner` with a safer runtime (e.g. gVisor).

No request/result caching, no content-addressable file store, no memoization. `light-run` is stateless past the live artifact directory - deduplication and workflow memory live in `light-process`, one layer up.

---

## Storage

Artifacts are kept under `~/.light-run/artifacts/<run-id>/` on the host. Temporary working directories under `os.tmpdir()` are cleaned as soon as the container exits. Run state is kept in-memory only - restarting the server forgets tracked runs (artifacts on disk are left intact).

### Auto-eviction

After every finished run, `light-run` scans the artifact root. If the **total size exceeds the cap**, the oldest run directories (by creation time) are removed until the total is back under the cap. Running runs and the run that just finished are never evicted - the client may still be about to download them. When a directory is evicted, the matching in-memory run state is also dropped (subsequent `GET /runs/:id` returns `404`).

### Environment variables

| Variable                           | Default                          | Purpose                                                          |
| ---------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `LIGHT_RUN_ARTIFACTS_DIR`          | `~/.light-run/artifacts`         | Override where artifact directories are stored.                   |
| `LIGHT_RUN_MAX_ARTIFACTS_BYTES`    | `21474836480` (20 GiB)           | Total bytes across all run artifact dirs before auto-eviction kicks in. |
| `LIGHT_RUN_BODY_LIMIT`             | `10485760` (10 MiB)              | Max POST body size (CLI). Each request is parsed in memory. |
| `LIGHT_RUN_TOKEN`                  | _unset_                          | Bearer token required on every route except `/health`.            |
| `LIGHT_RUN_PORT`                   | `3000`                           | Listen port (CLI).                                                |
| `LIGHT_RUN_HOST`                   | `127.0.0.1`                      | Listen host (CLI).                                                |

Unset `LIGHT_RUN_TOKEN` leaves the server open (the CLI prints a warning). Unset or invalid `LIGHT_RUN_MAX_ARTIFACTS_BYTES` falls back to the 20 GiB default. Explicit `DELETE /runs/:id` also removes the artifact directory immediately.

---

## Docs

- **Landing site + API reference:** [enixcode.github.io/light-run](https://enixcode.github.io/light-run/) (same visual system as [light-runner](https://enixcode.github.io/light-runner/)).
- **Local build:**
  ```bash
  npm run docs   # regenerates docs/api/ from src/index.ts via TypeDoc
  ```
- **Pre-commit hook:** run `npm run setup:hooks` once after cloning. It installs `scripts/hooks/pre-commit` into `.git/hooks/`, which regenerates and re-stages `docs/api/` whenever staged files include something under `src/`. Commits that do not touch `src/` skip the regeneration - no cost on test-only or config-only changes.
- `docs/index.html` is the hand-written landing page. `docs/api/` is auto-generated and committed so GitHub Pages can serve it straight from `main/docs/` without a build step.

---

## Testing

```bash
npm test              # clean + build + node --test (38 e2e tests, skipped if Docker absent)
npm run test:docker   # same inside a container with the host Docker socket mounted
```

Tests are split across three files, all using Fastify's `inject()` with **real** `light-runner` containers against the host Docker daemon:

- `test/e2e/server.test.ts` (13 tests) - core surface: auth, sync + async runs, artifacts, cancel, delete, list, storage auto-eviction.
- `test/e2e/languages.test.ts` (8 tests) - Python / Node / shell real workloads: stdin + JSON compute, multi-file project with local import, `crypto.createHash` determinism, env vars, setup chaining, nested directory extraction, multi-MB binary streaming, unicode round-trip.
- `test/e2e/adversarial.test.ts` (17 tests) - failure paths: malformed/wrong/empty Bearer, Zod rejects (absolute path, `..`, empty files, invalid env name, oversize image/entrypoint), `413 Payload Too Large` on body-limit breach, `..` artifact traversal, timeout kills a `sleep 60` in <10 s, `network: 'none'` actually blocks outbound, shell metacharacters in env values passed literally (no command injection).

---

## License

[AGPL-3.0](LICENSE)
