// e2e_tests/helpers/wait_for_server.js
import { config } from '../config.js';

/**
 * Polls the LabNotes server readiness probe (GET /healthz) until ready or timeout.
 * @param {string} [baseUrl] - Base server URL
 * @param {number} [timeoutMs] - Maximum wait time in milliseconds
 * @param {object} [options]
 * @param {number} [options.intervalMs=250] - Polling interval in milliseconds
 * @param {boolean} [options.quiet=false] - Whether to suppress console progress logging
 * @returns {Promise<boolean>}
 */
export async function waitForServer(
  baseUrl = config.baseUrl,
  timeoutMs = config.healthCheckTimeout,
  options = {}
) {
  const { intervalMs = 250, quiet = false } = options;
  const startTime = Date.now();
  const targetUrl = `${baseUrl.replace(/\/+$/, '')}/healthz`;

  if (!quiet) {
    process.stdout.write(`Waiting for server readiness at ${targetUrl}...`);
  }

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.status === 'ok') {
          if (!quiet) {
            process.stdout.write(' READY!\n');
          }
          return true;
        }
      }
    } catch {
      // Server not accepting connections yet, ignore error during boot sequence
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (!quiet) {
      process.stdout.write('.');
    }
  }

  if (!quiet) {
    process.stdout.write('\n');
  }

  throw new Error(
    `Server readiness timeout: ${targetUrl} failed to respond with 200 OK {"status":"ok"} within ${timeoutMs}ms.`
  );
}
