import { requireOptionalNativeModule } from "expo-modules-core";
import { isPreviewBuild } from "@/constants/fork-build";
import type { AndroidUpdaterNative } from "./native-contract";

export const androidUpdaterNative = isPreviewBuild
  ? requireOptionalNativeModule<AndroidUpdaterNative>("PaseoAppUpdate")
  : null;
