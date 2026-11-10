# Keep user prompts in view

Keep user prompts in view works on desktop only. Phone apps and narrow windows show ordinary chat messages without a pinned prompt or prompt arrows, and the phone apps do not show the setting.

Keep the prompt for your reading position at the top of the conversation. With this feature on, ordinary chat messages stay fully expanded. The original keeps scrolling until its bottom reaches the bottom of its shortened preview at the top of the conversation; scrolling back crosses the same boundary. A last prompt with too little content after it can remain ordinary at the bottom. Only the pinned prompt uses a compact one-line presentation. The bubble and text keep their original horizontal position and wrapping; More… covers the right end of the line instead of pushing it aside. Compact previews omit attachment counts. More… opens the full text and attachments. Less… stays inside the bubble over the right side of the text; it returns the preview to one line. While a prompt is pinned, its original position keeps the full message's space.

Use the arrows to move between prompts, or click a pinned prompt to return to its original position. Incoming messages leave an older reading selection in place. Jump to latest returns to the newest messages above the composer.

An available prompt stays visible while earlier context loads. If no prompt is available, a muted system placeholder appears in the same position. A genuine loading failure keeps an actionable Retry there; explicit navigation failures retain their own Retry.

Turn **Keep user prompts in view** off in **Paseo++ → Optional features** to disable pinning and restore standard collapsed message previews. Use **Show more** and **Show less** to expand and collapse those messages.

For developer ownership and history-loading rules, see [Prompt navigation](../timeline-sync.md#prompt-navigation).

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/feat/sticky-user-message-navigation).
