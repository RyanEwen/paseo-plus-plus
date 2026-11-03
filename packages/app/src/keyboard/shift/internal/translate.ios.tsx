import { DockReservationContext } from "./dock-reservation";
import { usePublishDockReservation } from "./use-dock-reservation";
import { KeyboardDockDisplacementContext } from "./dock-displacement.ios";
import { useMemo, useEffect, useRef, type ReactNode } from "react";
import { Animated, useAnimatedValue, type View, type ViewProps } from "react-native";
import { useKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardTranslationContext } from "./context";
import { useKeyboardTranslationScope } from "./measure";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
  /** Space below the view's resting position that the keyboard may fill before the view moves. */
  bottomClearance?: number;
}

export function KeyboardTranslateView({
  children,
  enabled = true,
  bottomClearance = 0,
  style,
  ...props
}: KeyboardTranslateViewProps) {
  const reservation = usePublishDockReservation(enabled, bottomClearance);
  const insets = useSafeAreaInsets();
  const { height, progress } = useKeyboardAnimation();
  const translateY = useMemo(
    () =>
      Animated.add(
        Animated.add(height, Animated.multiply(progress, insets.bottom)),
        bottomClearance,
      ).interpolate({
        inputRange: [-1, 0],
        outputRange: [-1, 0],
        extrapolateLeft: "extend",
        extrapolateRight: "clamp",
      }),
    [bottomClearance, height, insets.bottom, progress],
  );
  // Fullscreen resizes this view while disabling translation. iOS Fabric can
  // reapply its previous transform during that layout commit. Keep the graph
  // attached and apply the mode on the native animation frame; a static zero or
  // setValue during the React commit gets overwritten by the resize. A rebuilt
  // graph (a new bottomClearance after rotation) starts from JS-side keyboard
  // values, so run it on the native frame too or it stays stale until the
  // keyboard next moves.
  const enabledValue = useAnimatedValue(enabled ? 1 : 0);
  useEffect(() => {
    const animation = Animated.timing(enabledValue, {
      toValue: enabled ? 1 : 0,
      duration: 0,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [enabled, enabledValue, translateY]);
  // Measurement and sticky compensation must read the same gated native transform.
  const effectiveTranslateY = useMemo(
    () => Animated.multiply(translateY, enabledValue),
    [enabledValue, translateY],
  );
  const displacement = useMemo(
    () => Animated.multiply(effectiveTranslateY, -1),
    [effectiveTranslateY],
  );
  const keyboardStyle = useMemo(
    () => ({ transform: [{ translateY: effectiveTranslateY }] }),
    [effectiveTranslateY],
  );

  const frameRef = useRef<View>(null);
  const translation = useMemo(() => ({ enabled, bottomClearance }), [bottomClearance, enabled]);
  const scope = useKeyboardTranslationScope(frameRef, translation);

  return (
    <Animated.View ref={frameRef} style={[style, keyboardStyle]} {...props}>
      <KeyboardTranslationContext.Provider value={scope}>
        <KeyboardDockDisplacementContext.Provider value={displacement}>
          <DockReservationContext.Provider value={reservation}>
            {children}
          </DockReservationContext.Provider>
        </KeyboardDockDisplacementContext.Provider>
      </KeyboardTranslationContext.Provider>
    </Animated.View>
  );
}
