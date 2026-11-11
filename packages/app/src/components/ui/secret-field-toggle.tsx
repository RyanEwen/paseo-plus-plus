import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Eye, EyeOff } from "lucide-react-native";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";

const ThemedEye = withUnistyles(Eye, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedEyeOff = withUnistyles(EyeOff, (theme) => ({ color: theme.colors.foregroundMuted }));

const styles = StyleSheet.create((theme) => ({
  // Boxed adornment beside a default-size field: the field chrome's height and radius
  // (fieldControlMd in control-geometry). ToolbarButton owns the interaction feedback.
  box: {
    height: CONTROL_HEIGHTS.md,
    width: CONTROL_HEIGHTS.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
}));

interface SecretFieldToggleProps {
  /** Whether the secret is currently shown in plain text. */
  isSecretVisible: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Accessible label while the secret is hidden. */
  showLabel: string;
  /** Accessible label while the secret is shown. */
  hideLabel: string;
  testID?: string;
}

/** Eye button that shows or hides the secret in the field beside it. */
export function SecretFieldToggle({
  isSecretVisible,
  onToggle,
  disabled,
  showLabel,
  hideLabel,
  testID,
}: SecretFieldToggleProps) {
  const isCompact = useIsCompactFormFactor();
  return (
    <ToolbarButton
      style={styles.box}
      compact={isCompact}
      onPress={onToggle}
      disabled={disabled}
      label={isSecretVisible ? hideLabel : showLabel}
      testID={testID}
    >
      {isSecretVisible ? <ThemedEyeOff size={18} /> : <ThemedEye size={18} />}
    </ToolbarButton>
  );
}
