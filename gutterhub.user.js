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

(function () {
    'use strict';

    // Track processed elements to handle dynamic AJAX scrolling on large PRs
    const processedLines = new Set();

    /**
     * Extracts repository parameters and the active target commit SHA directly
     * from the DOM environment.
     */
    function getPullRequestMetadata() {
        const pathSegments = window.location.pathname.split('/');
        const owner = pathSegments[1];
        const repo = pathSegments[2];

        // Target selector maps to GitHub's modern merge commit state or
        // individual split-diff meta fields.
        const shaElement = document.querySelector('meta[name="expected-head-sha"]') ||
            document.querySelector('.sha-block .sha');

        return {
            owner,
            repo,
            commitSha: shaElement ? shaElement.content || shaElement.textContent.trim() : null
        };
    }

    /**
     * Fetches the raw JSON coverage matrix via GitHub's Git Raw API using
     * browser cookie authentication (zero PAT configuration).
     */
    async function fetchCoverageData(owner, repo, commitSha) {
        // Accesses the isolated reference written by the CI pusher script. The
        // ref points at a root commit whose tree holds `coverage.json`; this
        // URL shape is what GitHub's raw CDN can resolve with browser cookies.
        const targetUrl = `https://raw.githubusercontent.com/${owner}/${repo}/refs/gutterhub/${commitSha}/coverage.json`;

        try {
            const response = await fetch(targetUrl);
            if (!response.ok) {
                if (response.status === 404) {
                    console.log('GutterHub: No coverage metadata found for this commit reference context.');
                }
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error('GutterHub: Critical failure downloading coverage reference matrix:', error);
            return null;
        }
    }

    /**
     * Resolves the 1-based source line number for a given code cell by walking
     * GitHub's diff table structure. Works in both unified and split views.
     */
    function resolveLineNumber(lineCell) {
        // Direct hit: the code cell itself carries the number.
        const self = lineCell.getAttribute('data-line-number');
        if (self) return parseInt(self, 10);

        // The code cell's <td> usually precedes the number cell in split view
        // (<td class="blob-num">), or follows it in unified view.
        const td = lineCell.closest('td');
        if (!td) return null;

        for (const cand of [td, td.previousElementSibling, td.nextElementSibling]) {
            if (!cand) continue;
            const n = cand.getAttribute && cand.getAttribute('data-line-number');
            if (n != null) return parseInt(n, 10);
        }
        return null;
    }

    /**
     * Parses the current visible GitHub Diff DOM tree and injects the
     * corresponding left border metrics.
     */
    function paintGutterUI(coverageData) {
        if (!coverageData || !coverageData.files) return;

        // Locate all file wrapper boxes inside GitHub's progressive PR diff view.
        const fileContainers = document.querySelectorAll('.js-file-content');

        fileContainers.forEach((container) => {
            // Traverse up to pull the exact file name path from the header.
            const file = container.closest('.js-file');
            if (!file) return;
            const fileHeader = file.querySelector('.link-gray-dark, .js-blob-full-path');
            if (!fileHeader) return;

            const filePath = fileHeader.textContent.trim();
            const fileCoverage = coverageData.files[filePath];
            if (!fileCoverage) return;

            // Target all individual code block rows inside either split or
            // unified view layouts.
            container.querySelectorAll('.blob-code-inner').forEach((lineCell) => {
                if (processedLines.has(lineCell)) return;

                const lineNumber = resolveLineNumber(lineCell);
                if (lineNumber == null) return;

                if (fileCoverage.covered.includes(lineNumber)) {
                    lineCell.style.borderLeft = '4px solid #2ea44f'; // Emerald Covered Green
                    lineCell.style.paddingLeft = '6px';
                } else if (fileCoverage.missed.includes(lineNumber)) {
                    lineCell.style.borderLeft = '4px solid #cb2431'; // Crimson Uncovered Red
                    lineCell.style.paddingLeft = '6px';
                }

                processedLines.add(lineCell);
            });
        });
    }

    /**
     * Initialization Core Orchestrator. Waits for the DOM to be interactive if
     * the script is injected early (e.g. via `@run-at document-start` or a test
     * harness); Tampermonkey's `@run-at document-end` runs after this anyway.
     */
    async function initializeGutterHub() {
        const meta = getPullRequestMetadata();
        if (!meta.owner || !meta.repo || !meta.commitSha) return;

        const coverageMatrix = await fetchCoverageData(meta.owner, meta.repo, meta.commitSha);
        if (!coverageMatrix) return;

        // Perform initial painting run.
        paintGutterUI(coverageMatrix);

        // Observe the DOM to seamlessly handle dynamic content re-rendering on
        // long scrolls and lazy-loaded diff sections.
        const observer = new MutationObserver(() => paintGutterUI(coverageMatrix));
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Launch GutterHub execution core.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeGutterHub);
    } else {
        initializeGutterHub();
    }
})();