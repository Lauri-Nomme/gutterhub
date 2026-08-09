// ==UserScript==
// @name         GutterHub: On-Prem Code Coverage Visualizer
// @namespace    https://gutterhub.dev/
// @version      1.1.0
// @description  Zero-SaaS line-by-line coverage gutters for GitHub PRs using native browser sessions.
// @author       GutterHub Core
// @match        https://github.com/*/*/pull/*
// @match        https://*.github.com/*/*/pull/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @updateURL    https://raw.githubusercontent.com/Lauri-Nomme/gutterhub/master/gutterhub.user.js
// @downloadURL  https://raw.githubusercontent.com/Lauri-Nomme/gutterhub/master/gutterhub.user.js
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
    // `expected-head-sha` meta is absent from the diff tab, so the PR head
    // commit is gathered from every plausible in-page source instead.
    // (The commit-range "..."" menu may, after force-pushed branches, list
    // more than one commit; only the one with published coverage will
    // resolve, so we collect all candidates and try them in order.)
    const shaCandidates = new Set();
    const meta = document.querySelector('meta[name="expected-head-sha"]');
    if (meta && meta.content && /^[0-9a-f]{40}$/.test(meta.content)) shaCandidates.add(meta.content);

    document.querySelectorAll('[data-commit]').forEach((el) => {
      const v = el.getAttribute('data-commit');
      if (v && /^[0-9a-f]{40}$/.test(v)) shaCandidates.add(v);
    });

    document.querySelectorAll('a[href*="/commit/"]').forEach((el) => {
      const m = (el.getAttribute('href') || '').match(/\/([0-9a-f]{40})$/);
      if (m) shaCandidates.add(m[1]);
    });

    const shaBlock = document.querySelector('.sha-block .sha');
    if (shaBlock) {
      const t = (shaBlock.textContent || '').trim();
      if (/^[0-9a-f]{40}$/.test(t)) shaCandidates.add(t);
    }

    // GitHub's new React diff page ships the PR head commit inside an
    // embedded JSON payload (e.g. `"oid":"<40-hex>","shortOid":"..."`).
    document.querySelectorAll('script:not([src])').forEach((el) => {
      const text = el.textContent || '';
      if (text.indexOf('"oid":"') === -1) return;
      const oids = text.match(/"oid":"([0-9a-f]{40})"/g) || [];
      oids.forEach((o) => { shaCandidates.add(o.slice(7, -1)); });
    });

    return {
      owner,
      repo,
      commitShas: [...shaCandidates]
    };
  }

  /**
  * Fetches the raw JSON coverage matrix via GitHub's Git Raw API using
  * browser cookie authentication (zero PAT configuration). Tries every
  * candidate PR head SHA; only the one a CI run published coverage for
  * resolves, so the first that 200s wins.
  */
  async function fetchCoverageData(owner, repo, commitShas) {
    for (const sha of commitShas) {
      // Accesses the isolated reference written by the CI pusher script.
      // The ref points at a root commit whose tree holds `coverage.json`;
      // this URL shape is what GitHub's raw CDN can resolve with browser
      // cookies.
      const targetUrl = `https://raw.githubusercontent.com/${owner}/${repo}/refs/gutterhub/${sha}/coverage.json`;

      try {
        const response = await fetch(targetUrl);
        if (!response.ok) continue;
        return await response.json();
      } catch (error) {
        console.error('GutterHub: Coverage matrix request failed:', error);
      }
    }
    console.log('GutterHub: No coverage metadata found for these commit reference contexts.');
    return null;
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
  * corresponding left border metrics. Handles both the classic
  * `.js-file-content` DOM and GitHub's newer React diff-grid (`/pull/N/changes`)
  * where each file entry is a `[class*="diffEntry"]` containing a
  * `[class*="diff-file-header"]` and rows of type `tr.diff-line-row` whose
  * cells carry the NEW-file line number in `data-line-number`.
  */
  function paintGutterUI(coverageData) {
    if (!coverageData || !coverageData.files) return;

    // New React diff-grid UI?
    const newUIDiffHeaders = document.querySelectorAll('[class*="diff-file-header"]');
    if (newUIDiffHeaders.length) {
      newUIDiffHeaders.forEach((header) => {
        const entry = header.closest('[class*="diffEntry"]')
          || header.closest('[class*="diffTargetable"]');
        if (!entry) return;

        const nameEl = header.querySelector('[class*="file-name"]');
        const filePath = (nameEl ? nameEl.textContent : header.textContent)
          .replace(/\u200e/g, '').trim();
        const fileCoverage = coverageData.files[filePath];
        if (!fileCoverage) return;

        entry.querySelectorAll('tr.diff-line-row').forEach((row) => {
          if (processedLines.has(row)) return;

          const numEl = row.querySelector('[data-line-number]');
          if (!numEl) return;
          const lineNumber = parseInt(numEl.getAttribute('data-line-number'), 10);
          if (isNaN(lineNumber)) return;

          // Paint the code (text) cell; fall back to the number cell.
          const codeCell = row.querySelector('.diff-text-cell') || numEl;
          if (fileCoverage.covered.includes(lineNumber)) {
            codeCell.style.borderLeft = '4px solid #2ea44f';
            codeCell.style.paddingLeft = '6px';
          } else if (fileCoverage.missed.includes(lineNumber)) {
            codeCell.style.borderLeft = '4px solid #cb2431';
            codeCell.style.paddingLeft = '6px';
          }

          processedLines.add(row);
        });
      });
      return;
    }

    // Classic `.js-file-content` DOM.
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
    if (!meta.owner || !meta.repo || !meta.commitShas.length) return;

    if (!coverageData) {
      // Metadata may appear after the very first pass runs (the diff tab
      // hydrates some DOM asynchronously). Fetch once, then paint.
      if (fetchInFlightFor === meta.commitShas.join(',')) return;
      fetchInFlightFor = meta.commitShas.join(',');
      fetchCoverageData(meta.owner, meta.repo, meta.commitShas).then((matrix) => {
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