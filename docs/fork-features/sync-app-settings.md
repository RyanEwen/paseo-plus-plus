# Sync app settings

Choose a settings host in Paseo++ on Android or desktop to share preferences across your clients, including whether Usage appears in the sidebar. Switching hosts loads their saved settings first; an empty host requires an explicit publish action. Connection details, project filters, workspace order and collapsed groups stay local. Your settings host needs a daemon build with settings sync support. Shared settings refresh when the connection’s write permission changes. Retry recovers failed initial reads without leaving editing disabled. Read-only connections can retry the read without restarting the app or replacing saved preferences.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/feat/app-settings-sync). The guide on `main` describes the integrated behavior.
