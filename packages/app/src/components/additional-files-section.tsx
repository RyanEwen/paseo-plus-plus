import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  additionalFileDiffLines,
  type AdditionalFile,
  type AdditionalFilesControl,
} from "@/tool-calls/additional-files";
import { highlightDiffLines } from "@/utils/diff-highlight";
import { DiffViewer } from "./diff-viewer";

const ADDITIONAL_FILE_DIFF_MAX_HEIGHT = 240;

interface AdditionalFileRowProps {
  file: AdditionalFile;
  onOpenFile: AdditionalFilesControl["onOpenFile"];
}

/** A deleted file no longer exists, so its path stays plain text. */
function AdditionalFileRow({ file, onOpenFile }: AdditionalFileRowProps) {
  const { t } = useTranslation();
  const diffLines = useMemo(
    () => highlightDiffLines(additionalFileDiffLines(file), file.path),
    [file],
  );
  const open = useCallback(() => onOpenFile?.(file.path), [onOpenFile, file.path]);
  const canOpen = Boolean(onOpenFile) && file.kind !== "delete";

  return (
    <View style={styles.file} testID="tool-call-additional-file">
      {canOpen ? (
        <Pressable
          onPress={open}
          accessibilityRole="link"
          accessibilityLabel={`${t("message.actions.openFile")}: ${file.displayPath}`}
          testID="tool-call-additional-file-open"
        >
          <Text style={styles.link} numberOfLines={1}>
            {file.displayPath}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.path} numberOfLines={1}>
          {file.displayPath}
        </Text>
      )}
      {diffLines.length > 0 ? (
        <DiffViewer diffLines={diffLines} maxHeight={ADDITIONAL_FILE_DIFF_MAX_HEIGHT} />
      ) : null}
    </View>
  );
}

/** The files of a patch batch beyond the one the row's canonical detail shows. */
export function AdditionalFilesSection({ control }: { control: AdditionalFilesControl }) {
  const { t } = useTranslation();
  return (
    <View style={styles.section} testID="tool-call-additional-files">
      <Text style={styles.title}>{t("toolActivity.additionalFiles")}</Text>
      {control.files.map((file) => (
        <AdditionalFileRow key={file.path} file={file} onOpenFile={control.onOpenFile} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  file: {
    gap: theme.spacing[1],
  },
  path: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  link: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textDecorationLine: "underline",
  },
}));
