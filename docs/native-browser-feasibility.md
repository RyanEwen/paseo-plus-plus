# Desktop browser engine and qualification

## Selected feature and qualification boundary

The desktop browser uses resident DOM Electron `<webview>` guests and Electron's
bundled Chromium. Each tab keeps its guest while hidden or moving between panes.
Pages and extensions keep the shared persistent profile. Device presets retain their
requested page-CSS size across independent page and app zoom; responsive pages fill
their pane. A separate Chromium engine,
CEF, WebView2 and the old X11 embedding experiment are not shipping dependencies.

Menus and modals use the normal DOM overlay plane above the browser. Opening one
does not capture a still frame or hide the page. The earlier main-owned
WebContentsView path, its menu still-frame handoff and the separate-engine prototype
were removed; their research and evidence stay in git history and do not qualify
the DOM path.

The Gorhom 5.2.14 tracked patch still owns ordinary modal/provider scheduling. Its
removal condition is documented in `scripts/postinstall-patches.mjs`.

Keeping a guest resident preserves tab identity; it does not establish reliable
background keyboard input on Windows. Live video beneath menus, clipping, focus,
fixed viewports and hidden automation need acceptance on the restored Windows build.
The stock Electron path does not inherit OWL's custom guest or input behavior.

Practical extension support remains subject to Electron's API behavior. Changing view
type does not expand that contract. Installation, popup/worker behavior and individual
extensions need separate qualification; see [Browser](../public-docs/browser.md).
Automatic extension updates are disabled. The reported Windows build signs in and
autofills from the Bitwarden popup, but inline UI and page context-menu state remain
unresolved in that build.

Electron 44.5.1 and 44.9 both reproduced the upstream worker storage notification loss
([#52451](https://github.com/electron/electron/issues/52451)). The source repair retains
stock Electron and native storage, using a private windowless extension-origin listener
and authenticated worker delivery. Its worker-preload readiness gate addresses initial
writes as well as normal worker restart. Linux public-sentinel evidence qualifies that
ordering and window exclusion, not Windows or third-party extension acceptance. A
native engine build is not part of this fix. Observer failure/cancellation is covered
by focused source tests; real native crash recovery and natural-idle behavior remain
separate acceptance work.

## Acceptance gates

| Area                 | Required evidence                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background rendering | Fresh independent top/bottom markers beyond host dimensions; exact CSS viewport and physical scale after opening, navigation, reload and resize. Repeat with inactive pane/workspace, hidden host and verified minimized host. No host animation-frame dependency or foreground leases.                                                                                  |
| Keyboard and input   | Trusted click/type/wheel/held gestures. Seed host typing, run automation and type again; all keys stay with the human target. Repeat with another application and IME composition. Window-focus IDs alone do not pass.                                                                                                                                                   |
| Extension corpus     | Test an owned MV3 probe plus current versions of a password manager, content blocker, page annotator/user-script tool, developer extension and tab-management extension. Include a native-messaging/OAuth case as a separately reported capability. Record publisher, ID, version, source and permissions; choose exact packages only after registry/store verification. |
| Extension behaviour  | Popup/action context and activeTab identity, content scripts, cross-frame injection, scripting/tabs/events, worker idle wake/restart, alarms, local/session storage, request rules and permissions. Install, disable/enable, restart, update and removal must be independent receipts.                                                                                   |
| Store and updates    | Complete one real Web Store installation with consent and stable ID/signature; preserve version/storage through restart; test a controlled signed update independently. An unpacked probe is not Web Store/update proof. Preserve the existing disabled choice and review permission expansion.                                                                          |
| Native UI fidelity   | Popups/select/context menus, keyboard accelerators, clipboard, drag/drop, screen-reader tree, IME, permissions, file upload/download dialogs and DevTools. Browser-created surfaces stay in the intended host workflow.                                                                                                                                                  |
| State                | Keep unsaved drafts through presentation changes; preserve fresh-profile login/cookies/storage and extension state. Never open an Electron profile concurrently in Chromium. Any production migration requires explicit reversible export/import and a retained source profile.                                                                                          |
| Ownership/recovery   | Concurrent capture/input, cancellation and stale target rejection, human/agent control transitions, browser crash, host view destruction, shutdown and engine update. Never replay a mutation with unknown outcome or silently recreate a tab.                                                                                                                           |
| Security/package     | Sandbox active, no public/debug TCP listener, bounded IPC messages, complete bundled resources and notices, no first-run download.                                                                                                                                                                                                                                        |

Broad compatibility means recording an extension-by-extension result matrix,
not declaring success from one content script. Capture extension popup pixels
alongside the page when agents need them, while preventing agent shortcuts from
controlling privileged host/browser UI. Ordinary compatibility failures remain
visible for Ryan to judge.
