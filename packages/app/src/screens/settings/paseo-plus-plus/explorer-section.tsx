import { PREFERENCE_EXAMPLE_IMAGES } from "@/paseo-plus-plus/settings-examples";
import { DEVICE_LOCAL_APP_SETTING_KEYS } from "@/paseo-plus-plus/device-local-settings";
import { SettingsExample } from "@/components/settings/settings-example";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { SettingsSectionExtensionRows } from "@/components/settings/section-extension-rows";
import { isWeb } from "@/constants/platform";
import type { AppSettings } from "@/hooks/use-settings";
import { useSettingsSave } from "@/hooks/use-settings/use-settings-save";

type ExplorerSwitchSetting = "autoOpenExplorerSidebar" | "workingDiffAutoSwitch";
type ExplorerSelectSetting = "explorerDiffScope" | "workingDiffDefaultComparison";
type ExplorerSetting = ExplorerSwitchSetting | ExplorerSelectSetting;

/** Label and hint translation keys; the hint also captions the setting's help example. */
const SETTING_TEXT: Record<ExplorerSetting, { label: string; hint: string }> = {
  autoOpenExplorerSidebar: {
    label: "settings.layout.explorer.autoOpen.label",
    hint: "settings.layout.explorer.autoOpen.description",
  },
  explorerDiffScope: {
    label: "settings.layout.explorer.diffScope.label",
    hint: "settings.layout.explorer.diffScope.description",
  },
  workingDiffDefaultComparison: {
    label: "settings.layout.explorer.comparison.label",
    hint: "settings.layout.explorer.comparison.description",
  },
  workingDiffAutoSwitch: {
    label: "settings.layout.explorer.autoSwitch.label",
    hint: "settings.layout.explorer.autoSwitch.description",
  },
};

/** Device-local settings stay editable while a settings host blocks shared edits. */
const DEVICE_LOCAL_KEYS: ReadonlySet<string> = new Set(DEVICE_LOCAL_APP_SETTING_KEYS);

/** Save state of one row: whether it can be edited, and whether its own save is pending or failed. */
interface ExplorerRowState {
  disabled: boolean;
  pending: boolean;
  failed: boolean;
}

type SaveExplorerSetting = <Key extends ExplorerSetting>(
  key: Key,
  value: AppSettings[Key],
) => Promise<void>;

/** Explorer defaults for new workspaces and changed-file navigation. */
export function ExplorerSection() {
  const { t } = useTranslation();
  const { settings, save, pending, failed, isLoading, isEditingBlocked, error } =
    useSettingsSave<ExplorerSetting>();

  /** Keep each control's attempted value outside durable settings until its save succeeds. */
  const saveSetting = useCallback<SaveExplorerSetting>(
    async (key, value) => {
      const updates: Partial<AppSettings> = {};
      updates[key] = value;
      await save(key, updates);
    },
    [save],
  );

  /** Host-synced rows also wait for a settings host; device-local rows only for this device. */
  function rowState(key: ExplorerSetting): ExplorerRowState {
    const blockedByHost = isEditingBlocked && !DEVICE_LOCAL_KEYS.has(key);
    return {
      disabled: isLoading || blockedByHost || error !== null || pending !== null,
      pending: pending === key,
      failed: failed === key,
    };
  }

  const diffScopeOptions = useMemo(
    () =>
      (["all", "single"] as const).map((value) => ({
        value,
        label: t(`settings.layout.explorer.diffScope.options.${value}`),
      })),
    [t],
  );
  const comparisonOptions = useMemo(
    () =>
      (["uncommitted", "base", "all"] as const).map((value) => ({
        value,
        label:
          value === "all"
            ? t("workspace.git.diff.all")
            : t(`settings.layout.explorer.comparison.options.${value}`),
      })),
    [t],
  );

  // The default comparison applies only while automatic switching is off.
  const defaultComparisonState = rowState("workingDiffDefaultComparison");
  if (settings.workingDiffAutoSwitch) {
    defaultComparisonState.disabled = true;
  }

  return (
    <SettingsSection title={t("settings.layout.explorer.title")}>
      <SettingsCard>
        {/* Rows other features contribute to this section, e.g. the Icon-only tabs note. */}
        <SettingsSectionExtensionRows sectionId="explorer" />
        {isWeb ? (
          <ExplorerSettingSwitch
            setting="autoOpenExplorerSidebar"
            value={settings.autoOpenExplorerSidebar}
            state={rowState("autoOpenExplorerSidebar")}
            onSave={saveSetting}
          />
        ) : null}
        <ExplorerSettingSelect
          setting="explorerDiffScope"
          value={settings.explorerDiffScope}
          options={diffScopeOptions}
          state={rowState("explorerDiffScope")}
          onSave={saveSetting}
        />
        <ExplorerSettingSelect
          setting="workingDiffDefaultComparison"
          value={settings.workingDiffDefaultComparison}
          options={comparisonOptions}
          state={defaultComparisonState}
          onSave={saveSetting}
        />
        <ExplorerSettingSwitch
          setting="workingDiffAutoSwitch"
          value={settings.workingDiffAutoSwitch}
          state={rowState("workingDiffAutoSwitch")}
          onSave={saveSetting}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** Label, help example and in-place save feedback shared by every Explorer row. */
function useExplorerRowPresentation(setting: ExplorerSetting, state: ExplorerRowState) {
  const { t } = useTranslation();
  const label = t(SETTING_TEXT[setting].label);
  const hint = t(SETTING_TEXT[setting].hint);
  const help = useMemo(
    () => (
      <SettingsExample
        title={label}
        caption={`${hint} ${t("paseoPlusPlus.examples.explorer")}`}
        images={PREFERENCE_EXAMPLE_IMAGES.explorer}
        testID={`settings-example-${setting}`}
      />
    ),
    [hint, label, setting, t],
  );
  return {
    label,
    labelAccessory: help,
    hint: state.pending ? t("paseoPlusPlus.saving") : hint,
    error: state.failed ? t("paseoPlusPlus.saveFailed") : undefined,
    disabled: state.disabled,
  };
}

interface ExplorerSettingSwitchProps {
  setting: ExplorerSwitchSetting;
  value: boolean;
  state: ExplorerRowState;
  onSave: SaveExplorerSetting;
}

/** A boolean Explorer setting with a stable change callback. */
function ExplorerSettingSwitch({ setting, value, state, onSave }: ExplorerSettingSwitchProps) {
  const row = useExplorerRowPresentation(setting, state);
  const change = useCallback((next: boolean) => void onSave(setting, next), [onSave, setting]);
  return <SettingsSwitch {...row} value={value} onValueChange={change} />;
}

interface ExplorerSettingSelectProps<Key extends ExplorerSelectSetting> {
  setting: Key;
  value: AppSettings[Key];
  options: readonly { label: string; value: AppSettings[Key] }[];
  state: ExplorerRowState;
  onSave: SaveExplorerSetting;
}

/** A choice-valued Explorer setting with a stable change callback. */
function ExplorerSettingSelect<Key extends ExplorerSelectSetting>({
  setting,
  value,
  options,
  state,
  onSave,
}: ExplorerSettingSelectProps<Key>) {
  const row = useExplorerRowPresentation(setting, state);
  const change = useCallback(
    (next: AppSettings[Key]) => void onSave(setting, next),
    [onSave, setting],
  );
  return <SettingsSelect {...row} value={value} options={options} onValueChange={change} />;
}
