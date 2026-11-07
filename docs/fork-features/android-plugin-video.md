# Android plugin video

Compatible plugins can display encoded video in workspace panels and recover playback after decoder errors. A plugin that supplies video is required.

## Platforms

- Android only. Other platforms report that video is unavailable; browser plugins use WebCodecs directly.
- Requires an Android System WebView with WebCodecs. On older versions the plugin reports that the WebView needs an update.
- Codec support depends on the device's WebView. Check H.264 on a real device: automated tests cover VP8 only, because the test browser has no H.264 decoder.

## Limits

- No settings or controls; the plugin decides when video plays.
- Paseo tells the plugin when its panel is off-screen so it can pause; playback resumes from a fresh keyframe.
- If Android stops the video renderer to reclaim memory, the plugin reports an error and playback can resume once the canvas reloads.
- The plugin API limits are in the [plugin reference](../../public-docs/plugins/reference.md#encoded-video-on-android).
