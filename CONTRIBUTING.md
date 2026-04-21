# Contributing to light-run

## Branching model

[GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow) - everything happens on `main`.

| Branch/Ref | Purpose |
|---|---|
| `main` | Single source of truth. All PRs merge here. |
| `feature/*`, `fix/*`, `docs/*`, ... | Short-lived branches for work in progress. Deleted after merge. |
| tag `v*` | Release trigger (npm publish + GitHub Release). |

**No long-lived `dev` branch.** Work happens in short feature branches merged to `main` via squash PR. `main` never receives direct commits - if you pushed one by accident, move it to a branch and reset.

## How to contribute

1. **Branch from `main`**
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feature/my-feature
   ```
2. Work, commit freely (your branch, your rules - WIP commits get squashed on merge).
3. Push and open a **Pull Request targeting `main`**:
   ```bash
   git push -u origin feature/my-feature
   gh pr create --base main --fill
   ```
4. The PR is **squash-merged** into `main` (1 clean commit) and the branch is deleted.

### Branch naming

- `feature/xxx` - new features
- `fix/xxx` - bug fixes
- `docs/xxx` - documentation
- `refactor/xxx` - refactors
- `test/xxx` - test changes
- `chore/xxx` - tooling / CI / dependencies

### PR guidelines

- Keep PRs focused - one feature or fix per PR.
- Run `npm test` before opening (38 e2e tests, Docker-gated). The same suite runs in CI.
- Commit messages on your branch can be anything - squash compresses them.
- The PR title becomes the main commit message - make it descriptive. End it with `build with cc` if Claude Code wrote it.
- No em-dashes anywhere. Use regular dashes `-`.

### Code style

- ESM only (`"type": "module"` in `package.json`)
- `module: Node16` / `moduleResolution: Node16` - imports carry `.js` extensions
- `strict: true`, no `any`
- No emojis in code, comments, commits, or docs
- Follow KISS, SOLID, YAGNI

## For the maintainer (solo flow)

Same model as contributors - branch, commit, squash-merge - driven entirely through `gh` so nothing opens a browser.

```bash
git checkout main
git pull origin main
git checkout -b feature/xxx
# work, commit freely
git push -u origin feature/xxx
gh pr create --base main --fill          # PR from current branch
gh pr merge --squash --delete-branch     # squash + delete branch in one call
git checkout main
git pull origin main                     # pick up the squashed commit
```

No branch protection rule is set today - the workflow is self-imposed rather than enforced by GitHub. If multiple contributors join, turn on "Require a pull request before merging" on `main` in Settings > Branches.

### Release

See [RELEASE.md](RELEASE.md). Short version: tag `v*`, push tag, done.

### Hooks

Run once after cloning:

```bash
npm run setup:hooks
```

Installs `scripts/hooks/pre-commit` into `.git/hooks/`. It regenerates and re-stages `docs/api/` (TypeDoc) whenever the staged set touches `src/`. Commits that do not touch `src/` skip the regeneration, so test-only or config-only commits stay fast.

## Quick commands

```bash
npm run build         # clean + tsc -> dist/
npm test              # 38 e2e tests (Docker-gated, skipped without a daemon)
npm run test:docker   # same, inside a container with the host socket mounted
npm run dev           # docker compose up --build (dev server on port 3001)
npm run docs          # regenerate docs/api/ via TypeDoc
```

## Local testing against a live server

```bash
# terminal 1 - start the server
npm run dev                                   # http://localhost:3001
# or, without Docker:
node dist/src/bin/light-run.js serve --token dev-token --port 3000

# terminal 2 - post a run
curl -X POST http://localhost:3001/run \
  -H "Content-Type: application/json" \
  -d '{"image":"alpine:3.19","entrypoint":"echo hi","files":{"main.sh":"#"},"network":"none","timeout":30000}'
```

## Architecture

See [CLAUDE.md](CLAUDE.md) (if present locally - `.gitignore`d) or the [API reference](https://enixcode.github.io/light-run/api/) for the source tree layout and public types.
