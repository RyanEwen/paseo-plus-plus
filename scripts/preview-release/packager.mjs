import { createRequire } from "node:module";

// Resolve the packager's helpers through the desktop package's declared electron-builder
// dependency, so a nested install resolves the same copy the desktop build uses.
const desktopRequire = createRequire(
  new URL("../../packages/desktop/package.json", import.meta.url),
);

/** Require a module (for example `builder-util` or an app-builder-lib file) as electron-builder sees it. */
export const requireFromElectronBuilder = createRequire(
  desktopRequire.resolve("electron-builder/package.json"),
);
