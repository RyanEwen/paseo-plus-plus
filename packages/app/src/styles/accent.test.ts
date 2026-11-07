import { describe, expect, it } from "vitest";
import { REGISTERED_THEMES } from "./theme";
import { ACCENT_OPTIONS, ACCENT_PALETTE, resolveAccentColors } from "./accent";

/** Red, green and blue channels of an opaque `#rrggbb` color, each in 0-255. */
function hexChannels(hex: string): [number, number, number] {
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

/** Relative sRGB luminance for the opaque authored accent palette. */
function luminance(hex: string): number {
  const [red, green, blue] = hexChannels(hex).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

/** WCAG contrast ratio, independent of which color is brighter. */
function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composite opaque colors for the shared Button pressed opacity. */
function blend(foreground: string, background: string, alpha: number): string {
  const front = hexChannels(foreground);
  const back = hexChannels(background);
  const channels = front.map((value, index) =>
    Math.round(value * alpha + back[index] * (1 - alpha))
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${channels.join("")}`;
}

/** HSL saturation of an opaque color, 0-1. */
function saturation(hex: string): number {
  const channels = hexChannels(hex).map((value) => value / 255);
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  if (maximum === minimum) return 0;
  const lightness = (maximum + minimum) / 2;
  return (maximum - minimum) / (1 - Math.abs(2 * lightness - 1));
}

describe("Accent colors", () => {
  it("keeps optional accent fills muted in both color schemes", () => {
    for (const pair of Object.values(ACCENT_PALETTE)) {
      for (const hex of Object.values(pair)) {
        expect(saturation(hex)).toBeLessThanOrEqual(0.35);
      }
    }
  });

  it.each(Object.entries(REGISTERED_THEMES))(
    "restores authored Default colors for %s",
    (_name, base) => {
      expect(resolveAccentColors(base, "default")).toEqual({
        accent: base.colors.accent,
        accentBright: base.colors.accentBright,
        accentForeground: base.colors.accentForeground,
        userMessageBackground: base.colors.surface3,
        userMessageForeground: base.colors.foreground,
        userMessageMutedForeground: base.colors.foregroundMuted,
      });
    },
  );

  it.each(ACCENT_OPTIONS.filter((choice) => choice !== "default"))(
    "%s meets text and control contrast across authored themes",
    (choice) => {
      for (const base of Object.values(REGISTERED_THEMES)) {
        const colors = resolveAccentColors(base, choice);
        expect(contrast(colors.accent, colors.accentForeground)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(colors.userMessageBackground, colors.userMessageForeground),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(colors.userMessageBackground, colors.userMessageMutedForeground),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.accent, base.colors.surface0)).toBeGreaterThanOrEqual(3);
        expect(contrast(colors.accent, base.colors.surface1)).toBeGreaterThanOrEqual(3);
        // The transparent ghost disclosure fades only its text over the bubble.
        const disclosurePressed = blend(
          colors.userMessageForeground,
          colors.userMessageBackground,
          0.85,
        );
        expect(contrast(disclosurePressed, colors.userMessageBackground)).toBeGreaterThanOrEqual(
          4.5,
        );
        for (const surface of [base.colors.surface0, base.colors.surface1]) {
          const pressedFill = blend(colors.accent, surface, 0.85);
          const pressedText = blend(colors.accentForeground, surface, 0.85);
          expect(contrast(pressedFill, pressedText)).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );
});
