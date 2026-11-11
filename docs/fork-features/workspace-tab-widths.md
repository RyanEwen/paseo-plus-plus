# Workspace tab widths

Main-pane desktop tabs have a 96 px minimum width, so short names such as Dev stay comfortable to select. Tabs keep their natural width and never shrink to fit: the strip scrolls as soon as they no longer fit. Explorer tabs keep the smaller 64 px minimum, because the Explorer dock can be as narrow as 240 px.

**Wider workspace tabs** in Paseo++ settings, on by default, lets long tab titles use up to 50% more width before they truncate. Short tabs keep their content width.

## Icon-only Explorer tabs

Right-click an Explorer tab or the empty Explorer tab strip and choose **Icon-only tabs** to hide tab labels. On compact layouts, long-press an Explorer tab instead. Tab names stay available in tooltips and to screen readers, and the tabs keep their context menu actions. Icon-only tabs have no inline close button; close them from their context menu.

On wide layouts, icon-only tabs are squares the size of the strip’s + control: 28 px with a mouse, 32 px on a touch screen. On compact layouts they are 44 px squares, so each one stays an easy touch target.

The Explorer section of Paseo++ settings shows a note pointing to these menus; the toggle itself lives only in the menus.

See [Mobile workspace tabs](mobile-workspace-tabs.md) for phone tab sizing and actions.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/fix/workspace-tab-min-width). The guide on `main` describes the integrated behavior.
