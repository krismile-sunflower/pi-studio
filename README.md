# pi-studio

pi-studio is a Tauri desktop client for Pi. Its web UI is built with reference to [`deflating/tau`](https://github.com/deflating/tau), then adapted into a desktop app that starts a bundled Pi RPC process in the background, browses local Pi sessions, continues selected sessions, and installs Pi extensions without requiring users to open a terminal.

中文文档: [README.zh-CN.md](README.zh-CN.md)

## What It Does

- Starts Pi automatically from the desktop app.
- Provides a desktop UI based on ideas and implementation patterns from Tau.
- Uses native Pi RPC over the bundled child process by default, without a local mirror WebSocket server.
- Uses the build machine's installed `pi` as the release packaging source.
- Bundles platform-specific Node runtime and Pi npm package under `src-tauri/binaries/<platform>/`.
- Resolves Pi in this order: `PI_DESKTOP_CLI`, bundled Pi, then system `pi` on `PATH`.
- Supports project mode and no-folder mode.
- Reads local sessions from `~/.pi/agent/sessions`.
- Allows selecting a session in the sidebar and continuing chat in that session.
- Shows Pi runtime information, including the current Pi version, in Settings.
- Lists Pi extension examples and installs selected extensions into `~/.pi/agent/extensions`.
- Runs on Windows, macOS, and Linux with the same bundled runtime mechanism.

## Requirements

- Node.js 20+.
- Rust stable toolchain.
- Tauri v2 prerequisites for your platform.
- A working local Pi install on the build machine:

```bash
pi --version
```

The final installed app does not require the end user to start `pi` manually.

## Development

Install dependencies:

```bash
npm install
npm install --omit=dev --prefix ./src-tauri/extensions
```

Start the app in development:

```bash
npm run tauri:dev
```

If Vite is already running on `127.0.0.1:1420`, reuse it:

```bash
npm run tauri:dev:reuse
```

Useful frontend commands:

```bash
npm run build
npm run preview
```

Useful backend check:

```bash
cargo check --manifest-path ./src-tauri/Cargo.toml
```

## Pi Runtime Packaging

Release builds vendor the build machine's installed `pi` runtime into Tauri resources. pi-studio then launches the bundled Pi process in the background.

Platform resource directories:

- `src-tauri/binaries/windows-x64/`
- `src-tauri/binaries/macos-x64/`
- `src-tauri/binaries/macos-arm64/`
- `src-tauri/binaries/linux-x64/`

Each platform directory contains:

- `node` or `node.exe`
- `pi-package/`
- a small `pi` wrapper for manual debugging

Windows:

```powershell
.\scripts\vendor-pi-sidecar-windows.ps1
```

macOS/Linux:

```bash
./scripts/vendor-pi-sidecar-unix.sh
```

If auto-detection cannot find the right Node or Pi package on macOS/Linux, override them explicitly:

```bash
NODE_BIN="$(command -v node)" PI_PACKAGE="$(npm root -g)/@earendil-works/pi-coding-agent" ./scripts/vendor-pi-sidecar-unix.sh
```

Development override:

```bash
PI_DESKTOP_CLI=/path/to/pi npm run tauri:dev
```

Legacy mirror/WebSocket transport is still available for compatibility:

```bash
PI_DESKTOP_TRANSPORT=mirror npm run tauri:dev
```

## Release Builds

Windows:

```powershell
.\scripts\build-release.ps1 -Debug
```

With smoke test:

```powershell
.\scripts\build-release.ps1 -Smoke -Debug
```

macOS/Linux:

```bash
./scripts/build-release.sh --debug
```

Manual debug build:

```bash
npx tauri build --debug
```

Generated installers use the `pi-studio` product name. On Windows, if `target/debug/pi-studio.exe` is currently running, close the app before rebuilding because Windows will not overwrite a running executable.

## Sessions

pi-studio reads Pi session files from:

```text
~/.pi/agent/sessions
```

The sidebar groups sessions by project folder. Selecting a session loads the underlying JSONL file directly and makes that session the current chat target. Sending a new message after selecting a session appends to that selected session instead of opening a disconnected read-only history view.

No-folder mode uses an app-owned directory and is useful when the user wants to chat without selecting a project folder.

## Extensions

The Extensions page reads Pi extension examples from:

1. the installed system Pi package
2. the bundled Pi package under `src-tauri/binaries/<platform>/pi-package/examples/extensions`

Installed extensions are copied into:

```text
~/.pi/agent/extensions
```

Directory extensions with `package.json` run:

```bash
npm install --omit=dev
```

New Pi sessions pick up installed extensions, so restart Pi or open a new project session after installing an extension.

## Verification

Recommended checks:

```powershell
npm run build
cargo check --manifest-path .\src-tauri\Cargo.toml
.\scripts\smoke-pi-tau.ps1 -ProjectPath D:\myproduction\pi-studio -Port 3991 -TimeoutSeconds 45
npx tauri build --debug
```

The smoke script checks native Pi RPC by default. Add `-Mirror` to run the legacy Tau mirror health check as well.

macOS/Linux should run the equivalent build script on the target platform:

```bash
./scripts/build-release.sh --debug
```

## Troubleshooting

If Pi does not start:

- Confirm `pi --version` works on the build machine.
- Re-run the vendor script for your platform.
- Check app logs under the platform config directory, for example `pi-studio/logs`.
- In development, set `PI_DESKTOP_CLI` to a known working Pi executable.

If sessions do not appear:

- Confirm files exist under `~/.pi/agent/sessions`.
- Click the session refresh button.
- Start or restart Pi from pi-studio so the native RPC session can refresh live state.

If Windows debug build cannot overwrite `pi-studio.exe`:

- Close the running pi-studio window.
- Check Task Manager for `pi-studio.exe`.
- Run `npx tauri build --debug` again.

## Notes

pi-studio is not presented as the Tau project itself. It references and adapts Tau's browser UI for a standalone desktop experience, while the desktop app talks to Pi through native RPC by default. The public desktop product name is `pi-studio`.

## Attribution

This project references [`deflating/tau`](https://github.com/deflating/tau) for the browser-based Pi UI and mirror workflow. Upstream Tau remains a separate project; pi-studio adapts those ideas into a Tauri desktop client with bundled Pi startup, native RPC transport, local session management, and extension installation.
