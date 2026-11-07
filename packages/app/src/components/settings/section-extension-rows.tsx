import { useCallback, type ComponentType } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** A row that one feature contributes to a settings section owned by another feature. */
export interface SettingsSectionExtensionRow {
  /** Stable identity, unique within its section. */
  id: string;
  /** Renders the row, including its own settings reads and saves. */
  Row: ComponentType;
}

const EMPTY: readonly SettingsSectionExtensionRow[] = [];
/** Rows per section id. Each change replaces the map so selectors see a new value. */
const registry = createStore<{
  rowsBySection: ReadonlyMap<string, readonly SettingsSectionExtensionRow[]>;
}>(() => ({ rowsBySection: new Map() }));

/** Replace one section's rows. */
function setSectionRows(sectionId: string, rows: readonly SettingsSectionExtensionRow[]): void {
  const rowsBySection = new Map(registry.getState().rowsBySection);
  rowsBySection.set(sectionId, rows);
  registry.setState({ rowsBySection });
}

/**
 * Add a row to the settings section identified by `sectionId`.
 *
 * Rows render in registration order. Returns an unregister function. Throws when the section
 * already has a row with the same id, so two registrations cannot shadow each other.
 */
export function registerSettingsSectionRow(
  sectionId: string,
  row: SettingsSectionExtensionRow,
): () => void {
  const current = listSettingsSectionRows(sectionId);
  if (current.some((existing) => existing.id === row.id)) {
    throw new Error(`Settings section ${sectionId} already has a row ${row.id}`);
  }
  setSectionRows(sectionId, [...current, row]);
  return () => {
    const remaining = listSettingsSectionRows(sectionId).filter((entry) => entry !== row);
    setSectionRows(sectionId, remaining);
  };
}

/** Rows registered for a section, in registration order. The array is replaced on change. */
export function listSettingsSectionRows(sectionId: string): readonly SettingsSectionExtensionRow[] {
  return registry.getState().rowsBySection.get(sectionId) ?? EMPTY;
}

/** Render the rows other features registered for `sectionId`; renders nothing when none exist. */
export function SettingsSectionExtensionRows({ sectionId }: { sectionId: string }) {
  const select = useCallback(
    (state: { rowsBySection: ReadonlyMap<string, readonly SettingsSectionExtensionRow[]> }) =>
      state.rowsBySection.get(sectionId) ?? EMPTY,
    [sectionId],
  );
  const rows = useStore(registry, select);
  return (
    <>
      {rows.map(({ id, Row }) => (
        <Row key={id} />
      ))}
    </>
  );
}
