# PiCode

PiCode 是一个面向 Pi 的 Tauri 桌面客户端。它的 Web UI 和 mirror 工作流参考了 [`deflating/tau`](https://github.com/deflating/tau)，并在此基础上改造成桌面端应用：可以在后台启动 Pi，让用户不需要手动打开终端执行 `pi`，就能聊天、查看本地会话、继续指定会话，并安装 Pi 扩展和软件包。

English README: [README.md](README.md)

## 主要能力

- 桌面端启动后自动在后台启动 Pi。
- 桌面 UI 参考并改造了 Tau 的设计和 mirror 工作流。
- 发布包使用构建机本机已安装的 `pi` 作为打包来源。
- 按平台打包 Node runtime 和 Pi npm 包。
- 开发环境保留 `PI_DESKTOP_CLI` 和系统 `PATH` 里的 `pi` 作为 fallback。
- 在“扩展”页面可管理全局 Pi 软件包，支持 `npm:`、`git:` 和本地路径来源。
- 支持项目文件夹模式和无文件夹模式。
- 从 `~/.pi/agent/sessions` 读取本地历史会话。
- 点击侧边栏会话后，直接读取对应 JSONL 文件并在该会话里继续聊天。
- 设置页显示 Pi 运行时信息和当前 Pi 版本。
- 扩展页展示 Pi 扩展示例，并安装到 `~/.pi/agent/extensions`。
- Windows、macOS、Linux 使用同一套“打包 Node + Pi 包”的机制。

## 环境要求

- Node.js 20+。
- pnpm 10+（建议通过 Corepack 启用）。
- Rust stable toolchain。
- 当前平台所需的 Tauri v2 构建依赖。
- 构建机器上已经安装并可运行 Pi：

```bash
pi --version
```

最终用户安装桌面端后，不需要自己在终端启动 `pi`。

## 本地开发

安装依赖：

```bash
pnpm install
npm install --omit=dev --prefix ./src-tauri/extensions
```

启动开发模式：

```bash
pnpm tauri:dev
```

如果 Vite 已经在 `127.0.0.1:1420` 运行，可以复用它：

```bash
pnpm tauri:dev:reuse
```

前端构建：

```bash
pnpm build
pnpm typecheck
pnpm test
```

前端现使用 React 19 + TypeScript，由 Vite 构建。`src/app` 存放类型化应用
控制器与状态层，`src/components` 存放工作台视图，`src/lib` 维护 Tauri、API
与传输协议。根前端统一使用 pnpm；随应用打包的旧 mirror 扩展仍保持独立的
npm 安装，因为 Pi 会把该资源作为独立包加载。

Rust 检查：

```bash
cargo check --manifest-path ./src-tauri/Cargo.toml
```

## Pi 随应用打包

发布构建会把构建机本机的 Pi runtime 复制到 Tauri resources 中。应用运行时优先使用资源目录里的 bundled Pi，并在后台启动。

平台目录：

- `src-tauri/binaries/windows-x64/`
- `src-tauri/binaries/macos-x64/`
- `src-tauri/binaries/macos-arm64/`
- `src-tauri/binaries/linux-x64/`

每个平台目录内包含：

- `node` 或 `node.exe`
- `pi-package/`
- 一个用于人工排查的小 `pi` wrapper

Windows：

```powershell
.\scripts\vendor-pi-sidecar-windows.ps1
```

macOS/Linux：

```bash
./scripts/vendor-pi-sidecar-unix.sh
```

如果 macOS/Linux 上自动检测不到正确的 Node 或 Pi 包，可以显式指定：

```bash
NODE_BIN="$(command -v node)" PI_PACKAGE="$(npm root -g)/@earendil-works/pi-coding-agent" ./scripts/vendor-pi-sidecar-unix.sh
```

开发调试时可以覆盖 Pi 可执行文件：

```bash
PI_DESKTOP_CLI=/path/to/pi pnpm tauri:dev
```

## 发布构建

Windows：

```powershell
.\scripts\build-release.ps1 -Debug
```

包含 smoke test：

```powershell
.\scripts\build-release.ps1 -Smoke -Debug
```

macOS/Linux：

```bash
./scripts/build-release.sh --debug
```

手动 debug 打包：

```bash
pnpm exec tauri build --debug
```

Windows 上如果 `target/debug/PiCode.exe` 正在运行，打包会因为无法覆盖 exe 而失败。关闭正在运行的 PiCode 后重新执行即可。

## 会话机制

PiCode 从这里读取 Pi 会话：

```text
~/.pi/agent/sessions
```

侧边栏会按项目文件夹分组展示会话。点击某个会话后，应用会直接读取对应的 JSONL 文件并渲染历史消息。该会话也会成为当前聊天目标，之后发送的新消息会追加到这个会话里，而不是只读查看历史。

无文件夹模式会使用应用自己的目录，适合用户不想选择项目文件夹、只想直接聊天的场景。

## 扩展

扩展页会从以下位置读取 Pi 扩展示例：

1. 当前系统安装的 Pi 包
2. bundled Pi 包中的 `src-tauri/binaries/<platform>/pi-package/examples/extensions`

安装后的扩展会复制到：

```text
~/.pi/agent/extensions
```

如果扩展目录里有 `package.json`，安装后会执行：

```bash
npm install --omit=dev
```

新打开的 Pi 会话会加载这些扩展，所以安装扩展后建议重启 Pi 或打开新的项目会话。

## 验证

推荐检查：

```powershell
pnpm build
cargo check --manifest-path .\src-tauri\Cargo.toml
.\scripts\smoke-pi-tau.ps1 -ProjectPath D:\myproduction\PiCode -Port 3991 -TimeoutSeconds 45
pnpm exec tauri build --debug
```

macOS/Linux 请在目标平台执行：

```bash
./scripts/build-release.sh --debug
```

## 常见问题

Pi 没有启动：

- 确认构建机器上 `pi --version` 可用。
- 重新运行对应平台的 vendor 脚本。
- 查看应用配置目录下的 `pi-studio/logs` 日志（为兼容已有设置，仍沿用旧目录名）。
- 开发环境可以设置 `PI_DESKTOP_CLI` 指向一个确定可用的 Pi。

侧边栏没有会话：

- 确认 `~/.pi/agent/sessions` 下存在 JSONL 会话文件。
- 点击侧边栏刷新按钮。
- 从 PiCode 重新启动 Pi，让 mirror extension 刷新实时状态。

Windows 打包提示无法覆盖 `PiCode.exe`：

- 关闭正在运行的 PiCode 窗口。
- 在任务管理器中确认没有 `PiCode.exe`。
- 重新执行 `pnpm exec tauri build --debug`。

## 说明

PiCode 不是 Tau 项目本体。它参考并改造了 Tau 的浏览器 UI 与 mirror extension 思路，用于提供独立的桌面端体验。对外桌面端产品名是 `PiCode`。

## 来源说明

本项目参考 [`deflating/tau`](https://github.com/deflating/tau) 的浏览器化 Pi UI 和 mirror 工作流。Tau 上游仍是独立项目；PiCode 在此基础上实现了 Tauri 桌面客户端、Pi 后台启动、本地会话管理和扩展安装等桌面端能力。
