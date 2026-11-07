/**
 * Parse the opt-in per-fetch warmup budget from PASEO_E2E_METRO_WARMUP_TIMEOUT_MS.
 * Unset means 120 seconds. Node clamps overflowing timers to 1ms, so values above the largest
 * timer are rejected instead of silently becoming instant.
 * @param {string | undefined} configured
 * @returns {number}
 */
export function parseWarmupTimeoutMs(configured) {
  if (configured === undefined) return 120_000;

  const timeoutMs = Number(configured);
  const supported =
    configured.trim().length > 0 &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= 2_147_483_647;
  if (!supported) {
    throw new Error(
      "PASEO_E2E_METRO_WARMUP_TIMEOUT_MS must be a positive integer from 1 to 2147483647 milliseconds",
    );
  }
  return timeoutMs;
}

/**
 * Fetch the Metro document and compile its same-origin scripts before tests start.
 * @param {number} port
 * @param {{ timeoutMs?: number }} [options] Per-fetch budget; defaults to the environment value.
 */
export async function warmMetro(port, options = {}) {
  const timeoutMs =
    options.timeoutMs ?? parseWarmupTimeoutMs(process.env.PASEO_E2E_METRO_WARMUP_TIMEOUT_MS);
  const origin = `http://127.0.0.1:${port}`;
  const documentResponse = await fetch(origin, { signal: AbortSignal.timeout(timeoutMs) });
  if (!documentResponse.ok) {
    throw new Error(`Metro document warmup failed with HTTP ${documentResponse.status}`);
  }
  const document = await documentResponse.text();
  const scriptSources = [...document.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  if (scriptSources.length === 0) {
    throw new Error("Metro document warmup found no scripts to compile");
  }
  for (const source of scriptSources) {
    const scriptUrl = new URL(source, origin);
    if (scriptUrl.origin !== origin) continue;
    const response = await fetch(scriptUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      // Metro reports the missing module and origin in the HTTP body, not its progress log.
      const errorBody = (await response.text()).slice(0, 4000);
      throw new Error(
        `Metro bundle warmup failed for ${scriptUrl.pathname}: HTTP ${response.status}\n${errorBody}`,
      );
    }
    await response.arrayBuffer();
  }
}
