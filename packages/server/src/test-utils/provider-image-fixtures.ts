import { onTestFinished, vi } from "vitest";
import * as images from "../server/agent/providers/provider-image-output.js";

export const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

/** Hold a real materialization at its public boundary, independently of file-cache hits. */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function holdProviderImageMaterialization() {
  const entered = gate();
  const release = gate();
  const settled = gate();
  const materialize = images.materializeProviderImage;
  let active = false;
  const spy = vi.spyOn(images, "materializeProviderImage").mockImplementation(async (image) => {
    active = true;
    entered.resolve();
    await release.promise;
    try {
      return await materialize(image);
    } finally {
      settled.resolve();
    }
  });
  onTestFinished(async () => {
    release.resolve();
    if (active) await settled.promise;
    spy.mockRestore();
  });
  return { entered: entered.promise, release: () => release.resolve(), settled: settled.promise };
}
