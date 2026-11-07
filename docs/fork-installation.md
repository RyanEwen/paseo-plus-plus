# Install Paseo++

Download desktop and Android builds from [Paseo++ releases](https://github.com/RyanEwen/paseo-plus-plus/releases). New builds discover updates from this repository directly. Builds are available for Windows and Linux (x64 and ARM64), plus Android. Windows and Linux AppImage builds receive updates from Paseo++ releases. The desktop app includes its own daemon. macOS is deferred until Apple signing is available; iOS and hosted web are excluded.

Older Android apps and standalone hosts update through the retained prerelease bridge; see [the release transition](release.md#final-prerelease-bridge-and-normal-latest-releases).

Paseo++ desktop and Android apps keep their own settings and identities, separate from upstream Paseo. Set up your hosts and preferences independently in each app. The desktop app also keeps its bundled daemon in `~/.paseo-plus-plus-desktop` on port 6790, separate from the standalone daemon. Existing desktop profiles that saved port 6767 retain that setting; changing the packaged default does not rewrite saved addresses.

## Standalone daemon (Linux and WSL)

Install Node.js 22 or newer and at least one agent CLI. Download the matching `paseo-daemon-<version>-linux-<arch>.tgz` from [Paseo++ releases](https://github.com/RyanEwen/paseo-plus-plus/releases). Use `x64` for Intel/AMD or `arm64` for ARM. Linux packages require glibc; Alpine/musl is unsupported.

Install the downloaded package, then start the daemon:

```bash
npm install -g ./paseo-daemon-<version>-linux-<arch>.tgz
paseo-plus-plus daemon run
```

Keep that terminal open, or use `paseo-plus-plus daemon run` as your service's command. The standalone daemon keeps its settings, host identity, agents, and workspaces in `~/.paseo-plus-plus` and listens on `127.0.0.1:6791`. Upstream Paseo and Paseo++ can run side by side with their defaults. Set up the new daemon independently and connect your app to it. These defaults apply to previews built with the `paseo-plus-plus` command.

Source-built daemons need to switch to a release package before the app can update them. See [sidebar host updates](fork-features/sidebar-host-updates.md) for when the sidebar offers **Update**.
