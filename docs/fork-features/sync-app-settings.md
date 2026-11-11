# Sync app settings

Choose a settings host in Paseo++ on Android or desktop to share preferences across your clients, including whether Usage appears in the sidebar, chat display and the Enter or Ctrl/Cmd+Enter send shortcut. Fonts, text sizes, content width, terminal scrollback, keyboard mode, link and pane placement, automatic Explorer opening, platform-specific tab, layout and update toggles, connection details, project filters, workspace order and collapsed groups stay on each device. See [app preferences](../data-model.md#app-preferences) for the full scope.

Switching hosts loads that host's saved settings before you can edit shared ones. An empty host stays empty until you publish this device's settings to it. Device preferences stay editable while the settings host is unavailable or read-only. If the host rejects the shared part of a save, the device part is still kept.

Your settings host needs a daemon build with settings sync support. Older hosts show an update instruction for the chat preferences, and publishing to them leaves those fields out; device-only use and local backups keep both. Shared settings refresh when the connection's write permission changes, and Retry recovers a failed read without restarting the app or replacing saved preferences.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/feat/app-settings-sync). The guide on `main` describes the integrated behavior.
