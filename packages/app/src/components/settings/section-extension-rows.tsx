import { useCallback, useSyncExternalStore, type ComponentType } from "react";

/** A row that one feature contributes to a settings section owned by another feature. */
export interface SettingsSectionExtensionRow {
  /** Stable identity, unique within its section. */
  id: string;
  /** Renders the row, including its own settings reads and saves. */
  Row: ComponentType;
}

const EMPTY: readonly SettingsSectionExtensionRow[] = [];
const rowsBySection = new Map<string, readonly SettingsSectionExtensionRow[]>();
const listeners = new Set<() => void>();

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
  const current = rowsBySection.get(sectionId) ?? EMPTY;
  if (current.some((existing) => existing.id === row.id)) {
    throw new Error(`Settings section ${sectionId} already has a row ${row.id}`);
  }
  rowsBySection.set(sectionId, [...current, row]);
  notify();
  return () => {
    const remaining = (rowsBySection.get(sectionId) ?? EMPTY).filter((entry) => entry !== row);
    rowsBySection.set(sectionId, remaining);
    notify();
  };
}

/** Rows registered for a section, in registration order. The array is replaced on change. */
export function listSettingsSectionRows(sectionId: string): readonly SettingsSectionExtensionRow[] {
  return rowsBySection.get(sectionId) ?? EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Render the rows other features registered for `sectionId`; renders nothing when none exist. */
export function SettingsSectionExtensionRows({ sectionId }: { sectionId: string }) {
  const read = useCallback(() => listSettingsSectionRows(sectionId), [sectionId]);
  const rows = useSyncExternalStore(subscribe, read, read);
  return (
    <>
      {rows.map(({ id, Row }) => (
        <Row key={id} />
      ))}
    </>
  );
}
