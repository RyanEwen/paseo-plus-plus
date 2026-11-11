import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Preview the current accent's message bubble with sample text. It draws only the bubble, from the
 * same userMessage* tokens and bubble shape as a sent message, without the message's timestamp,
 * copy or rewind controls, which would show meaningless values for a sample.
 */
export function AccentPreview({ message }: { message: string }) {
  return (
    <View style={styles.container} testID="accent-message-preview">
      <View style={styles.bubble} testID="accent-message-preview-bubble">
        <Text style={styles.text} testID="accent-message-preview-text">
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  // Matches the sent user message bubble in components/message.tsx.
  bubble: {
    backgroundColor: theme.colors.userMessageBackground,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    maxWidth: "100%",
  },
  text: {
    color: theme.colors.userMessageForeground,
    fontSize: theme.fontSize.content,
  },
}));
