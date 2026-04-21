# Release Flow

Tag-based release on `main` (GitHub Flow). See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev guide.

## Core principle

**Code merges and npm releases are separate.** Pushing to `main` runs CI (build + tests). Publishing to npm only happens when you explicitly push a version tag like `v0.2.0`.

```
                        git push
                           |
              +------------+------------+
              |                         |
            main                      tag v*
              |                         |
              v                         v
          ci.yml                    release.yml
              |                         |
              v                         v
        build + test          build + test + npm publish + GitHub Release
```

## Triggers

| Event | ci.yml | release.yml |
|---|---|---|
| push to `main` | build + test on Node 22 + 24 | - |
| pull request -> `main` | build + test on Node 22 + 24 | - |
| push tag `v*` | - | build + test + npm publish + GitHub Release |

## Single source of truth: tag name

The workflow reads the version from the tag name:

```bash
VERSION="${GITHUB_REF_NAME#v}"   # v0.2.0 -> 0.2.0
```

`package.json` carries the next intended release. The workflow injects the tag version via `npm version --no-git-tag-version --allow-same-version` before publishing, so the published artifact always matches the tag.

## Guards (release.yml)

1. **Pre-release blocked** - tag containing `-` (e.g. `v0.2.0-rc.1`) exits 1. Stable tags only.
2. **Tag must be on main** - `git merge-base --is-ancestor` check. Push the tag from a commit that lives on `main`, otherwise the workflow refuses.
3. **Idempotent publish** - `npm view` checks if the version already exists. If yes, the publish step is skipped so re-running the workflow is safe.

## How to ship a stable release

```bash
# 1. Make sure main is green
git checkout main
git pull origin main
npm run build && npm test

# 2. Create the version tag (annotated, with release notes)
git tag -a v0.2.0 -m "v0.2.0

- change 1
- change 2

build with cc"

# 3. Push the tag
git push origin v0.2.0

# 4. Watch the release workflow
gh run watch

# 5. (Optional) regenerate release notes with contributor credit
gh release edit v0.2.0 --generate-notes
```

### What the tag push triggers

1. `release.yml` runs on the tagged commit
2. Setup Node 24 (npm 11+ for OIDC Trusted Publishing)
3. Compute version from tag
4. Guard: no pre-release suffix
5. Guard: tag commit is an ancestor of `origin/main`
6. Sync `package.json` version with the tag (in-memory)
7. Build + `npm test`
8. `npm view` check - skip if already published
9. `npm publish --access public --provenance` (OIDC, no token)
10. `gh release create` with auto-generated notes

## npm Trusted Publishing (OIDC)

No `NPM_TOKEN` in the repo. `release.yml` uses `id-token: write` to exchange a GitHub OIDC token for a short-lived npm credential. Configure once on [npmjs.com](https://www.npmjs.com/) under the package's Settings -> Trusted Publishers:

- Publisher: **GitHub Actions**
- Organization: `enixCode`
- Repository: `light-run`
- Workflow filename: `release.yml`
- Environment: (leave empty)

First publish needs the package name reserved; after that, the trusted publisher handles it.

## Installing

| User wants | Command |
|---|---|
| Latest stable | `npm i light-run` |
| Specific release | `npm i light-run@0.2.0` |
| Latest main (unpublished) | `npm i github:enixCode/light-run#main` |

## When things go wrong

- **Tag pushed but nothing published**: check the Actions tab. Either the `-` guard tripped (pre-release tag), `npm view` found the version already exists, or the tag commit was not an ancestor of `main`.
- **`npm publish` returns 404 OIDC**: Node in `release.yml` must be 24+ (npm v11 for OIDC). Check the trusted publisher config on npmjs.com matches the workflow filename exactly.
- **Pushed a pre-release tag** like `v0.2.0-rc.1`: the guard rejects it. Delete it (`git push --delete origin v0.2.0-rc.1`) and push a stable tag instead.
- **Version in `package.json` does not match the tag**: does not block the publish (workflow overrides), but keep them aligned so the local `npm pack` matches what ships.
- **Forgot to update docs/api/**: the `preversion` hook regenerates and re-stages `docs/api/` when you run `npm version`, so a version bump cannot ship with stale API docs. If you cut the tag manually without `npm version`, regenerate before tagging: `npm run docs && git add docs/api/ && git commit --amend --no-edit`.
