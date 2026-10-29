export type ImageAttachmentPickerStage =
  | "desktop-dialog"
  | "permission"
  | "pending-result"
  | "pending-normalization"
  | "library-launch"
  | "selection-normalization";

/** Returns only the failed operation and a bounded Expo code, without serializing image details. */
export function getImageAttachmentPickerFailure(stage: ImageAttachmentPickerStage, error: unknown) {
  let code: unknown;

  try {
    if (error !== null && typeof error === "object") {
      // Expo errors own a code value. Do not invoke accessors or inspect messages and causes.
      code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    }
  } catch {
    // Diagnostic inspection must not replace the original failure or prevent the alert.
  }

  return {
    stage,
    code: typeof code === "string" && /^ERR_[A-Z_]{1,80}$/.test(code) ? code : "unknown",
  };
}
