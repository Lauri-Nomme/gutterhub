# GutterHub

Zero-data-residency, serverless code coverage visualization for GitHub Pull Requests. GutterHub injects rich, line-by-line coverage gutters (Green = Covered, Red = Uncovered) directly into the native GitHub PR web UI — without exporting code or metadata to any external cloud platform.

## Problem it solves

Enterprise teams under strict security and data-residency compliance can't use SaaS tools like Codecov or Coveralls, because those require parsing and storing source code diffs on external servers.

GitHub offers only two suboptimal on-prem alternatives:

1. **GitHub Code Quality** — highly limited; high-level metrics and minimal inline boxes, no full sidebar gutter fills.
2. **Checks API / Workflow Annotations** — line warnings render as giant expanded text blocks that ruin PR readability.

GutterHub closes this gap with a lightweight browser userscript (Tampermonkey/Greasemonkey) and **Git itself as an immutable, isolated database** (`refs/gutterhub/*`).

## How it works

```
[ CI Pipeline (Jenkins) ]
        │  (1. generates coverage report → line-by-line JSON)
        ▼
[ gutterhub-push.sh ] ──(2. commits blob to isolated ref path)──► [ GitHub remote ]
                                                                  │
                                                                  │ (3. reads blob via browser session cookies)
                                                                  ▼
                                           [ gutterhub.user.js (browser script) ]
                                                                  │
                                                                  │ (4. paints CSS borders)
                                                                  ▼
                                           [ Native GitHub PR Diff Canvas ]
```

- **No middleman servers.** The script talks only to `github.com`.
- **Tokenless.** The raw-ref fetch reuses the logged-in user's browser session — no PATs to generate, rotate, or store.
- **No local bloat.** Coverage lives under `refs/gutterhub/*`, outside `refs/heads/*`, so developer `git fetch` / `git pull` / `git branch -a` never download the blobs.

## Layout

```
gutterhub-push.sh     CI script: publishes coverage to refs/gutterhub/*
gutterhub.user.js     Greasemonkey/Tampermonkey userscript
test/                 Headless end-to-end test harness
```

## Usage

### 1. CI side (`gutterhub-push.sh`)

Run it inside your build agent after generating a coverage report. It expects a compact line-granular JSON matrix:

```json
{"files":{"src/main.js":{"covered":[1,2,3,4,8],"missed":[5,6,7]}}}
```

```bash
./gutterhub-push.sh <COMMIT_SHA> <COVERAGE_JSON> [REMOTE]
# e.g. ./gutterhub-push.sh $GIT_COMMIT coverage-summary.json origin
```

The script writes the JSON into the git object store as a loose blob, packages it into a single-file root commit, points `refs/gutterhub/<SHA>` at that commit (`git update-ref`), and force-pushes **only** that namespace to the remote. See ["How the git ref is wired"](#how-the-git-ref-is-wired) below.

### 2. Browser side (`gutterhub.user.js`)

Install `gutterhub.user.js` in Tampermonkey, Greasemonkey, or Violentmonkey (the `@match` rules cover `github.com` and GitHub Enterprise at `*.github.com`). When a developer opens a PR page, the script:

1. Reads `owner`/`repo` from the URL and the target commit from `<meta name="expected-head-sha">`.
2. Fetches the coverage matrix from `https://raw.githubusercontent.com/<owner>/<repo>/refs/gutterhub/<sha>/coverage.json` using the browser's own session cookies.
3. Paints a green left-border (`#2ea44f`) on covered lines and red (`#cb2431`) on missed lines in both split and unified diff views, re-running via a `MutationObserver` as the diff lazy-loads while scrolling.

## How the git ref is wired

The ref at `refs/gutterhub/<SHA>` points at a dedicated **root commit** whose tree holds a single `coverage.json` file. This is deliberate: GitHub's raw routes return **404** for refs that point directly at a bare blob (verified empirically during development), but resolve a ref → commit → path fine via `raw.githubusercontent.com`. So the pusher commits a lightweight tree+commit for every coverage payload, content-addressed and immutable:

```bash
BLOB_ID=$(git hash-object -w coverage.json)
TREE_ID=$(printf '100644 blob %s\tcoverage.json\n' "$BLOB_ID" | git mktree)
COVERAGE_COMMIT=$(git commit-tree "$TREE_ID" -m "gutterhub: coverage metadata for <sha>")
git update-ref "refs/gutterhub/<sha>" "$COVERAGE_COMMIT"
git push origin "refs/gutterhub/<sha>" --force
```

## How to test it

The E2E test runs the **real** `gutterhub.user.js` against a mock GitHub PR page in a headless Chromium, with no network and no GitHub account.

The trick: the script's `fetch('https://github.com/<owner>/<repo>/raw/refs/gutterhub/<sha>')` is intercepted by Playwright route interception, which fulfills it with the fixture `coverage.json` (keeping the real `github.com` hostname so the userscript's code runs verbatim). A second route serves `fixtures/sample-pr.html`, a GitHub-shaped DOM at `/acme/widgets/pull/42`.

```bash
cd test
npm install              # first run only (installs playwright + chromium)
npx playwright install chromium
npm test                 # runs node e2e.mjs
```

Expected output:

```
[route] raw-ref fetch intercepted: https://github.com/acme/widgets/raw/refs/gutterhub/5aa37f…
GutterHub E2E: PASS — gutters painted green/red for covered/missed lines; uncovered file untouched.
```

The assertions check computed `border-left-color` on every `.blob-code-inner` cell:

- `src/calc.js` lines 1, 2, 3, 4, 8 → green
- `src/calc.js` lines 5, 6, 7 → red
- `src/README.md` (no coverage entry) → untouched