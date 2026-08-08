#!/usr/bin/env bash
#
# gutterhub-push.sh — CI Pipeline Pusher for GutterHub
#
# Strips a coverage report down to a compact line-granular JSON matrix, binds it
# to a target commit SHA, and pushes it into the isolated `refs/gutterhub/*`
# git namespace. Because the reference lives outside `refs/heads/*`, normal
# developer `git fetch` / `git pull` operations never pull these blobs down,
# keeping a zero-footprint on-prem / enterprise workflow.
#
# The ref points at a dedicated ROOT COMMIT whose tree contains a single
# coverage file. A bare-blob ref cannot be resolved by GitHub's raw routes; a
# commit-with-path can, and keeps the design content-addressed and immutable.
# The browser userscript then fetches:
#   https://raw.githubusercontent.com/{owner}/{repo}/refs/gutterhub/{sha}/coverage.json
#
# Usage:
#   gutterhub-push.sh <COMMIT_SHA> <COVERAGE_JSON> [REMOTE] [REF_FILE]
#
#   COMMIT_SHA      The target commit SHA the coverage belongs to.
#   COVERAGE_JSON   A line-granular matrix, e.g.:
#                   {"files":{"src/main.js":{"covered":[1,2,3],"missed":[4,5]}}}
#   REMOTE          Git remote to push to (default: origin).
#   REF_FILE        File name the matrix is stored under inside the coverage
#                   commit (default: coverage.json). Must match what the
#                   userscript fetches.
#
# Security: pushes ONLY the custom gutterhub namespace, never branches or tags.
# Requires a configured git identity (GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL or
# user.name / user.email) for `git commit-tree`.

set -euo pipefail

COMMIT_SHA="${1:?Error: Commit SHA must be provided as the first argument}"
COVERAGE_JSON_PATH="${2:-coverage-summary.json}"
REMOTE="${3:-origin}"
REF_FILE="${4:-coverage.json}"

if [ ! -f "$COVERAGE_JSON_PATH" ]; then
    echo "GutterHub: Error: coverage file not found at '$COVERAGE_JSON_PATH'" >&2
    exit 1
fi

echo "==> GutterHub: Registering coverage matrix for Commit: ${COMMIT_SHA:0:12}"

# 1. Write the coverage payload into the local object store as a loose blob.
#    Content-addressed: deterministic SHA with no embedded timestamps.
BLOB_ID=$(git hash-object -w "$COVERAGE_JSON_PATH")
echo "==> GutterHub: Generated Git Blob ID: ${BLOB_ID}"

# 2. Build a single-file tree + root commit so GitHub's raw routes can resolve
#    it (a bare blob ref returns 404 on the /raw/ and raw.githubusercontent.com
#    endpoints).
TREE_ID=$(printf '100644 blob %s\t%s\n' "$BLOB_ID" "$REF_FILE" | git mktree)
COVERAGE_COMMIT=$(git commit-tree "$TREE_ID" -m "gutterhub: coverage metadata for ${COMMIT_SHA}")
echo "==> GutterHub: Coverage commit: ${COVERAGE_COMMIT}"

# 3. Point an isolated reference at that commit. Normal developer checkouts
#    ignore `refs/gutterhub/*` entirely.
git update-ref "refs/gutterhub/${COMMIT_SHA}" "${COVERAGE_COMMIT}"
echo "==> GutterHub: Updated ref refs/gutterhub/${COMMIT_SHA}"

# 4. Push exclusively the custom GutterHub namespace to the remote repository.
echo "==> GutterHub: Syncing coverage reference database to '${REMOTE}'..."
git push "${REMOTE}" "refs/gutterhub/${COMMIT_SHA}" --force

echo "==> GutterHub: Done. Metadata is securely stored in your repository."