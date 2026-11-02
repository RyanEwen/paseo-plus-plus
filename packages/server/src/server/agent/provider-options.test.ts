import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../test-utils/test-logger.js";

import { AgentManager } from "./agent-manager.js";
import { validateProviderOptions } from "./provider-options.js";
import { applyClaudeToolPolicy, ClaudeProviderOptionsSchema } from "./providers/claude/options.js";
import { applyCodexToolPolicy, CodexProviderOptionsSchema } from "./providers/codex/options.js";
import {
  buildOpenCodePermissionRules,
  OpenCodeProviderOptionsSchema,
} from "./providers/opencode/options.js";
import {
  resolveConfiguredCodexHistory,
  configuredHistoryStartupArgs,
  assertConfiguredHistoryVersion,
  historyRootsOverlap,
} from "./providers/codex/history.js";
import type { ConfiguredCodexHistoryInput } from "./providers/codex/history.js";
import type { ProviderCommand } from "./provider-launch-config.js";
import {
  buildProviderRegistry,
  resolveConfiguredCodexHistoryProfile,
} from "./provider-registry.js";

const hubPolicy = {
  preapproved: [{ kind: "mcp" as const, server: "hub", tool: "finish_execution" }],
};

describe("provider-owned option schemas", () => {
  test("accepts Codex native workspace-write and network policy nesting", () => {
    expect(
      CodexProviderOptionsSchema.parse({
        approval_policy: "never",
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: {
          writable_roots: ["/var/cache/npm"],
          network_access: false,
        },
        web_search: "disabled",
        features: {
          network_proxy: {
            enabled: true,
            domains: { "registry.npmjs.org": "allow", "*": "deny" },
          },
        },
      }),
    ).toMatchObject({
      sandbox_workspace_write: { writable_roots: ["/var/cache/npm"] },
    });
  });

  test("reports the exact invalid Codex option path", () => {
    expect(() =>
      validateProviderOptions("codex", CodexProviderOptionsSchema, {
        sandbox_workspace_write: { writable_roots: ["/tmp", 42] },
      }),
    ).toThrow("providerOptions.sandbox_workspace_write.writable_roots[1]");
  });

  test("accepts Claude permission and fail-closed sandbox settings", () => {
    expect(
      ClaudeProviderOptionsSchema.parse({
        allowedTools: ["Read"],
        disallowedTools: ["Bash(rm *)"],
        extraArgs: { chrome: null, model: "x" },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          filesystem: { denyRead: ["~/.ssh/**"] },
          network: {
            allowedDomains: ["api.anthropic.com"],
            allowLocalBinding: false,
            allowUnixSockets: ["/var/run/docker.sock"],
          },
        },
        settings: { permissions: { ask: ["Bash(*)"], deny: ["Edit(.env)"] } },
      }),
    ).toMatchObject({
      extraArgs: { chrome: null, model: "x" },
      sandbox: { enabled: true, failIfUnavailable: true },
    });
  });

  test.each([true, 42, ["x"]])("rejects invalid Claude extra argument values: %j", (value) => {
    expect(() =>
      validateProviderOptions("claude", ClaudeProviderOptionsSchema, {
        extraArgs: { chrome: value },
      }),
    ).toThrow("providerOptions.extraArgs.chrome");
  });

  test("rejects a raw argument list for the SDK argument map", () => {
    expect(() =>
      validateProviderOptions("claude", ClaudeProviderOptionsSchema, {
        extraArgs: ["--chrome"],
      }),
    ).toThrow("providerOptions.extraArgs");
  });

  test("reports the exact invalid Claude option path", () => {
    expect(() =>
      validateProviderOptions("claude", ClaudeProviderOptionsSchema, {
        sandbox: { network: { allowLocalBinding: "yes" } },
      }),
    ).toThrow("providerOptions.sandbox.network.allowLocalBinding");
  });

  test("accepts OpenCode native permission patterns and external_directory", () => {
    expect(
      OpenCodeProviderOptionsSchema.parse({
        permission: {
          bash: { "*": "ask", "git status": "allow" },
          external_directory: { "*": "deny", "/var/cache/npm/**": "allow" },
        },
      }),
    ).toMatchObject({ permission: { bash: { "*": "ask" } } });
  });

  test("reports the exact invalid OpenCode option path", () => {
    expect(() =>
      validateProviderOptions("opencode", OpenCodeProviderOptionsSchema, {
        permission: { bash: { "git status": "sometimes" } },
      }),
    ).toThrow('providerOptions.permission.bash["git status"]');
  });

  test.each([
    ["codex", CodexProviderOptionsSchema, { cwd: "/tmp" }],
    ["claude", ClaudeProviderOptionsSchema, { hooks: {} }],
    ["opencode", OpenCodeProviderOptionsSchema, { mcp: {} }],
  ])("rejects Paseo-owned or executable %s keys", (provider, schema, options) => {
    expect(() => validateProviderOptions(provider, schema, options)).toThrow(
      `Invalid providerOptions for '${provider}'`,
    );
  });

  test("all schemas reject non-JSON values", () => {
    const unsafe = { permission: { bash: () => true } };
    expect(z.json().safeParse(unsafe).success).toBe(false);
    expect(OpenCodeProviderOptionsSchema.safeParse(unsafe).success).toBe(false);
  });
});

describe("exact MCP preapproval mappings", () => {
  test("unsupported providers fail closed with an unattended-execution error", () => {
    const registry = buildProviderRegistry(createTestLogger());
    expect(() =>
      registry.pi.applyToolPolicy(
        {
          provider: "pi",
          cwd: "/tmp",
          mcpServers: { hub: { type: "http", url: "http://127.0.0.1/hub" } },
        },
        hubPolicy,
      ),
    ).toThrow("cannot preapprove exact MCP tools for unattended execution");
  });

  test("Codex enables and approves only the granted server tool", () => {
    expect(
      applyCodexToolPolicy(
        {
          mcp_servers: {
            hub: { url: "http://127.0.0.1/hub" },
            unrelated: { url: "http://127.0.0.1/unrelated" },
          },
        },
        hubPolicy,
      ),
    ).toEqual({
      mcp_servers: {
        hub: {
          url: "http://127.0.0.1/hub",
          enabled_tools: ["finish_execution"],
          default_tools_approval_mode: "prompt",
          tools: { finish_execution: { approval_mode: "approve" } },
        },
        unrelated: { url: "http://127.0.0.1/unrelated" },
      },
    });
  });

  test("Claude adds the exact MCP identity without replacing deny rules", () => {
    expect(
      applyClaudeToolPolicy(
        { allowedTools: ["Read"], disallowedTools: ["Bash", "mcp__hub__reply"] },
        hubPolicy,
      ),
    ).toEqual({
      allowedTools: ["Read", "mcp__hub__finish_execution"],
      disallowedTools: ["Bash", "mcp__hub__reply"],
    });
  });

  test("OpenCode keeps authored ask or deny rules after internal grants", () => {
    expect(
      buildOpenCodePermissionRules(
        {
          permission: {
            hub_finish_execution: "deny",
            bash: "ask",
          },
        },
        hubPolicy,
      ),
    ).toEqual([
      { permission: "hub_finish_execution", pattern: "*", action: "allow" },
      { permission: "hub_finish_execution", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "ask" },
    ]);
  });
});

describe("configured provider options", () => {
  test.each(["options", "params"] as const)(
    "Pi imports read sessionDir from config %s",
    async (key) => {
      const dir = mkdtempSync(join(tmpdir(), "provider-options-import-"));
      try {
        const file = join(dir, "native.jsonl");
        writeFileSync(
          file,
          JSON.stringify({
            type: "session",
            version: 3,
            id: "native",
            cwd: "/tmp/options-project",
          }) + "\n",
        );
        const logger = createTestLogger();
        const registry = buildProviderRegistry(logger, {
          providerOverrides: { pi: { [key]: { sessionDir: dir } } },
        });
        const sessions = await registry.pi.createClient(logger).listImportableSessions!({
          cwd: "/tmp/options-project",
        });
        expect(sessions.map((session) => session.providerHandleId)).toEqual([file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("a provider without option handling ignores the record", async () => {
    const logger = createTestLogger();
    const registry = buildProviderRegistry(logger, {
      isDev: true,
      providerOverrides: { mock: { options: { arbitrary: { base: true } } } },
    });
    const session = await registry.mock
      .createClient(logger)
      .createSession({ provider: "mock", cwd: "/tmp", providerOptions: { more: [1] } });
    expect(session.provider).toBe("mock");
    await session.close();
  });

  test("config options reach Claude and provider validation reaches the create caller", async () => {
    const logger = createTestLogger();
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        claude: { options: { sandbox: { network: { allowLocalBinding: "yes" } } } },
      },
    });
    const manager = new AgentManager({
      logger,
      clients: { claude: registry.claude.createClient(logger) },
      providerDefinitions: { claude: registry.claude },
    });
    await expect(
      manager.createAgent({ provider: "claude", cwd: "/tmp", model: "sonnet" }, undefined, {
        workspaceId: undefined,
      }),
    ).rejects.toThrow("providerOptions.sandbox.network.allowLocalBinding");
  });
});

async function configuredHistoryFixture(): Promise<ConfiguredCodexHistoryInput> {
  const root = await fs.mkdtemp(join(tmpdir(), "codex-configured-storage-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  const sqliteHome = join(root, "db");
  await fs.mkdir(home);
  await fs.mkdir(sqliteHome);
  return {
    policy: { mode: "configured" },
    runtimeSettings: { env: { CODEX_HOME: home } },
    profileOptions: { sqlite_home: sqliteHome },
    env: { CODEX_HOME: home },
  };
}

describe("configured Codex history admission", () => {
  test("uses explicit native startup selection and preserves auth/config links", async () => {
    const input = await configuredHistoryFixture();
    const home = input.env.CODEX_HOME!;
    // Broken integration links prove the guard does not dereference their targets.
    await fs.symlink(join(home, "absent-auth-target"), join(home, "auth.json"));
    await fs.symlink(join(home, "absent-config-target"), join(home, "config.toml"));
    const storage = await resolveConfiguredCodexHistory(input);
    expect(storage).toEqual({
      kind: "configured-home",
      provider: "codex",
      home,
      sqliteHome: input.profileOptions!.sqlite_home,
    });
    expect(configuredHistoryStartupArgs(storage)).toEqual([
      "-c",
      `sqlite_home=${JSON.stringify(input.profileOptions!.sqlite_home)}`,
    ]);
    expect(await resolveConfiguredCodexHistory({ ...input, policy: undefined })).toBeUndefined();
    expect(
      await resolveConfiguredCodexHistory({ ...input, policy: { mode: "shared" } }),
    ).toBeUndefined();
    expect(configuredHistoryStartupArgs({ kind: "unknown" })).toEqual([]);
  });

  test.each(["sessions", "archived_sessions", "history.jsonl", "state_5.sqlite"])(
    "rejects linked history artifact %s",
    async (name) => {
      const input = await configuredHistoryFixture();
      const root = name.endsWith("sqlite")
        ? String(input.profileOptions!.sqlite_home)
        : input.env.CODEX_HOME!;
      await fs.symlink(join(root, "absent"), join(root, name));
      await expect(resolveConfiguredCodexHistory(input)).rejects.toMatchObject({
        reason: "history-symlink",
      });
    },
  );

  test("rejects database hardlinks without reading contents", async () => {
    const input = await configuredHistoryFixture();
    const root = String(input.profileOptions!.sqlite_home);
    await fs.writeFile(join(root, "original"), "fixture");
    await fs.link(join(root, "original"), join(root, "state_5.sqlite"));
    await expect(resolveConfiguredCodexHistory(input)).rejects.toMatchObject({
      reason: "history-hardlink",
    });
  });

  test("requires existing roots, rejects native home and preserves original binding", async () => {
    const input = await configuredHistoryFixture();
    const storage = await resolveConfiguredCodexHistory(input);
    const absent = join(input.env.CODEX_HOME!, "absent");
    await expect(
      resolveConfiguredCodexHistory({ ...input, profileOptions: { sqlite_home: absent } }),
    ).rejects.toMatchObject({ reason: "configured-root-must-already-exist" });
    await expect(fs.lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
    const native = join(homedir(), ".codex");
    await expect(
      resolveConfiguredCodexHistory({
        ...input,
        runtimeSettings: { env: { CODEX_HOME: native } },
        env: { CODEX_HOME: native },
      }),
    ).rejects.toMatchObject({ reason: "known-native-history-root" });
    await expect(
      resolveConfiguredCodexHistory({ ...input, existingSession: true }),
    ).rejects.toMatchObject({ reason: "existing-route-unverified" });
    await expect(
      resolveConfiguredCodexHistory({
        ...input,
        previous: storage,
        profileOptions: { sqlite_home: input.env.CODEX_HOME },
      }),
    ).rejects.toMatchObject({ reason: "bound-storage-changed" });
    expect(
      await resolveConfiguredCodexHistory({
        ...input,
        previous: storage,
        policy: { mode: "shared" },
        existingSession: true,
      }),
    ).toEqual(storage);
  });

  test.each([
    { mode: "replace", argv: ["wrapper"] },
    { mode: "append", args: ["--profile", "other"] },
    { mode: "append", args: ["-c", "sqlite_home='/other'"] },
    { mode: "append", args: ["-c", "profiles.other.sqlite_home='/other'"] },
    { mode: "append", args: ["--config", "broken"] },
  ] satisfies ProviderCommand[])(
    "rejects unresolved or conflicting native selector %j",
    async (command) => {
      const input = await configuredHistoryFixture();
      await expect(
        resolveConfiguredCodexHistory({
          ...input,
          runtimeSettings: { ...input.runtimeSettings, command },
        }),
      ).rejects.toMatchObject({ code: "HISTORY_STORAGE_CONFLICT" });
    },
  );

  test("rejects changed final environment/request and compares canonical source aliases", async () => {
    const input = await configuredHistoryFixture();
    await expect(
      resolveConfiguredCodexHistory({ ...input, env: { ...input.env, CODEX_HOME: "/other" } }),
    ).rejects.toMatchObject({ reason: "launch-home-conflict" });
    await expect(
      resolveConfiguredCodexHistory({
        ...input,
        env: { ...input.env, CODEX_SQLITE_HOME: "/other" },
      }),
    ).rejects.toMatchObject({ reason: "environment-sqlite-selector-conflict" });
    await expect(
      resolveConfiguredCodexHistory({ ...input, options: { sqlite_home: "/other" } }),
    ).rejects.toMatchObject({ reason: "request-sqlite-selector-conflict" });
    const storage = (await resolveConfiguredCodexHistory(input))!;
    const alias = join(storage.home, "..", "source-link");
    await fs.symlink(storage.home, alias);
    expect(await historyRootsOverlap({ home: alias, sqliteHome: alias }, storage)).toBe(true);
  });

  test("derived exact IDs inherit the same policy, native option and environment selection", async () => {
    const input = await configuredHistoryFixture();
    const overrides = {
      codex: {
        env: input.runtimeSettings!.env,
        options: input.profileOptions,
        history: input.policy,
      },
      "codex-work": { extends: "codex", label: "Work" },
    };
    const logger = createTestLogger();
    const registry = buildProviderRegistry(logger, { providerOverrides: overrides });
    const client = registry["codex-work"].createClient(logger);
    const selected = await client.resolveHistoryStorage!({
      provider: "codex-work",
      config: { provider: "codex-work", cwd: input.env.CODEX_HOME! },
      operation: "create",
    });
    expect(selected).toMatchObject({ kind: "configured-home", home: input.env.CODEX_HOME });
    expect(resolveConfiguredCodexHistoryProfile("codex-work", overrides)).toMatchObject({
      historyPolicy: input.policy,
      providerOptions: input.profileOptions,
    });
    const changedOverrides = {
      ...overrides,
      "codex-work": {
        extends: "codex",
        label: "Work",
        env: { PROFILE_MARKER: "derived" },
        options: { ...input.profileOptions, web_search: "disabled" },
        history: { mode: "configured" as const },
      },
    };
    const changed = buildProviderRegistry(logger, { providerOverrides: changedOverrides })[
      "codex-work"
    ];
    const configOnly = resolveConfiguredCodexHistoryProfile("codex-work", changedOverrides);
    expect(configOnly.runtimeSettings).toEqual(changed.configuration?.runtimeSettings);
    expect(configOnly.providerOptions).toEqual(changed.configuration?.providerOptions);
    expect(configOnly.historyPolicy).toEqual(changed.configuration?.historyPolicy);
    expect(
      await changed.createClient(logger).resolveHistoryStorage!({
        provider: "codex-work",
        config: { provider: "codex-work", cwd: "/tmp" },
        operation: "create",
      }),
    ).toEqual(selected);

    await expect(
      client.resolveHistoryStorage!({
        provider: "codex-work",
        config: { provider: "codex-work", cwd: "/tmp" },
        operation: "resume",
      }),
    ).rejects.toMatchObject({ reason: "existing-route-unverified" });
    const claude = buildProviderRegistry(logger, {
      providerOverrides: { claude: { history: { mode: "configured" } } },
    }).claude.createClient(logger);
    await expect(
      claude.resolveHistoryStorage!({
        provider: "claude",
        config: { provider: "claude", cwd: "/tmp" },
        operation: "create",
      }),
    ).rejects.toMatchObject({ code: "HISTORY_STORAGE_CONFLICT" });
  });
});

test("configured history startup requires the established trusted native version contract", () => {
  expect(() => assertConfiguredHistoryVersion("codex-cli 0.166.0\n")).not.toThrow();
  for (const version of ["wrapper 0.166.0", "codex-cli 0.165.0", "codex-cli 0.167.0", "unknown"])
    expect(() => assertConfiguredHistoryVersion(version)).toThrow(
      "configured-history-cli-version-unsupported",
    );
});

test("derived Claude configured profiles preserve exact inherited home and reject route drift without SQLite", async () => {
  const input = await configuredHistoryFixture();
  const home = input.env.CODEX_HOME! + "/";
  const previousHome = process.env.HOME;
  process.env.HOME = join(input.env.CODEX_HOME!, "..", "native-user");
  try {
    const logger = createTestLogger();
    const overrides = {
      claude: {
        history: { mode: "configured" as const },
        env: { CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
      },
      "claude-work": { extends: "claude", label: "Work", env: { PROFILE_MARKER: "derived" } },
    };
    const definition = buildProviderRegistry(logger, { providerOverrides: overrides })[
      "claude-work"
    ];
    expect(definition.configuration?.runtimeSettings?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: home,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      PROFILE_MARKER: "derived",
    });
    const selected = await definition.createClient(logger).resolveHistoryStorage!({
      provider: "claude-work",
      config: { provider: "claude-work", cwd: "/tmp" },
      operation: "create",
    });
    expect(selected).toEqual({ kind: "configured-home", provider: "claude", home });
    expect(configuredHistoryStartupArgs(selected)).toEqual([]);
    const changed = buildProviderRegistry(logger, {
      providerOverrides: {
        ...overrides,
        "claude-work": {
          ...overrides["claude-work"],
          env: { CLAUDE_CONFIG_DIR: input.env.CODEX_HOME! },
        },
      },
    })["claude-work"].createClient(logger);
    await expect(
      changed.resolveHistoryStorage!({
        provider: "claude-work",
        config: { provider: "claude-work", cwd: "/tmp" },
        operation: "resume",
        previous: {
          origin: "created",
          registration: "registered",
          sessionId: "actual",
          storage: selected!,
        },
      }),
    ).rejects.toMatchObject({ reason: "bound-storage-changed" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("configured foreign storage is rejected before any Codex create/resume subprocess probe", async () => {
  const client = new CodexAppServerAgentClient(createTestLogger());
  const probe = vi.fn(async () => {
    throw new Error("unexpected provider probe");
  });
  Object.assign(client, { resolveGoalsEnabled: probe, resolveAutoReviewEnabled: probe });
  const context = {
    historyStorage: {
      kind: "configured-home" as const,
      provider: "claude" as const,
      home: "/fixture/not-opened",
    },
  };
  await expect(
    client.createSession({ provider: "codex", cwd: "/fixture" }, context),
  ).rejects.toMatchObject({ reason: "bound-provider-conflict" });
  await expect(
    client.resumeSession({ sessionId: "native" }, { cwd: "/fixture" }, context),
  ).rejects.toMatchObject({ reason: "bound-provider-conflict" });
  expect(probe).not.toHaveBeenCalled();
});
