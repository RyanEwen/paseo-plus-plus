import { formatFileSize } from "@/utils/format-file-size";
import { i18n } from "@/i18n/i18next";
import type { AndroidUpdateState } from "./store";

/** The update state the description depends on; callers pass the values they already selected. */
export type AndroidUpdateDescriptionInput = Pick<
  AndroidUpdateState,
  "status" | "update" | "error" | "progress"
>;

/** User-facing copy for the current update operation, shared by Settings and the sidebar callout. */
export function describeAndroidUpdate({
  status,
  update,
  error,
  progress,
}: AndroidUpdateDescriptionInput): string {
  if (status === "downloading" && progress) {
    const bytes = formatFileSize(progress.bytesDownloaded);
    if (progress.totalBytes && progress.totalBytes > 0) {
      const percent = Math.min(
        100,
        Math.round((progress.bytesDownloaded / progress.totalBytes) * 100),
      );
      return i18n.t("androidUpdates.downloadProgress", {
        percent,
        downloaded: bytes,
        total: formatFileSize(progress.totalBytes),
      });
    }
    return i18n.t("androidUpdates.downloadBytes", { downloaded: bytes });
  }
  if (status === "error") return error ?? i18n.t("androidUpdates.failed");
  if (status === "available" && update) {
    return i18n.t("androidUpdates.available", { version: update.version });
  }
  return i18n.t(`androidUpdates.${status}`);
}
