# Workspace notifications

Agent and terminal notifications name their workspace, with the project name included when it fits. Desktop and browser alerts use the project's icon. Mobile alerts keep the Paseo icon alongside the workspace text. Status and message previews remain visible below the workspace name.

[Agent-aware attention](agent-aware-attention.md) keeps routine agent-directed results quiet and gives explicit human escalation its own chat target.

Chat notifications open their owning workspace, including older notifications without a workspace link. Windows banners and Notification Center entries retain their chat targets across app restarts.

Opening a workspace clears its existing notifications across connected devices. Dismissing an alert in Windows or Android also clears that alert on your other devices. Offline or closed apps catch up when reopened; Windows swipe synchronization requires Paseo to remain running, including minimized in the tray. Newer alerts and notifications for other workspaces stay in place. Hosts must support notification synchronization.

Private Windows and Android builds passed dedicated-VM checks for Windows workspace reads clearing Android background alerts on resume, Android workspace reads selectively clearing Windows alerts, and Android tray swipes being preserved while the app process is absent and synchronized on reopen. These checks do not establish release availability, physical-device or iOS behavior, or general chat/startup reliability. Android workspace-loading and earlier ANR observations remain separate unresolved issues.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/fix/notification-workspace-routing). The guide on `main` describes the integrated behavior.
