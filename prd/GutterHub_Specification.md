# GutterHub: Architecture Blueprint & Technical Specification

**GutterHub** is a zero-data-residency, serverless code coverage visualization tool designed specifically for security-conscious enterprise teams. It injects rich, interactive line-by-line code coverage gutters (Green = Covered, Red = Uncovered) directly into the native GitHub Pull Request Web UI without exporting code or metadata to an external cloud platform.

---

## 1. The Core Problem & Market Gap

### The Bottleneck
Modern enterprise teams operating under strict security and data-residency compliance guidelines are blocked from using popular cloud-based code coverage suites like Codecov or Coveralls because they require parsing and storing source code diffs on external servers.

### The GitHub Limitation
Unlike Bitbucket, which supports native code coverage visualization out of the box, GitHub delegates this entirely to its Marketplace ecosystem. GitHub's native APIs provide only two suboptimal alternatives for on-premises data:
1. **GitHub Code Quality (Public Preview):** Highly limited line-by-line visualization. It displays only high-level metrics and minimal inline text boxes instead of full sidebar gutter fills.
2. **The Checks API / Workflow Annotations:** Forces line warnings to appear as giant, expanded text block comments directly underneath code rows, which completely ruins pull request readability.

### The GutterHub Edge
GutterHub fills this gap by leveraging a lightweight, browser-based runtime (via a Tampermonkey/Greasemonkey userscript) and using Git itself as an immutable, isolated database (`refs/gutterhub/*`).

---

## 2. Technical Architecture

GutterHub operates via a two-part decoupled runtime environment:

```
[ Jenkins/CI Pipeline ]
       │  (1. Generates coverage report & compiles line-by-line JSON)
       ▼
[ Local Git Engine ] ──(2. Commits raw blob to isolated ref path)──► [ GitHub Enterprise/Cloud Remote ]
                                                                                   │
                                                                                   │ (3. Reads blob using
                                                                                   │     browser session cookies)
                                                                                   ▼
                                                                     [ Greasemonkey Browser UI Script ]
                                                                                   │
                                                                                   │ (4. Paints CSS borders)
                                                                                   ▼
                                                                     [ Native GitHub PR Diff Canvas ]
```

### Component A: The CI Pipeline Pusher (`gutterhub-push`)
Executed inside the local Jenkins build agent. It strips down massive coverage files into a highly compressed, line-granular JSON matrix, binds it directly to the target commit SHA, and pushes it to a private Git reference namespace that standard developer checkouts completely ignore.

### Component B: The Browser Runtime (`gutterhub.user.js`)
A client-side Greasemonkey/Tampermonkey script that executes automatically when a developer visits a GitHub PR page. It dynamically pulls down the raw JSON payload from the hidden Git reference using the user's active browser session cookies (requiring zero PAT configuration) and handles direct DOM injection on the file diff tables.

---

## 3. Implementation Code: CI Backend (`gutterhub-push.sh`)

This script processes a coverage file (`cobertura.xml`, `jacoco.xml`, or `lcov.info`) and translates it into a compact mapping format:
`{"files": {"src/main.js": {"covered": [1,2,3,4,8], "missed": [5,6,7]}}}`

```bash
#!/usr/bin/env bash
set -euo pipefail

# Inputs
COMMIT_SHA="${1:?Error: Commit SHA must be provided as the first argument}"
COVERAGE_JSON_PATH="${2:-coverage-summary.json}"

if [ ! -f "$COVERAGE_JSON_PATH" ]; then
    echo "Error: Coverage file not found at $COVERAGE_JSON_PATH"
    exit 1
fi

echo "==> GutterHub: Registering coverage matrix for Commit: ${COMMIT_SHA:0:7}"

# 1. Write the coverage payload directly into the local Git object store as a loose blob
BLOB_ID=$(git hash-object -w "$COVERAGE_JSON_PATH")
echo "==> Generated Git Blob ID: ${BLOB_ID}"

# 2. Update an isolated Git reference path pointing directly to this blob ID
# This prevents branch pollution and ensures normal developer 'git fetch' calls ignore these files.
git update-ref "refs/gutterhub/${COMMIT_SHA}" "${BLOB_ID}"

# 3. Push exclusively the custom GutterHub namespace directly to the remote repository
echo "==> Syncing coverage reference database to remote repository..."
git push origin "refs/gutterhub/${COMMIT_SHA}" --force

echo "==> GutterHub: Done. Metadata is securely stored in your repository."
```

---

## 4. Implementation Code: Frontend UI (`gutterhub.user.js`)

This Greasemonkey/Tampermonkey script handles the browser-side parsing and rendering. Paste this script directly into an LLM context to instruct it on modern GitHub DOM selectors.

```javascript
// ==UserScript==
// @name         GutterHub: On-Prem Code Coverage Visualizer
// @namespace    https://gutterhub.dev/
// @version      1.0.0
// @description  Zero-SaaS line-by-line coverage gutters for GitHub PRs using native browser sessions.
// @author       GutterHub Core
// @match        https://github.com/*/*/pull/*
// @match        https://*.github.com/*/*/pull/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Track processed elements to handle dynamic AJAX scrolling on large PRs
    const processedLines = new Set();

    /**
     * Extracts repository parameters and the active target commit SHA directly from the DOM environment.
     */
    function getPullRequestMetadata() {
        const pathSegments = window.location.pathname.split('/');
        const owner = pathSegments[1];
        const repo = pathSegments[2];
        
        // Target selector maps to GitHub's modern merge commit state or individual split-diff meta fields
        const shaElement = document.querySelector('meta[name="expected-head-sha"]') || 
                           document.querySelector('.sha-block .sha');
        
        return {
            owner,
            repo,
            commitSha: shaElement ? shaElement.content || shaElement.textContent.trim() : null
        };
    }

    /**
     * Fetches the raw JSON coverage matrix via GitHub's Git Raw API using browser cookie authentication.
     */
    async function fetchCoverageData(owner, repo, commitSha) {
        // Accesses the isolated blob reference written by the CI pusher script
        const targetUrl = `https://github.com/${owner}/${repo}/raw/refs/gutterhub/${commitSha}`;
        
        try {
            const response = await fetch(targetUrl);
            if (!response.ok) {
                if (response.status === 404) console.log("GutterHub: No coverage metadata found for this commit reference context.");
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error("GutterHub: Critical failure downloading code coverage reference matrix:", error);
            return null;
        }
    }

    /**
     * Parses the current visible GitHub Diff DOM tree and injects the corresponding left border metrics.
     */
    function paintGutterUI(coverageData) {
        // Locate all file wrapper boxes inside GitHub's progressive PR diff view
        const fileContainers = document.querySelectorAll('.js-file-content');
        
        fileContainers.forEach(container => {
            // Traverse up to pull the exact file name path from the file header wrapper attribute
            const fileHeader = container.closest('.js-file').querySelector('.link-gray-dark, .js-blob-full-path');
            if (!fileHeader) return;
            
            const filePath = fileHeader.textContent.trim();
            const fileCoverage = coverageData.files[filePath];
            if (!fileCoverage) return;

            // Target all individual code block rows inside either split or unified view layouts
            const codeLines = container.querySelectorAll('.blob-code-inner');
            
            codeLines.forEach(lineCell => {
                if (processedLines.has(lineCell)) return;
                
                // Identify line positional metadata using GitHub's data attributes
                const tdCell = lineCell.closest('td');
                if (!tdCell) return;
                
                const lineNumberAttr = tdCell.getAttribute('data-line-number') || 
                                       tdCell.previousElementSibling?.getAttribute('data-line-number');
                
                if (!lineNumberAttr) return;
                const lineNumber = parseInt(lineNumberAttr, 10);

                // Check line numbers against our mapping arrays and inject heavy CSS left-borders
                if (fileCoverage.covered.includes(lineNumber)) {
                    lineCell.style.borderLeft = "4px solid #2ea44f"; // Emerald Covered Green
                    lineCell.style.paddingLeft = "6px";
                } else if (fileCoverage.missed.includes(lineNumber)) {
                    lineCell.style.borderLeft = "4px solid #cb2431"; // Crimson Uncovered Red
                    lineCell.style.paddingLeft = "6px";
                }
                
                processedLines.has(lineCell) || processedLines.add(lineCell);
            });
        });
    }

    /**
     * Initialization Core Orchestrator
     */
    async function initializeGutterHub() {
        const meta = getPullRequestMetadata();
        if (!meta.owner || !meta.repo || !meta.commitSha) return;

        const coverageMatrix = await fetchCoverageData(meta.owner, meta.repo, meta.commitSha);
        if (!coverageMatrix) return;

        // Perform initial painting run
        paintGutterUI(coverageMatrix);

        // Observe the DOM to seamlessly handle dynamic content re-rendering on long scrolls
        const observer = new MutationObserver(() => paintGutterUI(coverageMatrix));
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Launch GutterHub execution core
    initializeGutterHub();
})();
```

---

## 5. Security & Deployment Brief (For Enterprise Compliance Checklists)

When prompting another LLM to build or modify this system, emphasize the following points to preserve its architecture:

* **No Middleman Servers:** The script communicates strictly with `github.com`. It introduces zero security attack vectors or dynamic third-party analytics connections.
* **Tokenless Execution:** By pulling from the raw reference route via standard `fetch`, it inherently reuses the logged-in user’s web browser authorization state. No local PAT keys or management tokens need to be generated, rotated, or stored inside browser extensions.
* **Zero Local Workspace Bloat:** The Jenkins pipeline pushes exclusively to `refs/gutterhub/*`. Because it resides outside the standard `refs/heads/*` tree, standard developer operations like `git fetch`, `git branch -a`, or `git pull` will never download these coverage blobs to local developer laptops, maintaining pristine workspace speeds.
