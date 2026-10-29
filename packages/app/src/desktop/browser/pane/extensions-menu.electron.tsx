import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { BrowserExtensionsIcon } from "@/components/icons/browser-extensions-icon";
import { Pin, PinOff } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost, type DesktopBrowserExtensionAction } from "@/desktop/host";
import { Alert } from "@/components/ui/alert";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { ToolbarMenuContent, useToolbarMenuTriggerStyle } from "./toolbar-menu-trigger.electron";

const ThemedPuzzle = withUnistyles(BrowserExtensionsIcon);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ACTIONS_QUERY_KEY = ["desktop", "browser", "extension-actions"];

const mutedIcon = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

interface ExtensionsMenuProps {
  browserId: string;
  triggerStyle(state: { hovered?: boolean; pressed?: boolean }): StyleProp<ViewStyle>;
  tooltipTextStyle: StyleProp<TextStyle>;
}

/** Expose actual extension popups alongside installation and management in browser chrome. */
export function ExtensionsMenu({ browserId, triggerStyle, tooltipTextStyle }: ExtensionsMenuProps) {
  const { t } = useTranslation();
  const menuTriggerStyle = useToolbarMenuTriggerStyle(triggerStyle);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const bridge = getDesktopHost()?.browser?.extensions;
  const actions = useFetchQuery({
    queryKey: [...ACTIONS_QUERY_KEY, browserId],
    dataShape: "list",
    staleTimeMs: 0,
    enabled: Boolean(bridge),
    queryFn: async () => {
      if (!bridge) {
        throw new Error(t("settings.general.browserExtensions.unavailable"));
      }
      return bridge.actions(browserId);
    },
  });
  useEffect(
    () =>
      bridge?.onChanged(() => {
        void queryClient.invalidateQueries({ queryKey: ACTIONS_QUERY_KEY });
      }),
    [bridge, queryClient],
  );
  const pin = useMutation({
    mutationFn: async (extension: DesktopBrowserExtensionAction) => {
      if (!bridge) throw new Error(t("settings.general.browserExtensions.unavailable"));
      await bridge.setPinned(extension.id, !extension.pinned);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACTIONS_QUERY_KEY }),
    onError: () => setOpen(true),
  });
  const action = useMutation({
    mutationFn: async (id: string | null) => {
      if (!bridge) {
        throw new Error(t("settings.general.browserExtensions.unavailable"));
      }
      if (id === null) {
        await bridge.openStore();
      } else {
        await bridge.openPopup(id, browserId);
      }
    },
    onError: () => setOpen(true),
  });
  const label = t("workspace.browser.extensions.label");
  const { mutate } = action;
  const openStore = useCallback(() => mutate(null), [mutate]);
  const manage = useCallback(() => router.push(buildSettingsSectionRoute("browser")), [router]);
  let status: ReactNode = null;
  if (actions.error) {
    status = <DropdownMenuItem disabled>{actions.error.message}</DropdownMenuItem>;
  } else if (actions.isPending) {
    status = (
      <DropdownMenuItem disabled>{t("workspace.browser.extensions.loading")}</DropdownMenuItem>
    );
  } else if (actions.data.length === 0) {
    status = (
      <DropdownMenuItem disabled>{t("workspace.browser.extensions.empty")}</DropdownMenuItem>
    );
  }

  return (
    <View style={styles.toolbar}>
      {(actions.data ?? [])
        .filter((extension) => extension.pinned)
        .map((extension) => (
          <PinnedExtensionButton
            key={extension.id}
            extension={extension}
            busy={action.isPending}
            pending={action.isPending && action.variables === extension.id}
            openPopup={mutate}
            triggerStyle={triggerStyle}
            tooltipTextStyle={tooltipTextStyle}
            noPopupLabel={t("workspace.browser.extensions.noPopup")}
          />
        ))}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              accessibilityRole="button"
              accessibilityLabel={label}
              style={menuTriggerStyle}
            >
              <ToolbarMenuContent>
                <ThemedPuzzle size={16} uniProps={mutedIcon} />
              </ToolbarMenuContent>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <Text style={tooltipTextStyle}>{label}</Text>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" width={300} scrollable maxHeight={360}>
          {action.error ? (
            <Alert
              variant="error"
              size="sm"
              title={t("workspace.browser.extensions.openFailed")}
              description={action.error.message}
            />
          ) : null}
          {pin.error ? (
            <Alert
              variant="error"
              size="sm"
              title={t("workspace.browser.extensions.pinFailed")}
              description={pin.error.message}
            />
          ) : null}
          {status}
          {(actions.data ?? []).map((extension) => (
            <ExtensionMenuItem
              key={extension.id}
              extension={extension}
              busy={action.isPending}
              noPopupLabel={t("workspace.browser.extensions.noPopup")}
              openPopup={mutate}
              pinBusy={pin.isPending}
              togglePin={pin.mutate}
              pinLabel={t(
                extension.pinned
                  ? "workspace.browser.extensions.unpin"
                  : "workspace.browser.extensions.pin",
                { name: extension.name },
              )}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={action.isPending} onSelect={openStore}>
            {t("settings.general.browserExtensions.openStore")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={manage}>
            {t("workspace.browser.extensions.manage")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function PinnedExtensionButton({
  extension,
  busy,
  pending,
  openPopup,
  triggerStyle,
  tooltipTextStyle,
  noPopupLabel,
}: Omit<ExtensionsMenuProps, "browserId"> & {
  extension: DesktopBrowserExtensionAction;
  busy: boolean;
  pending: boolean;
  openPopup(id: string): void;
  noPopupLabel: string;
}) {
  const select = useCallback(() => openPopup(extension.id), [extension.id, openPopup]);
  const disabled = !extension.hasPopup || busy;
  const accessibilityState = useMemo(() => ({ disabled, busy: pending }), [disabled, pending]);
  const buttonStyle = useCallback(
    (state: { hovered?: boolean; pressed?: boolean }) => [
      triggerStyle(state),
      pending && styles.pendingAction,
    ],
    [triggerStyle, pending],
  );
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={actionLabel(extension, extension.name)}
          accessibilityState={accessibilityState}
          aria-busy={pending}
          disabled={disabled}
          onPress={select}
          style={buttonStyle}
        >
          <ExtensionIcon extension={extension} />
        </PressHighlight>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={tooltipTextStyle}>
          {extension.hasPopup
            ? actionLabel(extension, extension.title)
            : `${actionLabel(extension, extension.title)} (${noPopupLabel})`}
        </Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface ExtensionMenuItemProps {
  extension: DesktopBrowserExtensionAction;
  busy: boolean;
  noPopupLabel: string;
  openPopup(id: string): void;
  pinBusy: boolean;
  togglePin(extension: DesktopBrowserExtensionAction): void;
  pinLabel: string;
}

function ExtensionMenuItem({
  extension,
  busy,
  noPopupLabel,
  openPopup,
  pinBusy,
  togglePin,
  pinLabel,
}: ExtensionMenuItemProps) {
  const select = useCallback(() => openPopup(extension.id), [extension.id, openPopup]);
  const toggle = useCallback(() => togglePin(extension), [extension, togglePin]);
  const leading = useMemo(() => <ExtensionIcon extension={extension} />, [extension]);
  const pinIcon = useMemo(
    () =>
      extension.pinned ? (
        <ThemedPinOff size={16} uniProps={mutedIcon} />
      ) : (
        <ThemedPin size={16} uniProps={mutedIcon} />
      ),
    [extension.pinned],
  );
  const secondaryAction = useMemo(
    () => (
      <DropdownMenuItem
        iconOnly
        closeOnSelect={false}
        accessibilityLabel={pinLabel}
        tooltip={pinLabel}
        disabled={pinBusy}
        onSelect={toggle}
        leading={pinIcon}
      />
    ),
    [pinLabel, pinBusy, toggle, pinIcon],
  );
  return (
    <DropdownMenuItem
      leading={leading}
      accessibilityLabel={actionLabel(extension, extension.name)}
      secondaryAction={secondaryAction}
      disabled={!extension.hasPopup || busy}
      description={extension.hasPopup ? undefined : noPopupLabel}
      onSelect={select}
    >
      {extension.name}
    </DropdownMenuItem>
  );
}

function ExtensionIcon({ extension }: { extension: DesktopBrowserExtensionAction }) {
  const source = useMemo(() => ({ uri: extension.iconDataUrl ?? "" }), [extension.iconDataUrl]);
  const badge = extension.badge;
  const background = badgeColor(badge?.backgroundColor);
  const foreground = badgeColor(badge?.textColor) ?? contrastBadgeText(badge?.backgroundColor);
  return (
    <View style={styles.icon}>
      {extension.iconDataUrl ? (
        <Image source={source} style={styles.icon} />
      ) : (
        <ThemedPuzzle size={16} uniProps={mutedIcon} />
      )}
      {badge?.text ? (
        <View pointerEvents="none" style={styles.badge(background)}>
          <Text numberOfLines={1} style={styles.badgeText(foreground)}>
            {Array.from(badge.text).slice(0, 4).join("")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Keep the full extension-provided label accessible even when the icon overlay is clipped. */
function actionLabel(extension: DesktopBrowserExtensionAction, base: string): string {
  return extension.badge?.text ? `${base} (${extension.badge.text})` : base;
}

/** Serialize only bounded numeric channels; extension strings never become app CSS. */
function badgeColor(color: number[] | null | undefined): string | undefined {
  if (
    !color ||
    color.length !== 4 ||
    !color.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    return undefined;
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`;
}

/** When no text color is set, choose black or white for the extension's supplied background. */
function contrastBadgeText(color: number[] | null | undefined): string | undefined {
  if (!badgeColor(color) || !color || color[3] === 0) return undefined;
  const luminance = color.slice(0, 3).map((n) => {
    const channel = n / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return luminance[0] * 0.2126 + luminance[1] * 0.7152 + luminance[2] * 0.0722 > 0.179
    ? "#000000"
    : "#ffffff";
}

const styles = StyleSheet.create((theme) => ({
  toolbar: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  icon: { width: 16, height: 16 },
  pendingAction: { opacity: 0.5 },
  badge: (background?: string) => ({
    position: "absolute",
    right: -6,
    bottom: -4,
    maxWidth: 28,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[0.5],
    backgroundColor: background ?? theme.colors.accent,
  }),
  badgeText: (foreground?: string) => ({
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: foreground ?? theme.colors.accentForeground,
  }),
}));
