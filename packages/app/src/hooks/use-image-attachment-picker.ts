import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  normalizePickedImageAssets,
  pickImagesWithDesktopDialog,
  type PickedImageAttachmentInput,
} from "@/hooks/image-attachment-picker";
import { isWeb } from "@/constants/platform";
import {
  getImageAttachmentPickerFailure,
  type ImageAttachmentPickerStage,
} from "@/hooks/image-attachment-picker-error";

interface UseImageAttachmentPickerResult {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
}

export function useImageAttachmentPicker(): UseImageAttachmentPickerResult {
  const { t } = useTranslation();
  const [mediaPermission, requestMediaPermission] = ImagePicker.useMediaLibraryPermissions();
  const isPickingRef = useRef(false);

  const ensurePermission = useCallback(async () => {
    let currentPermission = mediaPermission;

    if (
      !currentPermission ||
      currentPermission.status === ImagePicker.PermissionStatus.UNDETERMINED
    ) {
      currentPermission = await requestMediaPermission();
    } else if (!currentPermission.granted) {
      currentPermission = await requestMediaPermission();
    }

    if (!currentPermission?.granted) {
      Alert.alert(
        t("imageAttachmentPicker.permissionTitle"),
        t("imageAttachmentPicker.permissionMessage"),
      );
      return false;
    }

    return true;
  }, [mediaPermission, requestMediaPermission, t]);

  const pickImages = useCallback(async () => {
    if (isPickingRef.current) {
      return null;
    }

    isPickingRef.current = true;
    let stage: ImageAttachmentPickerStage = "permission";

    try {
      if (isWeb && isElectronRuntime()) {
        stage = "desktop-dialog";
        const selectedImages = await pickImagesWithDesktopDialog(getDesktopHost()?.dialog);
        if (selectedImages.length === 0) {
          return null;
        }
        return selectedImages;
      }

      const hasPermission = await ensurePermission();
      if (!hasPermission) {
        return null;
      }

      stage = "pending-result";
      const pendingResult = await ImagePicker.getPendingResultAsync();
      if (pendingResult && "canceled" in pendingResult && !pendingResult.canceled) {
        stage = "pending-normalization";
        return await normalizePickedImageAssets(pendingResult.assets);
      }

      stage = "library-launch";
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"] as ImagePicker.MediaType[],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled) {
        return null;
      }

      stage = "selection-normalization";
      return await normalizePickedImageAssets(result.assets);
    } catch (error) {
      console.error(
        "[ImageAttachmentPicker] Failed to pick image:",
        getImageAttachmentPickerFailure(stage, error),
      );
      Alert.alert(t("imageAttachmentPicker.errorTitle"), t("imageAttachmentPicker.failedToSelect"));
      return null;
    } finally {
      isPickingRef.current = false;
    }
  }, [ensurePermission, t]);

  return { pickImages };
}
