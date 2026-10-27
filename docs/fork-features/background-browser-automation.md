# Background browser automation

Resident browser tabs keep their page identity while hidden. Background typing and key commands target the browser field without stealing focus from your current input. Explicit browser clicks remain pointer actions and may change focus.

This behavior was verified in a private packaged Windows VM candidate, including minimized operation, selected-text replacement and contenteditable child targets. Released builds, physical Windows hardware and other platforms remain unverified.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/fix/fork-browser-background-agent-access). The guide on `main` describes the integrated behavior.
