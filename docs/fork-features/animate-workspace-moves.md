# Animate workspace moves

Follow workspaces as status changes or expanding and collapsing projects move them to new positions with quick transitions. Turn this off in **Settings → Paseo++ → Animate workspace moves**. Animations also stop when the system asks for reduced motion, and they preserve collapsed groups and display limits. They run on web, desktop and the mobile apps.

When expanding one project at a time, the sidebar brings the selected project header to the top of the visible list as groups above it collapse. Scrolling, touching or pressing a key in the sidebar stops following the header; the project still expands.

In the Status view, a workspace keeps its row while its status moves it to another group, so an open rename dialog stays open with its draft. On web and desktop, if the focused row moves into a collapsed group or behind **Show more**, focus moves to that group's header.

Rows only slide when the same workspaces stay listed. When an update adds or removes a row, such as a new workspace, a filter change or **Show more**, the list settles without animating that update.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/feat/sidebar-workspace-transitions). The guide on `main` describes the integrated behavior.
