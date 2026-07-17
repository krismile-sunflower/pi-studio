# Pi Sidecar Runtime

PiCode vendors the build machine's installed Pi runtime into a platform-specific directory before release builds.

Expected directories:

- `windows-x64/`
- `macos-x64/`
- `macos-arm64/`
- `linux-x64/`

Each directory contains:

- `node` or `node.exe`
- `pi-package/` copied from the build machine's installed `@earendil-works/pi-coding-agent`
- optional `pi`/`pi.cmd`/`pi.ps1` wrappers for manual debugging

At runtime the desktop app prefers the bundled Node executable and runs:

```text
node pi-package/dist/cli.js --mode rpc --extension <mirror-server.ts> --no-approve
```

During development PiCode can still fall back to the globally installed `pi` command, or the executable pointed to by `PI_DESKTOP_CLI`.
