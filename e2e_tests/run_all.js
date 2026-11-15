#!/usr/bin/env node
// e2e_tests/run_all.js - Master Test Runner with --bail support

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForServer } from './helpers/wait_for_server.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(`
LabNotes MVP - E2E Master Test Runner

Usage:
  node e2e_tests/run_all.js [options]

Options:
  --tier=<1|2|3|4>        Execute only tests from specified tier
  --feature=<1..46>       Execute tests for specified feature number
  --filter=<pattern>      Filter tests by title pattern (regex)
  --base-url=<url>        Target server base URL (default: http://127.0.0.1:8080)
  --bail, -b              Halt test execution upon first failure
  --skip-health           Skip initial GET /healthz pre-flight check
  --help, -h              Show this help message

Examples:
  node e2e_tests/run_all.js
  node e2e_tests/run_all.js --tier=1
  node e2e_tests/run_all.js --feature=13
  node e2e_tests/run_all.js --tier=1 --feature=13
  node e2e_tests/run_all.js --bail
  node e2e_tests/run_all.js --filter="Login"
`);
}

/**
 * Determine if a test filename corresponds to the specified feature number.
 * Supports ranged suites (e.g. tier1_11_20.test.js) and individual feature files (e.g. f13.test.js).
 * @param {string} filename
 * @param {number} featureNum
 * @returns {boolean}
 */
export function fileMatchesFeature(filename, featureNum) {
  // Check range pattern: *_START_END.test.js (e.g., tier1_01_10.test.js, tier2_41_46.test.js)
  const rangeMatch = filename.match(/_(\d{2})_(\d{2})\.test\.js$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    return featureNum >= start && featureNum <= end;
  }

  // Fallback for individual feature test files (e.g., f13.test.js or feature_13.test.js)
  const padded = String(featureNum).padStart(2, '0');
  return (
    filename.toLowerCase().includes(`f${padded}`) ||
    filename.toLowerCase().includes(`feature_${padded}`)
  );
}

/**
 * Build node:test testNamePatterns regex for feature and/or name filtering.
 * @param {number|null} featureNum
 * @param {string|null} namePattern
 * @returns {RegExp[]|undefined}
 */
export function buildTestNamePatterns(featureNum, namePattern) {
  if (featureNum != null && namePattern) {
    const padded = String(featureNum).padStart(2, '0');
    const featRegexStr = `(?:(?:^|[^a-zA-Z0-9])F${padded}(?:[^a-zA-Z0-9]|$)|Feature\\s+0*${featureNum}:)`;
    return [new RegExp(`(?=.*${featRegexStr})(?=.*${namePattern})`, 'i')];
  }

  if (featureNum != null) {
    const padded = String(featureNum).padStart(2, '0');
    return [new RegExp(`(?:^|[^a-zA-Z0-9])F${padded}(?:[^a-zA-Z0-9]|$)|Feature\\s+0*${featureNum}:`)];
  }

  if (namePattern) {
    return [new RegExp(namePattern, 'i')];
  }

  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  let tierFilter = null;
  let featureFilter = null;
  let namePattern = null;
  let skipHealth = false;
  let bail = false;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else if (arg.startsWith('--tier=')) {
      tierFilter = arg.split('=')[1];
    } else if (arg.startsWith('--feature=')) {
      featureFilter = arg.split('=')[1];
    } else if (arg.startsWith('--filter=')) {
      namePattern = arg.split('=')[1];
    } else if (arg.startsWith('--base-url=')) {
      config.baseUrl = arg.split('=')[1];
    } else if (arg === '--skip-health') {
      skipHealth = true;
    } else if (arg === '--bail' || arg === '-b' || arg === '--bail=true') {
      bail = true;
    } else if (arg === '--bail=false') {
      bail = false;
    }
  }

  // Validate tier argument if provided
  if (tierFilter && !['1', '2', '3', '4'].includes(tierFilter)) {
    console.error(`Error: Invalid tier "${tierFilter}". Must be 1, 2, 3, or 4.`);
    process.exit(1);
  }

  // Validate feature argument if provided
  let featureNum = null;
  if (featureFilter) {
    featureNum = parseInt(featureFilter, 10);
    if (isNaN(featureNum) || featureNum < 1 || featureNum > 46 || String(featureNum) !== featureFilter.trim()) {
      console.error(`Error: Invalid feature number "${featureFilter}". Must be an integer between 1 and 46.`);
      process.exit(1);
    }
  }

  console.log('====================================================');
  console.log(' LabNotes MVP - Opaque-Box E2E Test Suite');
  console.log(` Target Server : ${config.baseUrl}`);
  if (tierFilter) console.log(` Tier Filter   : Tier ${tierFilter}`);
  if (featureFilter) console.log(` Feature Filter: Feature ${featureNum}`);
  if (namePattern) console.log(` Name Pattern  : ${namePattern}`);
  if (bail) console.log(` Bail Mode     : Enabled (halting on first failure)`);
  console.log('====================================================\n');

  // Discover test files
  const testFiles = [];
  let tiersToRun;
  if (tierFilter) {
    tiersToRun = [`tier${tierFilter}`];
  } else if (featureNum != null) {
    // Features 1..46 are primarily organized into Tier 1 (Feature Coverage) and Tier 2 (Boundary Cases)
    tiersToRun = ['tier1', 'tier2'];
  } else {
    tiersToRun = ['tier1', 'tier2', 'tier3', 'tier4'];
  }

  for (const tier of tiersToRun) {
    const tierDir = join(__dirname, tier);
    if (existsSync(tierDir)) {
      try {
        const files = readdirSync(tierDir)
          .filter((f) => f.endsWith('.test.js'))
          .filter((f) => {
            if (featureNum == null) return true;
            return fileMatchesFeature(f, featureNum);
          })
          .map((f) => join(tierDir, f));
        testFiles.push(...files);
      } catch (err) {
        console.warn(`Warning reading directory ${tierDir}:`, err.message);
      }
    }
  }

  // If no tier files found and sanity.test.js exists, include it if no tier or feature filter is active
  if (testFiles.length === 0 && !tierFilter && !featureFilter) {
    const sanityFile = join(__dirname, 'sanity.test.js');
    if (existsSync(sanityFile)) {
      console.log('No tier test files found yet. Discovered sanity.test.js.');
      testFiles.push(sanityFile);
      skipHealth = true; // sanity test does not require live server
    }
  }

  if (testFiles.length === 0) {
    console.error('Error: No test files found matching criteria.');
    process.exit(1);
  }

  console.log(`Discovered ${testFiles.length} test suite file(s).\n`);

  // Pre-flight health check (unless skipped)
  if (!skipHealth) {
    try {
      await waitForServer(config.baseUrl, config.healthCheckTimeout);
    } catch (err) {
      console.error('\n[FATAL] Pre-flight health check failed:');
      console.error(err.message);
      console.error('Ensure LabNotes backend is running or pass --skip-health.\n');
      process.exit(1);
    }
  }

  // Build testNamePatterns regex
  const testNamePatterns = buildTestNamePatterns(featureNum, namePattern);

  // Set up abort controller for bail mode
  const abortController = new AbortController();

  // Execute test suite via node:test
  const testStream = run({
    files: testFiles,
    concurrency: 1, // Sequential execution to prevent SQLite state collision
    testNamePatterns,
    signal: abortController.signal,
  });

  testStream.compose(spec).pipe(process.stdout);

  testStream.on('test:fail', (data) => {
    process.exitCode = 1;
    if (bail && !abortController.signal.aborted) {
      console.error(`\n[BAIL] Test failure detected in "${data?.name || 'unknown'}". Halting test run immediately.\n`);
      abortController.abort();
    }
  });
}

// Only invoke main when executed directly as CLI script
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('\nFatal test runner error:', err);
    process.exit(1);
  });
}
