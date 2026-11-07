import {
  type ComponentProps,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import type { EncodedVideoHandle, EncodedVideoProps } from "@getpaseo/plugin/client/ui";
import { createEncodedVideoBridge, type EncodedVideoBridge } from "./bridge";
import { encodedVideoRuntimeHtml } from "./runtime/html.gen";

const source = { html: encodedVideoRuntimeHtml, baseUrl: "https://paseo-video.invalid/" };
const originWhitelist = ["https://paseo-video.invalid"];
function allowNavigation(request: WebViewNavigation): boolean {
  return request.url === source.baseUrl || request.url === "about:blank";
}
const styles = StyleSheet.create({ canvas: { backgroundColor: "transparent" } });

/**
 * A private secure-origin canvas. The bridge owns readiness, the generation fence and
 * pending paints; this component only connects it to the WebView.
 */
export const EncodedVideo = forwardRef<EncodedVideoHandle, EncodedVideoProps>(
  function EncodedVideo(props, ref) {
    const webview = useRef<WebView>(null);
    const callbacks = useRef(props);
    callbacks.current = props;
    const bridgeRef = useRef<EncodedVideoBridge | null>(null);
    bridgeRef.current ??= createEncodedVideoBridge({
      transport: () => webview.current,
      callbacks: () => callbacks.current,
    });
    const bridge = bridgeRef.current;

    useImperativeHandle(ref, () => bridge.handle, [bridge]);
    useEffect(() => () => bridge.dispose(), [bridge]);

    const onMessage = useCallback(
      (event: WebViewMessageEvent) => bridge.receive(event.nativeEvent.data),
      [bridge],
    );
    const onError = useCallback<NonNullable<ComponentProps<typeof WebView>["onError"]>>(
      (event) => bridge.documentFailed(new Error(event.nativeEvent.description)),
      [bridge],
    );
    const onRenderProcessGone = useCallback(
      () => bridge.documentFailed(new Error("Video decoder process stopped")),
      [bridge],
    );

    return (
      <WebView
        ref={webview}
        source={source}
        originWhitelist={originWhitelist}
        onShouldStartLoadWithRequest={allowNavigation}
        onMessage={onMessage}
        onError={onError}
        onRenderProcessGone={onRenderProcessGone}
        javaScriptEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        style={[styles.canvas, props.style]}
      />
    );
  },
);
