import { ScreenshotAnnotations, type ScreenshotOutline } from "./screenshot-annotations";
import type { ScreenshotArrow } from "./screenshot-arrow";
import { Image, Text, View, useWindowDimensions, type ImageRequireSource } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SettingsInfoTip } from "./headings/settings-info-tip";
import { fitScreenshotViewport, type ScreenshotViewport } from "./settings-example-fit";

/** Widest an example image frame grows, in display pixels. */
const EXAMPLE_MAX_WIDTH = 320;
/** Horizontal space kept free around the tip on narrow screens. */
const EXAMPLE_SCREEN_INSET = 48;
/** Extra width the tip surface needs around its content for padding and border. */
const TIP_FRAME_PADDING = 18;

export interface SettingsExampleImage {
  id: string;
  /** Static require of an actual local screenshot asset. Remote image URLs are not accepted. */
  source: ImageRequireSource;
  /** Original screenshot pixel dimensions. The bundled capture stays intact. */
  width: number;
  height: number;
  /** The contextual region to display, in original screenshot pixels. */
  viewport?: ScreenshotViewport;
  label?: "before" | "after";
  /** Optional pointers are a separate vector layer, never fabricated screenshot content. */
  arrows?: readonly ScreenshotArrow[];
  /** One outline can identify a menu item or a related group of icon controls. */
  outlines?: readonly ScreenshotOutline[];
}

interface SettingsExampleProps {
  title: string;
  caption: string;
  images?: readonly SettingsExampleImage[];
  testID: string;
}

/** Use the established help trigger; absent qualified screenshots produce text help only. */
export function SettingsExample({ title, caption, images, testID }: SettingsExampleProps) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const exampleWidth = Math.min(EXAMPLE_MAX_WIDTH, width - EXAMPLE_SCREEN_INSET);
  const hasImages = images !== undefined && images.length > 0;
  const annotated = hasImages && images.some((image) => image.arrows?.length);

  const content = hasImages ? (
    <View style={[styles.example, inlineUnistylesStyle({ width: exampleWidth })]}>
      {images.map((image) => (
        <SettingsExampleImageFrame
          key={image.id}
          image={image}
          maxWidth={exampleWidth}
          title={title}
          caption={caption}
        />
      ))}
      <Text style={styles.caption}>
        {caption}
        {annotated ? ` ${t("paseoPlusPlus.examples.annotated")}` : ""}
      </Text>
    </View>
  ) : (
    caption
  );

  return (
    <SettingsInfoTip
      title={title}
      info={content}
      testID={testID}
      contentTestID={`${testID}-content`}
      contentMaxWidth={exampleWidth + TIP_FRAME_PADDING}
    />
  );
}

interface SettingsExampleImageFrameProps {
  image: SettingsExampleImage;
  maxWidth: number;
  title: string;
  caption: string;
}

/** One screenshot region in its frame, with an optional before/after label and annotations. */
function SettingsExampleImageFrame({
  image,
  maxWidth,
  title,
  caption,
}: SettingsExampleImageFrameProps) {
  const { t } = useTranslation();
  const fitted = fitScreenshotViewport(image, maxWidth);
  const label = image.label ? t(`paseoPlusPlus.examples.${image.label}`) : undefined;
  const hasAnnotations = Boolean(image.arrows?.length || image.outlines?.length);

  return (
    <View style={styles.frame}>
      {label ? <Text style={styles.caption}>{label}</Text> : null}
      <View
        style={[
          styles.picture,
          inlineUnistylesStyle({ width: fitted.frameWidth, height: fitted.frameHeight }),
        ]}
      >
        <Image
          source={image.source}
          resizeMode="contain"
          accessibilityLabel={`${t("paseoPlusPlus.examples.imageLabel", { title })}. ${label ?? caption}`}
          style={[
            styles.image,
            inlineUnistylesStyle({
              width: fitted.imageWidth,
              height: fitted.imageHeight,
              left: fitted.imageLeft,
              top: fitted.imageTop,
            }),
          ]}
        />
        {hasAnnotations ? (
          <ScreenshotAnnotations
            width={fitted.viewport.width}
            height={fitted.viewport.height}
            arrows={image.arrows}
            outlines={image.outlines}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  example: { gap: theme.spacing[2] },
  frame: { gap: theme.spacing[1] },
  picture: {
    alignSelf: "flex-start",
    position: "relative",
    overflow: "hidden",
    borderRadius: theme.borderRadius.sm,
  },
  image: { position: "absolute" },
  caption: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
