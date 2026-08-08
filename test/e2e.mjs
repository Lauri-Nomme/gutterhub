#!/usr/bin/env node
/**
 * GutterHub End-to-End Test
 *
 * Runs the real `gutterhub.user.js` against a mock GitHub PR page entirely in a
 * headless browser, using Playwright route interception to impersonate the
 * github.com raw-ref fetch. No network access and no real GitHub account are
 * required, so this validates the full happy path:
 *
 *   DOM metadata read -> fetch coverage JSON from refs/gutterhub/* -> paint gutters
 *
 * The trick: we register a route for the raw-ref URL pattern and fulfill it
 * with the fixture coverage matrix. The userscript calls
 * `fetch('https://github.com/acme/widgets/raw/refs/gutterhub/<sha>')` and Playwright
 * intercepts it, so the script behaves exactly as it would in a real browser that
 * is authed to GitHub.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const USERSCRIPT = readFileSync(join(ROOT, 'gutterhub.user.js'), 'utf8');
const PR_HTML = readFileSync(join(__dirname, 'fixtures', 'sample-pr.html'), 'utf8');
const COVERAGE = readFileSync(join(__dirname, 'fixtures', 'coverage.json'), 'utf8');

// Expected computed border colors.
const GREEN = 'rgb(46, 164, 79)';   // #2ea44f Covered
const RED = 'rgb(203, 36, 49)';     // #cb2431 Missed

function expectFor(line) {
    // covered: [1,2,3,4,8]  missed: [5,6,7]
    if ([1, 2, 3, 4, 8].includes(line)) return GREEN;
    if ([5, 6, 7].includes(line)) return RED;
    return null;
}

async function main() {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    // Impersonate the whole universe: raw-ref fetches to github.com get the
    // coverage matrix; every other request gets the mock PR page. A single
    // handler avoids any route-precedence ambiguity.
    await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.includes('/raw/refs/gutterhub/')) {
            console.log('[route] raw-ref fetch intercepted:', url);
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: COVERAGE,
            });
        }
        return route.fulfill({ status: 200, contentType: 'text/html', body: PR_HTML });
    });

    // Inject the real userscript before any page script runs.
    await page.addInitScript(USERSCRIPT);

    // Navigate to a GitHub-shaped URL so getPullRequestMetadata() derives
    // owner="acme", repo="widgets".
    await page.goto('http://localhost:55555/acme/widgets/pull/42', { waitUntil: 'load' });

    // Route interception + fetch are async; give the script a moment to paint.
    await page.waitForTimeout(150);

    // Assertions for the covered file.
    for (let line = 1; line <= 8; line++) {
        const expected = expectFor(line);
        const got = await page.$eval(
            `.js-file:nth-of-type(1) [data-line-number="${line}"] + td .blob-code-inner`,
            (el) => getComputedStyle(el).borderLeftColor
        );
        assert.equal(got, expected || 'rgba(0, 0, 0, 0)',
            `src/calc.js line ${line}: expected border ${expected}, got ${got}`);
    }

    // Negative test: the uncovered file stays untouched.
    const readmeBorder = await page.$eval(
        `.js-file:nth-of-type(2) [data-line-number="1"] + td .blob-code-inner`,
        (el) => getComputedStyle(el).borderLeftColor
    );
    assert.notEqual(readmeBorder, GREEN, 'src/README.md line 1 should not be painted green');
    assert.notEqual(readmeBorder, RED, 'src/README.md line 1 should not be painted red');

    console.log('GutterHub E2E: PASS — gutters painted green/red for covered/missed lines; uncovered file untouched.');
    await browser.close();
}

main().catch((err) => {
    console.error('GutterHub E2E: FAIL');
    console.error(err);
    process.exit(1);
});