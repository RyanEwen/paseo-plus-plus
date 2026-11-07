import { UnistylesRuntime } from "react-native-unistyles";
import { resolveAccentColors, type AccentColor } from "@/styles/accent";
import { PLUGIN_THEME_NAMES, REGISTERED_THEMES, type Theme } from "@/styles/theme";

interface AccentAppearanceInput {
  choice: AccentColor;
  contributedTheme: Theme | null;
}

/**
 * Patch accent tokens for every scheme without changing typography or status colors.
 * Authored inputs make reset and repeated applications independent of earlier overrides.
 * A selected plugin supplies its own base; Default restores its contributed palette.
 */
export function applyAccentAppearance({ choice, contributedTheme }: AccentAppearanceInput): void {
  const keys = Object.keys(REGISTERED_THEMES) as (keyof typeof REGISTERED_THEMES)[];
  const active = UnistylesRuntime.themeName;
  // Unistyles web emits after each registry patch, so patch the mounted theme first: its
  // subscribers then receive the new accent in this render instead of one value behind.
  const ordered = active ? [active, ...keys.filter((key) => key !== active)] : keys;

  for (const key of ordered) {
    let base: Theme = REGISTERED_THEMES[key];
    if (contributedTheme && key === PLUGIN_THEME_NAMES[contributedTheme.colorScheme]) {
      base = contributedTheme;
    }
    const colors = resolveAccentColors(base, choice);
    UnistylesRuntime.updateTheme(key, (theme) => {
      // Identical arms on purpose: narrowing on colorScheme lets each spread keep its own
      // scheme's literal theme type, which a spread over the union would lose (as in apply.ts).
      if (theme.colorScheme === "light") {
        return { ...theme, colors: { ...theme.colors, ...colors } };
      }
      return { ...theme, colors: { ...theme.colors, ...colors } };
    });
  }
}
