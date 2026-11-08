import { useMemo } from "react";
import { useToolCallSheet } from "@/components/tool-call-sheet";
import type { AdditionalFile, AdditionalFilesControl } from "./additional-files";

/**
 * Prepare a row's additional files for the details view, or undefined when it has none. Opening
 * a file closes the tool-call sheet first, so the file is not left behind it on compact layouts.
 */
export function useAdditionalFilesControl(
  files: readonly AdditionalFile[],
  onOpenFilePath: ((path: string) => void) | undefined,
): AdditionalFilesControl | undefined {
  const { closeToolCall } = useToolCallSheet();
  return useMemo(() => {
    if (files.length === 0) {
      return undefined;
    }
    if (!onOpenFilePath) {
      return { files, onOpenFile: undefined };
    }
    const onOpenFile = (path: string) => {
      closeToolCall();
      onOpenFilePath(path);
    };
    return { files, onOpenFile };
  }, [files, onOpenFilePath, closeToolCall]);
}
