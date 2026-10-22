import { defineConfig, configDefaults } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import path from "path";
import fs from "fs";
import { transformSync } from "@babel/core";
import { build } from "esbuild";

// Set this before Vite resolves dependencies and Vitest starts its workers.
Object.assign(process.env, { NODE_ENV: "test" });

const appNodeModules = path.resolve(__dirname, "node_modules");
const rootNodeModules = path.resolve(__dirname, "../../node_modules");
const resolvePackageEntry = (packageName: string) => {
  const appPackagePath = path.resolve(appNodeModules, packageName);
  return fs.existsSync(appPackagePath)
    ? appPackagePath
    : path.resolve(rootNodeModules, packageName);
};

// Keep browser dependency prebundling on the same platform files as served modules.
const webResolveExtensions = [
  ".web.mjs",
  ".web.js",
  ".web.mts",
  ".web.ts",
  ".web.jsx",
  ".web.tsx",
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
];

export default defineConfig({
  plugins: [
    {
      name: "compile-usage-components",
      enforce: "pre",
      transform(source, id) {
        // These labels must react to time and language in the compiled app too.
        if (!id.includes("/src/usage/") || !id.endsWith(".tsx") || id.includes(".test.")) return;
        const result = transformSync(source, {
          filename: id,
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          plugins: [["babel-plugin-react-compiler", { target: "19" }]],
          sourceMaps: true,
        });
        if (result?.code) return { code: result.code, map: result.map };
      },
    },
    {
      name: "bundle-i18n-resources",
      // Metro resolves literal requires lazily. Vite's TS transform leaves them
      // to Node, which cannot resolve the resource modules. Bundle this boundary
      // so unit and browser consumers exercise the same deferred module loading.
      async transform(_source, id) {
        if (path.resolve(id) !== path.resolve(__dirname, "src/i18n/i18next.ts")) return;
        const result = await build({
          entryPoints: [id],
          bundle: true,
          format: "esm",
          platform: "neutral",
          external: ["i18next", "react-i18next"],
          write: false,
        });
        return { code: result.outputFiles[0].text, map: null };
      },
    },
  ],
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "e2e/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // The generated validator is already executable JS. Transforming its 10 MB body
          // exhausts Vite's heap; execute the real compiled module directly in Node.
          server: {
            deps: {
              external: [
                /[/\\]packages[/\\]protocol[/\\]dist[/\\]generated[/\\]validation[/\\]ws-outbound\.aot\.js$/,
              ],
            },
          },
          environment: "node",
          include: [
            "src/**/*.{test,spec}.{ts,tsx}",
            "native-release-version.test.ts",
            "app.config.test.ts",
            "vitest-environment.test.ts",
          ],
          setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
          exclude: [...configDefaults.exclude, "e2e/**", "src/**/*.browser.{test,spec}.{ts,tsx}"],
        },
      },
      {
        extends: true,
        // Vitest adds every browser test to the optimizer scan before mock transforms.
        // Leave runtime discovery enabled, but keep raw test imports out of that scan.
        optimizeDeps: { entries: ["!**/*.browser.{test,spec}.{ts,tsx}"] },
        test: {
          name: "browser",
          fileParallelism: false,
          include: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            connectTimeout: 180_000,
            instances: [{ browser: "chromium" }],
            screenshotDirectory: ".vitest-screenshots",
          },
          globalSetup: path.resolve(__dirname, "src/runtime/websocket-test-global-setup.ts"),
        },
      },
    ],
    /**
     * Expo pulls in native tooling (xcode, etc.) that executes files relying on `process.send`.
     * Vitest's default worker pool uses worker_threads, which intentionally stub that API and
     * immediately throw `Unexpected call to process.send`. Running the suite in forked processes
     * keeps `process.send` intact so the app tests can boot before hitting the intentional failures.
     */
    pool: "forks",
    maxWorkers: 2,
    server: {
      deps: {
        fallbackCJS: true,
        inline: [
          "react-native-enriched-markdown",
          "zustand",
          "@floating-ui/react-native",
          "@tanstack/react-query",
          "react-native-web",
          "react-native-reanimated",
          "react-native-worklets",
          "react-native-gesture-handler",
          "react-native-keyboard-controller",
          // Exercise shipped modal/portal scheduling in Vite: their ESM builds
          // use Metro-style directory imports that Node cannot load directly.
          "@gorhom/bottom-sheet",
          "@gorhom/portal",
        ],
      },
    },
  },
  // Browser dependencies and served app modules must select the same Metro web files.
  optimizeDeps: {
    esbuildOptions: { resolveExtensions: webResolveExtensions },
    // Bundle the CJS dependencies of the excluded gesture-handler package for the browser.
    include: [
      "react-native",
      "react/jsx-runtime",
      // These are real browser imports; prebundle them before the first test executes.
      "react",
      "react-dom/client",
      "react-dom",
      "@floating-ui/react-native",
      "@tanstack/react-query",
      "@tanstack/react-virtual",
      "react-i18next",
      "@testing-library/dom",
      "@xterm/xterm",
      "@xterm/addon-webgl",
      "@xterm/addon-clipboard",
      "@xterm/addon-fit",
      "@xterm/addon-image",
      "@xterm/addon-search",
      "@xterm/addon-unicode11",
      "@xterm/addon-web-links",
      "fast-deep-equal",
      "fast-deep-equal/es6",
      "zustand/middleware",
      "zustand/vanilla",
      "zustand/shallow",
      "expo-constants",
      "expo-modules-core",
      "mnemonic-id",
      "@gorhom/portal",
      "tweetnacl",
      "base64-js",
      "buffer",
      "tiny-invariant",
      "semver/functions/parse.js",
      "semver/ranges/valid.js",
      "semver/functions/satisfies.js",
      "use-sync-external-store/shim/with-selector",
      // Prebundle late-loaded editor and settings imports before browser mocks run.
      "i18next",
      "zustand",
      "zod",
      "@codemirror/language",
      "@codemirror/legacy-modes/mode/clike",
      "@codemirror/legacy-modes/mode/swift",
      "@lezer/javascript",
      "@lezer/json",
      "@lezer/css",
      "@lezer/cpp",
      "@lezer/go",
      "@lezer/html",
      "@lezer/java",
      "@lezer/python",
      "@lezer/markdown",
      "@lezer/php",
      "@lezer/rust",
      "@lezer/xml",
      "@lezer/yaml",
      "lezer-elixir",
      "@lezer/highlight",
      "@lezer/common",
      "@lezer/lr",

      "react/compiler-runtime",
      "react-native-gesture-handler > hoist-non-react-statics",
      "react-native-gesture-handler > invariant",
    ],
    exclude: [
      "react-native-reanimated",
      "react-native-gesture-handler",
      "react-native-keyboard-controller",
    ],
  },
  // The globals a React Native bundler defines, which esbuild is no longer there to supply for
  // the package excluded above.
  define: {
    "process.env.JEST_WORKER_ID": "undefined",
    __DEV__: "false",
    global: "globalThis",
  },
  resolve: {
    extensions: webResolveExtensions,
    alias: [
      { find: /^expo-router$/, replacement: path.resolve(__dirname, "test-stubs/expo-router.tsx") },
      {
        find: /^@getpaseo\/relay\/e2ee$/,
        replacement: path.resolve(__dirname, "../relay/src/e2ee.ts"),
      },
      {
        find: /^@getpaseo\/relay$/,
        replacement: path.resolve(__dirname, "../relay/src/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
      // Keep keyboard-controller's imports in Vite so native aliases and platform extensions apply.
      {
        find: /^react-native-keyboard-controller$/,
        replacement: path.resolve(
          resolvePackageEntry("react-native-keyboard-controller"),
          "lib/module/index.js",
        ),
      },
      // The CJS entry bypasses Vite's React Native alias and web-extension resolution.
      {
        find: /^react-native-gesture-handler$/,
        replacement: path.resolve(
          rootNodeModules,
          "react-native-gesture-handler/lib/module/index.js",
        ),
      },
      // Must precede the `react-native` alias: a string `find` matches by prefix, so this subpath
      // would otherwise resolve inside a react-native-web *file* and break the dependency scan.
      // Reanimated only imports it on the native path, which no test takes.
      {
        find: /^react-native\/Libraries\/Renderer\/shims\/ReactFabric$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-fabric-shim.ts"),
      },
      // Point to the ESM build so Vite can transform its imports and apply the
      // react alias below (the CJS build uses require('react') which bypasses
      // Vite alias resolution).
      {
        find: "react-native",
        replacement: path.resolve(rootNodeModules, "react-native-web/dist/index.js"),
      },
      { find: "react", replacement: resolvePackageEntry("react") },
      {
        find: "react-dom",
        replacement: resolvePackageEntry("react-dom"),
      },
      {
        find: /^@xterm\/addon-ligatures\/lib\/addon-ligatures\.mjs$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^@xterm\/addon-ligatures$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^react-native-unistyles$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-unistyles.ts"),
      },
      {
        find: /^react-native-svg$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-svg.ts"),
      },
      // Both ship untranspiled Flow and fail to parse on import, which takes out any test that
      // mounts a menu surface.
      {
        find: /^react-native-safe-area-context$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-safe-area-context.ts"),
      },
      {
        find: /^@gorhom\/bottom-sheet$/,
        replacement: path.resolve(__dirname, "test-stubs/gorhom-bottom-sheet.ts"),
      },
      {
        find: /^react-native-reanimated\/scripts\/validate-worklets-version$/,
        replacement: path.resolve(__dirname, "test-stubs/reanimated-validate-worklets-version.ts"),
      },
      {
        find: /^expo-linking$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-linking.ts"),
      },
      // No Node implementation: every call on the real module rejects, so a test
      // touching a persisted store drowns in unhandled rejections.
      {
        find: /^@react-native-async-storage\/async-storage$/,
        replacement: path.resolve(__dirname, "test-stubs/async-storage.ts"),
      },
      {
        find: /^lucide-react-native$/,
        replacement: path.resolve(__dirname, "test-stubs/lucide-react-native.ts"),
      },
    ],
  },
});
