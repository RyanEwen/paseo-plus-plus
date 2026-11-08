import Constants from "expo-constants";

/** Native app built as a Paseo++ preview, with its own identity and fork update channel. */
export const isPreviewBuild = Constants.expoConfig?.extra?.previewBuild === true;
