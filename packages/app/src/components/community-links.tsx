import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/icons/github-icon";
import { FORK_LINKS } from "@/paseo-plus-plus/links";
import { openExternalUrl } from "@/utils/open-external-url";

const renderGitHubIcon = (color: string) => <GitHubIcon color={color} size={14} />;

export function CommunityLinks() {
  const handleOpenGitHub = useCallback(() => {
    void openExternalUrl(FORK_LINKS.repository);
  }, []);

  return (
    <View style={styles.row}>
      <Button
        variant="ghost"
        leftIcon={renderGitHubIcon}
        onPress={handleOpenGitHub}
        testID="community-links-github-star"
      >
        Star
      </Button>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  row: {
    flexDirection: "row",
    // Shrinks and wraps rather than running off a narrow phone screen.
    flexShrink: 1,
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 0,
  },
}));
