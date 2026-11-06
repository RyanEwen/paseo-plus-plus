/** Read an opt-in per-fetch budget before HTTP starts; Node clamps overflowing timers to 1ms. */
function getWarmupTimeoutMs() {
  const configured = process.env.PASEO_E2E_METRO_WARMUP_TIMEOUT_MS;
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

/** @param {number} port */
export async function warmMetro(port) {
  const timeoutMs = getWarmupTimeoutMs();
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
