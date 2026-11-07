import { SettingsSyncModel, type SettingsSyncTransport } from "./model";
import type { AppSettingsSnapshot, AppSettingsPatch } from "@getpaseo/protocol/app-settings";
import { applySettingsPatches, settingsDiff } from "@getpaseo/protocol/app-settings-values";

export function snapshot(theme: string | null, revision = 1): AppSettingsSnapshot {
  return {
    initialized: theme !== null,
    revision: theme === null ? 0 : revision,
    values: theme === null ? {} : { app: { theme } },
    fieldRevisions: theme === null ? {} : { '["app","theme"]': revision },
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function setup() {
  let saved: unknown = null;
  let device: Record<string, unknown> = { app: { theme: "device" } };
  const applied: unknown[] = [];
  const model = new SettingsSyncModel({
    readLocal: async () => saved,
    writeLocal: async (value) => {
      saved = structuredClone(value);
    },
    getDeviceValues: async () => device,
    applyValues: async (values) => {
      device = structuredClone(values);
      applied.push(device);
    },
  });
  return { model, applied, device: () => device, saved: () => saved };
}
export function host(initial: AppSettingsSnapshot) {
  let remote = initial;
  const writes: { patches: AppSettingsPatch[]; initialize: boolean }[] = [];
  const transport: SettingsSyncTransport = {
    supported: true,
    writable: true,
    read: async () => structuredClone(remote),
    patch: async ({ patches, initialize = false }) => {
      writes.push({ patches: structuredClone(patches), initialize });
      remote = {
        initialized: true,
        revision: remote.revision + 1,
        values: applySettingsPatches(remote.values, patches),
        fieldRevisions: Object.fromEntries(
          patches.map((patch) => [JSON.stringify(patch.path), remote.revision + 1]),
        ),
      };
      return { snapshot: structuredClone(remote), conflicts: [] };
    },
  };
  return { transport, writes, read: () => remote };
}
export async function editTheme(model: SettingsSyncModel, before: string, after: string) {
  await model.edit(
    settingsDiff({ app: { theme: before } }, { app: { theme: after } }, model.getSnapshot()),
  );
}
