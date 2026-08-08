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
# Usage:
#   gutterhub-push.sh <COMMIT_SHA> <COVERAGE_JSON> [REMOTE]
#
#   COMMIT_SHA      The target commit SHA the coverage belongs to.
#   COVERAGE_JSON   A line-granular matrix, e.g.:
#                   {"files":{"src/main.js":{"covered":[1,2,3],"missed":[4,5]}}}
#   REMOTE          Git remote to push to (default: origin).
#
# Security: pushes ONLY the custom gutterhub namespace, never branches or tags.

set -euo pipefail

COMMIT_SHA="${1:?Error: Commit SHA must be provided as the first argument}"
COVERAGE_JSON_PATH="${2:-coverage-summary.json}"
REMOTE="${3:-origin}"

if [ ! -f "$COVERAGE_JSON_PATH" ]; then
    echo "GutterHub: Error: coverage file not found at '$COVERAGE_JSON_PATH'" >&2
    exit 1
fi

if [ -z "$(git rev-parse --verify "refs/gutterhub/${COMMIT_SHA}^{commit}" 2>/dev/null)" ] &&
   ! git cat-file -e "${COMMIT_SHA}^{commit}" 2>/dev/null; then
    echo "GutterHub: Warning: commit '${COMMIT_SHA:0:12}' is not present in the local store." >&2
    echo "GutterHub: The blob will be written but may be pruned if no other ref reaches it." >&2
fi

echo "==> GutterHub: Registering coverage matrix for Commit: ${COMMIT_SHA:0:12}"

# 1. Write the coverage payload into the local object store as a loose blob.
#    The blob is created from the file contents directly, so its SHA is fully
#    deterministic and content-addressed (no metadata like timestamps).
BLOB_ID=$(git hash-object -w "$COVERAGE_JSON_PATH")
echo "==> GutterHub: Generated Git Blob ID: ${BLOB_ID}"

# 2. Point an isolated reference path directly at this blob ID. Normal
#    developer checkouts ignore `refs/gutterhub/*` entirely.
git update-ref "refs/gutterhub/${COMMIT_SHA}" "${BLOB_ID}"
echo "==> GutterHub: Updated ref refs/gutterhub/${COMMIT_SHA}"

# 3. Push exclusively the custom GutterHub namespace to the remote repository.
echo "==> GutterHub: Syncing coverage reference database to '${REMOTE}'..."
git push "${REMOTE}" "refs/gutterhub/${COMMIT_SHA}" --force

echo "==> GutterHub: Done. Metadata is securely stored in your repository."