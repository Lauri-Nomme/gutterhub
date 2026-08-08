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
        // individual split-diff meta fields. On current GitHub the
        // `expected-head-sha` meta is absent from the diff tab; the PR head
        // commit instead lives on the `.js-details-target`-adjacent
        // `<a data-commit="<full sha>">` in the "..." commit-range menu.
        const shaElement = document.querySelector('meta[name="expected-head-sha"]')
            || document.querySelector('.sha-block .sha')
            || document.querySelector('[data-commit]');

        return {
            owner,
            repo,
            commitSha: shaElement
                ? shaElement.content
                    || shaElement.getAttribute('data-commit')
                    || (shaElement.textContent || '').trim()
                : null
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

            // Modern GitHub exposes the path on the header via data-path; older
            // builds used a textual link.
            const fileHeader = file.querySelector('.file-header, .js-file-header');
            let filePath = fileHeader ? fileHeader.getAttribute('data-path') || '' : '';
            if (!filePath) {
                const txt = file.querySelector('.link-gray-dark, .js-blob-full-path');
                if (txt) filePath = txt.textContent.trim();
            }
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

    // Cached coverage matrix and a guard against re-fetch loops while the PR
    // head SHA is unchanged.
    let coverageData = null;
    let fetchInFlightFor = null;

    /**
     * Re-rasterizes whenever the DOM changes. Fetch is async, so we kick it off
     * on the first sighting of a usable PR head SHA and cache the result; after
     * that only the cheap paint pass runs per mutation (the diff renders lazily
     * as GitHub re-renders / you scroll).
     */
    function onChange() {
        const meta = getPullRequestMetadata();
        if (!meta.owner || !meta.repo || !meta.commitSha) return;

        if (!coverageData) {
            // Metadata may appear after the very first pass runs (the diff tab
            // hydrates some DOM asynchronously). Fetch once, then paint.
            if (fetchInFlightFor === meta.commitSha) return;
            fetchInFlightFor = meta.commitSha;
            fetchCoverageData(meta.owner, meta.repo, meta.commitSha).then((matrix) => {
                if (matrix) coverageData = matrix;
                paintGutterUI(coverageData);
            });
            return;
        }
        paintGutterUI(coverageData);
    }

    // Watch the whole document and re-rasterize on changes, debounced so the
    // initial hydration (which fires many rapid mutations) doesn't thrash.
    // Observe documentElement (present at script-eval time) rather than body,
    // which is null before the HTML is parsed.
    let timer = null;
    const observer = new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; onChange(); }, 120);
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });

    // Initial attempt (also covers the case where metadata is already present).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onChange);
    } else {
        onChange();
    }
})();