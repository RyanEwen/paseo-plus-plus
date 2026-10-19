import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Combobox } from "@/components/ui/combobox";
import type { WorktreeBranchPickerProps } from "../worktree-branch-picker";
import { FieldTrigger, type FieldTriggerVariant } from "./field-trigger";
import { branchIcon } from "./icons";

/** Preserves branch-choice intents while using the form's compact and desktop field geometry. */
export function WorktreeBranchField({
  options,
  value,
  label,
  onSelect,
  onSearchQueryChange,
  onOpenChange,
  variant,
  disabled,
}: WorktreeBranchPickerProps & {
  variant: FieldTriggerVariant;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  useEffect(() => () => onOpenChange(false), [onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange(nextOpen);
      if (!nextOpen) onSearchQueryChange("");
    },
    [onSearchQueryChange, onOpenChange],
  );
  const openPicker = useCallback(() => handleOpenChange(true), [handleOpenChange]);
  const select = useCallback(
    (id: string) => {
      onSelect(id);
      handleOpenChange(false);
    },
    [onSelect, handleOpenChange],
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
        onPress={openPicker}
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
        open={open}
        onOpenChange={handleOpenChange}
        desktopPlacement="bottom-start"
        anchorRef={anchorRef}
      />
    </>
  );
}
