import { Command } from "commander";
import type { ProviderHistoryPreview } from "@getpaseo/server/provider-history";
import { addJsonOption, addLocalDaemonOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions, type SingleResult } from "../../output/index.js";
import {
  createHistoryMigrationPrompt,
  validateMigrationPromptInput,
} from "@getpaseo/client/provider-history-prompt";
interface PreviewOptions extends CommandOptions {
  providerHome?: string;
  family?: string;
  sqliteHome?: string;
  destinationProvider?: string;
}
interface PromptOptions extends PreviewOptions {
  destinationHome?: string;
  destinationSqliteHome?: string;
}

export function providerHistoryCommand(): Command {
  const history = new Command("history").description(
    "Inspect provider history or prepare migration guidance for your agent",
  );
  const preview = history
    .command("preview <provider>")
    .description("Inventory managed candidates; never applies a migration")
    .requiredOption("--provider-home <path>", "Exact absolute provider home to inspect")
    .option("--family <provider>", "Required for derived providers: codex or claude")
    .option("--sqlite-home <path>", "Exact Codex SQLite home, if configured separately")
    .option(
      "--destination-provider <id>",
      "Compare with an existing configured Codex profile (read-only)",
    );
  addJsonOption(addLocalDaemonOptions(preview)).action(withOutput(runHistoryPreview));
  const prompt = history
    .command("migration-prompt <provider>")
    .description("Print guidance to copy to your agent; never executes or approves migration")
    .requiredOption("--provider-home <path>", "Exact absolute source provider home to inspect")
    .option("--family <provider>", "Required for derived providers: codex or claude")
    .option("--sqlite-home <path>", "Exact source Codex SQLite home, if separate")
    .requiredOption(
      "--destination-home <path>",
      "Explicit proposed destination; remains unverified",
    )
    .option("--destination-sqlite-home <path>", "Explicit proposed Codex SQLite destination");
  addJsonOption(addLocalDaemonOptions(prompt)).action(withOutput(runHistoryMigrationPrompt));
  return history;
}

export async function runHistoryMigrationPrompt(
  provider: string,
  options: PromptOptions,
  command: Command,
): Promise<SingleResult<ReturnType<typeof createHistoryMigrationPrompt>>> {
  if (!options.destinationHome) throw new Error("Migration prompt requires --destination-home");
  const family = options.family ?? provider;
  if (family !== "codex" && family !== "claude")
    throw new Error("Migration prompt supports codex and claude; derived IDs require --family");
  if (family === "claude" && options.destinationSqliteHome !== undefined)
    throw new Error("--destination-sqlite-home applies only to Codex");
  const input = {
    provider,
    family,
    paseoHome: options.daemonTarget.kind === "instance" ? options.daemonTarget.home : undefined,
    source: { home: options.providerHome ?? "", sqliteHome: options.sqliteHome },
    destination: { home: options.destinationHome, sqliteHome: options.destinationSqliteHome },
  } as const;
  // Validate explicit text before inspection. This does not admit a destination or start a provider.
  validateMigrationPromptInput(input);
  const preview = await runHistoryPreview(provider, options, command);
  const data = createHistoryMigrationPrompt({ ...input, inventory: preview.data });
  return {
    type: "single",
    data,
    schema: { idField: "provider", columns: [], renderHuman: () => data.prompt },
  };
}

export async function runHistoryPreview(
  provider: string,
  options: PreviewOptions,
  _command: Command,
): Promise<SingleResult<ProviderHistoryPreview>> {
  if (options.daemonTarget.kind !== "instance")
    throw new Error("History preview requires a local --home target");
  const providerHome = options.providerHome;
  if (!providerHome) throw new Error("History preview requires --provider-home");
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw new Error("Invalid provider ID");
  const family = options.family ?? provider;
  if (family !== "codex" && family !== "claude")
    throw new Error("History preview supports codex and claude; derived IDs require --family");
  if ((provider === "codex" || provider === "claude") && family !== provider)
    throw new Error("Provider family does not match provider ID");
  if (family === "claude" && options.sqliteHome !== undefined)
    throw new Error("--sqlite-home applies only to Codex");
  if (
    options.destinationProvider &&
    (!/^[a-z][a-z0-9-]*$/.test(options.destinationProvider) || family !== "codex")
  )
    throw new Error(
      "Configured destination comparison requires a Codex source and an exact provider ID",
    );
  // Loaded on demand so other CLI commands never load the server's preview module.
  const { previewProviderHistory } = await import("@getpaseo/server/provider-history");
  const data = await previewProviderHistory({
    paseoHome: options.daemonTarget.home,
    provider,
    family,
    providerHome,
    sqliteHome: options.sqliteHome,
    destinationProvider: options.destinationProvider,
  });
  return {
    type: "single",
    data,
    schema: {
      idField: "provider",
      columns: [],
      renderHuman: () => JSON.stringify(data, null, 2),
    },
  };
}
