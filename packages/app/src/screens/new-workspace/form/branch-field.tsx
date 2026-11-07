import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { FieldTrigger, type FieldTriggerVariant } from "./field-trigger";
import { branchIcon } from "./icons";
import type { PickerControl } from "./index";

/** The combined new-branch or existing-branch choice derived by the worktree options hook. */
export interface WorktreeBranchChoice {
  options: ComboboxOption[];
  value: string;
  label: string;
  onSelect: (id: string) => void;
  onSearchQueryChange: (query: string) => void;
}

/** Chooses a new or existing branch in the form's compact and desktop field geometry. */
export function WorktreeBranchField({
  options,
  value,
  label,
  onSelect,
  onSearchQueryChange,
  anchorRef,
  open,
  openState,
  onOpenChange,
  variant,
  disabled,
}: PickerControl &
  WorktreeBranchChoice & {
    variant: FieldTriggerVariant;
    disabled: boolean;
  }): ReactElement {
  const { t } = useTranslation();
  const select = useCallback(
    (id: string) => {
      onSelect(id);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <>
      <FieldTrigger
        ref={anchorRef}
        variant={variant}
        label={t("newWorkspace.fields.branch")}
        accessibilityLabel="Branch"
        tooltip={`${t("newWorkspace.tooltips.branchChoice")}: ${label}`}
        icon={branchIcon}
        value={label}
        onPress={open}
        disabled={disabled}
        testID="new-workspace-branch-picker-trigger"
      />
      <Combobox
        options={options}
        value={value}
        onSelect={select}
        onSearchQueryChange={onSearchQueryChange}
        searchable
        searchPlaceholder="Search branches"
        title={t("newWorkspace.fields.branch")}
        open={openState}
        onOpenChange={onOpenChange}
        desktopPlacement="bottom-start"
        anchorRef={anchorRef}
      />
    </>
  );
}
