# Sidebar display options

Workspace hover details wait 250 ms before opening. Moving away cancels the popup before its content mounts. Keyboard activation stays immediate.

In Project mode, enable **Display → Expand one project at a time** to collapse other known project groups when you expand one. It starts off. Pinned and Status groups retain their existing behavior; **Expand all** still expands all visible groups.

Switch between Project and Status views with the bell beside the workspace heading. Each view keeps its own Display preferences and device-local host/project filters. Display includes sorting, labels, background workspaces, row details and activity. **Show background workspaces** reveals workspaces explicitly created for background work, which are normally hidden; it does not mean every workspace you are not currently viewing. Background visibility is retained across app reloads and reconnects. Project labels start visible; branch labels start hidden. A selected settings host must support separate sidebar modes before these synchronized controls can be edited.

The workspace chooser lists projects directly. With multiple hosts, its **Hosts** submenu filters them; projects from the selected hosts appear directly below it. Adding a project includes it in your current project selection. Host and label filters remain independent.

Dragging is available only when the applicable project or workspace sort is **Custom**; it never changes the sort mode. Sorted workspace rows remain selectable and their action menus stay available. A filtered project move stays before or after the same anchor project when **All** is shown, preserving the relative order of other projects. Pinned workspaces retain independent manual ordering. Project status sorting places **Done** before **No status**.

The filter icon beside the bell opens a quick text filter for the current mode. Match project or workspace names, titles and visible branches without changing the active workspace, saved order or sort. Project-name matches retain their scoped children; other matches retain the matching workspace and its project. Each mode keeps its own text for the current app session. Clear, close or press Escape to restore the list; collapsed sections keep their existing state.

In **Display → Empty projects**, choose **Show**, **Group**, or **Hide** for project groups with no visible workspaces.

In **Display → Workspace limits**, open **Count limit** or **Updated within** to choose each view’s limits independently. The count defaults to 20 and the age limit to All. Quick text matching runs before the count window, so a match beyond the first 20 can still appear. **Show more** reveals every matching workspace in that group, including older entries.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/feat/sidebar-display-preferences). The guide on `main` describes the integrated behavior.
