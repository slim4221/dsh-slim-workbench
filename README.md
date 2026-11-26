# Slim 工作台（Slim workbench）

A persistent **workbench** panel in the DeepSeek Harness sidebar: one home for the systems on
this machine that you switch or drive. One system is one entry in the panel's left menu and one
self-contained pane, so adding a system leaves the shell alone.

Two systems now:

- **Node.js** — switch, install, and remove the versions nvm-windows manages, with the published
  release list and its LTS channels. The only system that also exposes an agent tool
  (`node_version`).
- **Launchers** — add a command such as `npm run dev`, start it with one click, watch its output,
  and stop it. No agent tool on purpose: it runs commands you author.

## 中文说明

- 侧边栏的「插件」「定时任务」之后多了一个四格图标（面板标题「Slim 工作台」）。点开在中间栏渲染，不需要会话。**一个系统 = 左侧「系统」里的一项 = 一个自带整块内容区的模块**；加系统是加法，面板外壳不变。
- **Node.js**：顶部状态条显示当前链接的版本、nvm 版本和两个路径；「已安装」页可切换/卸载；「可安装」页列出 nodejs.org 上已发布、带 Windows 构建的版本，可搜索、只看 LTS、隐藏已安装，点「安装」走 `nvm install`。这一项额外给智能体 `node_version` 工具。
- **一键启动**：点「选择文件夹」挑项目 → 从 `package.json` 的全部 `scripts` 里选一条、再选包管理器（npm/pnpm/yarn/bun，**两者都必须自己选，不预选**）→ 可选锁定 Node 版本、填端口与优先级 →「保存并启动」。运行中显示已运行时长，端口就绪后给出 `localhost` 与局域网 IP 两个链接；关掉面板不影响进程，「停止」会杀掉整棵进程树。
- 条目存在 `$DSH_HOME/slim-workbench/launchers.json`（v2；v1 条目自动读成自定义命令），**不写你的 profile 配置，也绝不改动项目目录**。
- 缺东西立刻 warning：目录不存在、没选脚本/包管理器、`package.json` 解析失败、脚本已改名、依赖未装、锁文件与已选包管理器不一致、锁定的 Node 版本未安装 —— 阻断项直接禁用启动并说明原因。
- 关闭面板不影响进程运行；「停止」会杀掉整棵进程树；插件被卸载时会停掉所有运行中的进程。
- 一键启动**没有**给智能体工具：它执行的是你自己写的命令，启动这件事应当由你点。
- nvm 装在非默认位置时，在本插件的行配置里设置 `nvmHome` / `symlink`（见下文），GUI 里没有对应的配置表单。

## The Node.js system

The sidebar's Workbench icon (a four-square launcher glyph, after the shipped Plugins and
Schedules entries) opens a main panel that needs no Session: the panel key is not
`conversation`, so it renders even before any Session exists.

- **Status strip** — a live dot, the version in use, the nvm version, and both nvm paths.
- **Installed tab** — one row per installed version with its state. The version in use is
  marked and cannot be switched to or removed; the others offer **Switch** and **Remove**.
- **Available tab** — the stable Node.js releases that ship a Windows build, newest first, each
  with its channel (`LTS <name>` or `Current`), release date, and an **Install** action. The
  toolbar filters the list: free-text search, **LTS only**, and **Hide installed**. The list is
  read from `https://nodejs.org/dist/index.json` — the index nvm-windows installs from — and
  cached for ten minutes.
- **Feedback** — an in-flight banner names the version being switched, installed, or removed;
  every outcome ends in a banner. A failed action re-reads the state, because a partly applied
  `nvm` command must not leave the page asserting a version.

## The launcher system

An entry remembers **what you chose**, not a pre-joined command string:

| Field | Meaning |
|---|---|
| `projectPath` | The project directory, picked with the host's native folder dialog (or typed). A legacy `cwd` key is still honored when read. |
| `kind` | `script` (a `package.json` script) or `custom` (free command text). |
| `pm` + `script` | The package manager and the script name; the command is composed at launch (`npm run dev`, `pnpm run dev`, …). Required — neither is preselected. |
| `nodeVersion` | `null` follows the workbench's linked version; a version pins **this child only** by putting `…\nvm\vX.Y.Z` first on its `PATH`, leaving the machine-wide symlink alone. |
| `port` | Optional; used for the readiness probe and the links. Recognized from output when omitted. |
| `priority` | Integer in `0…99`, default `1`; smaller starts earlier, and `0` is the most urgent level — it is only ever set by hand, never applied by default. It never reorders the visible list. |
| `facts` | The stored inspection snapshot: git branch, change count, warnings, and when it was taken. |
| `batchEnabled` | Whether the top-bar **Batch start** covers this entry. Default `true`; a legacy `batch` key is still honored when read. |

Choosing a folder reads it **once** (read-only) and shows what it found: the full `scripts` list, the lockfile, the git branch, `.nvmrc`/`engines.node`. It never preselects a script or a package manager; the lockfile name is written beside the control as a hint only.

## What the list costs

Saving an entry inspects its directory once and stores the result with the entry; **opening the
panel reads no project directory at all** — no `git` call, no `package.json` read, no pause. Each
row's **Refresh** button re-reads that snapshot on demand, and an entry saved before snapshots
existed is inspected once on first read and stamped.

Because of that, a row's branch and warnings are as fresh as its last save or refresh; **Refresh**
is what updates them when a branch, lockfile, or script changed outside the workbench.

| Action | Effect |
|---|---|
| Add / Edit | Saves the entry and its fresh snapshot. |
| Refresh | Re-inspects one project and stores the new snapshot. |
| Start / Stop | Spawns the chosen command; stop kills the whole tree. |
| Delete | Armed by the first click, deleted by the second; disarms itself after four seconds. |

Warnings are shown where they are decided, not after a failure: a missing directory, an unparsed `package.json`, a script that has since been renamed, missing `node_modules`, a lockfile that disagrees with the chosen package manager, or a pinned Node version that is not installed. A blocking one disables Start and says why.

Runs live inside the Harness process: closing the panel leaves them running, and unloading the plugin stops every one of them. A row shows **Starting… / Ready** with elapsed time, then **Running**, **Exited (code)**, or **Stopped**; while starting, a three-segment bar tracks spawned → output seen → port answering, with no invented percentage.

## What the launcher never does

The project directory is **read-only** for this plugin:

- It reads `package.json`, lockfiles, `.nvmrc`, and `git status`; it never writes, creates, renames, or deletes anything inside a project.
- It never installs dependencies (`npm/pnpm/yarn/bun install`), never edits lockfiles, and never repairs `package.json`.
- It never runs a mutating git command — no `switch`, `checkout`, `add`, `commit`, `stash`, or `clean`. The branch is displayed, never changed.
- It only stops a child it started itself, identified by the `ChildProcess` handle it holds; it never kills by process name.
- Its own writes go to `$DSH_HOME/slim-workbench/launchers.json` and nowhere else.

A project's own dev server may write its own caches (`node_modules/.vite`, `.next`, `dist`). That is the command you started, not this plugin.

There is deliberately no agent tool for launchers. They execute commands the user authors, so
starting one stays a user action instead of something the model can trigger.

## Adding another system

`client.js` keeps one registry:

```js
const SYSTEMS = [
  { id: 'node', titleKey: 'title', component: NodeSystem },
  { id: 'launch', titleKey: 'launchTitle', component: LauncherSystem },
]
```

Each entry needs a stable `id` (the navigation key), the copy key its navigation label comes
from, and a component that renders the whole pane — its own heading, its pinned controls, and
one scrolling region for its rows (see `.ndv-pinned` and `.ndv-scroll` in `SYSTEM_STYLES`).
Add its strings to `EN` and `ZH`, and the system appears in the workbench with no other change.

## The `node_version` tool

| Call | Effect |
|---|---|
| `action: "list"` | Reports the nvm paths, the current version, and the installed versions. |
| `action: "releases"` | Lists the newest published versions that have a Windows build. |
| `action: "use"` + `version` | Switches to that installed version. |
| `action: "install"` + `version` | Installs that published version through nvm. |
| `action: "uninstall"` + `version` | Removes that installed version. The version in use is refused. |

The panel and the tool call the same Host functions, so an operation reports the same outcome
either way.

## Where the nvm paths come from

Resolution order, first match wins:

| Value | Sources |
|---|---|
| nvm home | plugin config `nvmHome`, `%NVM_HOME%`, `%APPDATA%\nvm`, `C:\nvm`; the first one holding `nvm.exe` wins |
| nvm.exe | plugin config `nvmExe`, else `<nvm home>\nvm.exe` |
| version store | the `root:` line of `<nvm home>\settings.txt` when it exists, else the nvm home |
| symlink | plugin config `symlink`, `%NVM_SYMLINK%`, the `path:` line of `settings.txt`, else `%ProgramFiles%\nodejs` |

Optional row configuration, for an install outside those defaults:

```yaml
- insert:
    - id: slim-workbench
      name: '@local/slim-workbench'
      config:
        nvmHome: 'D:\nvm'
        symlink: 'D:\nodejs'
```

## Install from Git (GitHub or any other host)

This package needs no build step, no dependencies, and no install scripts, so it can be
installed straight from a Git repository:

```sh
# Pin a commit: every reinstall follows the commit in the spec.
plugin_manager install_bundle target="git+https://github.com/<you>/dsh-slim-workbench.git#<commit-sha>"
```

The installer accepts any Git host — `git+https://…`, `git@host:owner/repo`, or a plain
`https://host/owner/repo(.git)` URL — plus a local or HTTP tarball ending in `.tgz`. A private
repository uses the machine's own Git credentials; the installer never prompts, so configure an
SSH key or a credential helper first.

### Updating

A Git install carries no version list: `listVersions` refuses it, so nothing offers a "newer
version" for one. Updating means installing the new commit; **and `version` in package.json must
increase** (`semver.gt` against the installed version), because the Host's `updateBundle` refuses a
Git copy whose target version is not greater. Bump `version`, commit, push, reinstall with the new
SHA.

After the first install the profile holds a **copy** of the package, so edits in a working
checkout no longer take effect; reinstall with the new commit, or keep developing through a
`link:` entry in the profile's `package.json`. Installing under the same package name replaces
whichever entry carried that name before, so remove a `link:` row first if both should coexist.

### Distribution note

"Official" in the Plugin Manager means a `@deepseek-ai/*` package shipped with the Harness itself;
this package is a profile plugin. It can be distributed through the community catalog
(`awesome-dsh-plugin`, which the market reads), through npm, or straight from a repository.
## Requirements and limits

## Platforms

| | Windows | macOS / Linux |
|---|---|---|
| Panel, table, editor, batch start | ✅ | ✅ |
| Start / stop (whole process tree) | `taskkill /PID … /T /F` | child leads its own process group (`detached`), `SIGTERM` then `SIGKILL` |
| Per-entry Node.js pinning | nvm-windows store (`…\nvm\vX`) | nvm (`~/.nvm`/`$NVM_DIR`), fnm (macOS + Linux), volta, asdf — the version's `bin` goes on that child's `PATH` |
| Machine-wide version switching | ✅ `nvm use` | ❌ a version belongs to a shell: `nvm alias default` / `fnm default` in your terminal |
| Everything else (git reads, port probe, LAN IP, folder picker) | ✅ | ✅ |

Machine-wide switching is the one Windows-only feature: macOS's nvm has no symlink to rewrite, so
the Node.js tab shows what is installed and explains where to switch. Launcher entries still pin a
version per project on every platform.
- A pinned Node version only changes that child's `PATH`. The package manager itself runs on it,
  so pinning an old Node under a manager that needs a newer one (pnpm needs Node ≥ 18) fails
  inside the package manager — the row shows its error tail. `nvm use` remains the machine-wide
  switch.
- Launcher entries are stored as `version: 2`; a `version: 1` entry is read as a custom command
  and upgraded on the next save.
- The folder inspector tolerates a UTF-8 BOM in `package.json`; a file it still cannot parse is
  reported and the entry falls back to a custom command. Nothing is repaired on disk.
- Reading the release list needs network access to `nodejs.org`, and installing downloads the
  release from there through nvm (roughly 30 MB per version). The launcher's own objects come
  from your own saved entries; nothing else is sent anywhere. The browser half talks only to
  this plugin's routes on the local Harness server, which the host's connection gate protects
  like its own API.
- `nvm use` rewrites the symlink, so new terminals and programs pick the new version up.
  Already-running programs, DeepSeek Harness included, keep the version they started with;
  restart DeepSeek Harness to run it on the new version.
- The version in use cannot be removed, and `nvm install` of a version that does not exist is
  reported as a failure: nvm-windows exits 0 for "not yet released", so the version store
  decides whether anything was installed.
- Launcher commands run with your shell, so shell quoting applies exactly as it would in your
  own terminal. Closing the panel does not stop them; unloading the plugin does.
