/**
 * Browser half of the nvm switcher: the Slim workbench panel beside the sidebar.
 *
 * The Slim workbench is the home for switchable development systems on this machine.
 * A system is one entry in `SYSTEMS`; Node.js is the first, and adding another
 * is one more entry with its own component. The panel is a sidebar panel icon
 * (`sidebar.panellist`) addressed to a main panel (`main`, key `workbench`), so
 * it renders in the center column without a Session.
 *
 * A system owns its whole pane: a pinned head (title, state, tabs) and one
 * scrolling region for its rows, so the list scrolls under a fixed header.
 *
 * Data comes from the Host half's routes; nothing here reads nvm or the network
 * directly. No Harness Client package is imported: a throwing import or
 * component blanks the slot entry. Controls and styles are this plugin's own,
 * built from the `--dsw-alias-*` theme tokens the shell publishes.
 */

window.__ModuleLoader__.load({
  id: 'dsh-slim-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'slim-workbench'
    /** Workbench panel id: the sidebar icon's id and the main panel's key. */
    const WORKBENCH_ID = 'workbench'
    /** Output lines the log view asks the Host for, and how often it re-reads them. */
    const LOG_VIEW_LINES = 200
    const LOG_POLL_MS = 1500
    /** How long one batch-started entry may take to answer on its port, per stack. */
    const BATCH_READY_TIMEOUT_MS = 3 * 60 * 1000
    /** A backend entry builds before it listens, so the Host waits longer for it. */
    const BATCH_READY_TIMEOUT_BACKEND_MS = 5 * 60 * 1000
    /** Host routes (document-relative, as the shell serves its own routes). */
    const ROUTES = {
      state: 'slim-workbench/state',
      releases: 'slim-workbench/releases',
      use: 'slim-workbench/use',
      install: 'slim-workbench/install',
      uninstall: 'slim-workbench/uninstall',
      launchState: 'slim-workbench/launch/state',
      launchSave: 'slim-workbench/launch/save',
      launchStart: 'slim-workbench/launch/start',
      launchStop: 'slim-workbench/launch/stop',
      launchRemove: 'slim-workbench/launch/remove',
      launchRefreshAll: 'slim-workbench/launch/refresh-all',
      launchBatchEnabled: 'slim-workbench/launch/batch-enabled',
      launchInspect: 'slim-workbench/launch/inspect',
      launchProbe: 'slim-workbench/launch/probe',
      launchLog: 'slim-workbench/launch/log',
    }

    /** The client context of this plugin's activation; set by `apply`. */
    let pluginCtx = null

    /** Package managers the launcher form offers, in the order it shows them. */
    const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun']

    /** Script names worth surfacing first; everything else follows alphabetically. */
    const SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview', 'build', 'test']

    /**
     * Sort a project's scripts by the familiar order. Ordering never preselects.
     * @param {Array<{ name: string, value: string }>} scripts the project's scripts.
     * @returns {Array<{ name: string, value: string }>} the sorted copy.
     */
    function orderedScripts(scripts) {
      const rank = (name) => {
        const index = SCRIPT_ORDER.indexOf(name)
        return index === -1 ? SCRIPT_ORDER.length : index
      }
      return [...scripts].sort((left, right) => (
        rank(left.name) - rank(right.name) || left.name.localeCompare(right.name)
      ))
    }

    /** English copy; also the fallback for a locale this plugin does not ship. */
    const EN = {
      workbench: 'Slim workbench',
      workbenchSubtitle: 'The development systems on this machine, one panel each.',
      systems: 'Systems',
      title: 'Node management',
      subtitle: 'The Node.js versions this machine has, and which one is in use.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      refreshingInstalled: 'Refreshing the installed versions…',
      refreshOnlyInstalled: 'Re-reads the locally installed versions only',
      loading: 'Reading the nvm-windows installation…',
      current: 'Node.js in use',
      none: 'No version linked',
      updatedAt: 'Updated',
      staleCache: 'The live read failed, so this is what was read at {time}.',
      inUse: 'Active',
      tabInstalled: 'Installed',
      tabAvailable: 'Available',
      searchPlaceholder: 'Search version',
      ltsOnly: 'LTS only',
      hideInstalled: 'Hide installed',
      colVersion: 'Version',
      colChannel: 'Channel',
      colDate: 'Released',
      colActions: 'Actions',
      channelCurrent: 'Current',
      alreadyInstalled: 'Installed',
      versionsCount: 'versions',
      use: 'Switch',
      switching: 'Switching…',
      busySwitching: 'Switching to v{version}…',
      install: 'Install',
      installing: 'Installing…',
      busyInstalling: 'Installing v{version} — nvm downloads it from nodejs.org…',
      uninstall: 'Remove',
      uninstalling: 'Removing…',
      busyUninstalling: 'Removing v{version}…',
      switchedTo: 'Switched to Node.js v{version}.',
      installDone: 'Installed Node.js v{version}.',
      uninstallDone: 'Removed Node.js v{version}.',
      switchFailedDetail: 'Switching to v{version} failed: {detail}',
      installFailed: 'Installing v{version} failed: {detail}',
      uninstallFailed: 'Removing v{version} failed: {detail}',
      unchanged: 'The version in use did not change.',
      noReason: 'nvm gave no reason',
      releasesLoading: 'Reading the published Node.js versions…',
      releasesFailed: 'The published version list could not be read.',
      releasesNone: 'No version matches these filters.',
      releasesSource: 'from nodejs.org, read {time}',
      emptyInstalled: 'No version is installed in this nvm store yet.',
      browseAvailable: 'See installable versions',
      unsupportedTitle: 'Version switching is unavailable on this system',
      unsupportedFound: '{count} Node.js version(s) found on this machine; launcher entries can pin one each.',
      unsupported: 'Machine-wide switching needs nvm-windows on Windows. On macOS and Linux a Node.js version belongs to a shell: switch it there (nvm alias default / fnm default). Batch (launcher) entries can still pin a version per project.',
      nvmMissing: 'nvm-windows not found',
      nvmMissingHint: 'Install nvm-windows, or set nvmHome in this plugin\'s row configuration to an installation that lives elsewhere (see the README).',
      lookedIn: 'Looked in',
      symlinkMissing: 'NVM_SYMLINK does not exist, so no version is linked right now.',
      readFailed: 'The nvm state could not be read.',
      retry: 'Try again',
      launchTitle: 'Frontend projects',
      launchSubtitle: 'One row per project: pick the folder, the script, and the Node version, then start it.',
      launchAdd: 'Add',
      launchEdit: 'Edit',
      launchNameLabel: 'Name',
      launchNamePlaceholder: 'Web front end',
      launchDirLabel: 'Directory',
      launchSave: 'Save',
      launchCancel: 'Cancel',
      launchStart: 'Start',
      launchStarting: 'Starting…',
      launchStop: 'Stop',
      launchStopping: 'Stopping…',
      launchRemove: 'Delete',
      launchStopped: 'Stopped',
      launchExited: 'Exited',
      launchLoading: 'Reading the launcher list…',
      launchLoadFailed: 'The launcher list could not be read.',
      launchStored: 'Stored in {path}',
      launchNote: 'Commands run through your shell in their own directory and keep running while the panel is closed. Stop kills the whole process tree, and the plugin stops every run when it unloads.',
      launchScriptLabel: 'Script',
      launchScriptPlaceholder: 'Select a script…',
      launchScriptCustom: 'Custom command…',
      launchCustomLabel: 'Command',
      launchCustomPlaceholder: 'pnpm --filter web dev',
      launchPmLabel: 'Package manager',
      launchNodeLabel: 'Node.js',
      launchNodeFollowValue: 'Follow the workbench ({version})',
      launchPortLabel: 'Port (optional)',
      launchPortPlaceholder: '5173',
      launchPriorityLabel: 'Priority',
      launchPriorityHint: 'Smaller is earlier. Stored for now, but nothing uses it yet: the start order is the list order.',
      launchPick: 'Choose folder',
      launchDetected: 'Detected {what} — a hint only',
      launchNoLockfile: 'No lockfile found: pick the package manager yourself',
      launchNeedPm: 'Pick a package manager',
      launchNeedScript: 'Pick a script',
      launchNeedCommand: 'Type the command to run',
      launchNeedName: 'Name this launcher',
      launchPhaseStarting: 'Starting…',
      launchPhaseReady: 'Ready',
      launchLanHint: 'If the LAN link does not answer, the server is not listening on 0.0.0.0 (add --host).',
      launchInspecting: 'Reading the folder…',
      launchInspectFailed: 'Could not read the folder: {message}',
      launchBlocked: 'This entry cannot start until its warning is fixed',
      refreshAllHint: "Re-read every project's branch, lockfile, and warnings",
      refreshAllBusy: 'Re-reading every project…',
      refreshMissing: 'These project folders are gone: {names}',
      actionsMore: 'More',
      launchScriptLoading: 'Reading scripts…',
      launchLog: 'Output',
      launchLogTitle: 'Output — {name}',
      launchLogEmpty: 'This run has not printed anything yet.',
      launchLogNoRun: 'This entry has not run since the plugin started.',
      launchLogHint: 'Only what this run printed; colour codes are stripped. It refreshes while the panel is open.',
      launchLogTruncated: 'Showing the last {count} lines.',
      removeTitle: 'Delete this launcher?',
      removeConfirm: 'Delete "{name}".',
      removeConfirmHint: 'Only the record in launchers.json is removed. The project directory is not touched.',
      removeConfirmRunning: 'It is running: its whole process tree is stopped first.',
      removing: 'Deleting...',
      backendTitle: 'Backend projects',
      backendSubtitle: 'Spring Boot services: pick the project and a profile, then start it.',
      launchNeedBuilder: 'Pick a build tool first',
      launchBuilderLabel: 'Build tool',
      launchBuilderMaven: 'Maven',
      launchBuilderGradle: 'Gradle',
      launchGoalLabel: 'Start goal',
      launchProfileLabel: 'Profile',
      launchProfileFollow: 'Default (as configured)',
      launchProfileHint: 'Spring profiles found in src/main/resources. Default uses spring.profiles.active.',
      launchCurrent: 'current',
      launchColProfile: 'Profile',
      launchNoBackendBuild: 'no pom.xml or build.gradle here',
      launchBuilderDetected: 'detected',
      launchNoNvm: 'no nvm on this machine: entries cannot pin a version',
      launchNoNodeVersions: 'no version installed yet: entries follow the machine default',
      launchNvmAbsentNote: 'No nvm on this machine: Node version pinning is unavailable, every entry runs on the system default Node.',
      launchBackendEmpty: 'No backend project yet.',
      launchFrontendEmpty: 'No frontend project yet.',
      launchBatch: 'Batch start',
      batchTitle: 'Batch start',
      batchMode: 'Start mode',
      batchModeParallel: 'All at once',
      batchModeSerial: 'One after another',
      batchParallelHint: 'Every selected entry starts now, and each is watched until its own port answers. A project that depends on another may log connection errors until that one is listening.',
      batchSerialHint: 'Each entry starts only after the previous one answers on its port, in list order — for projects that must come up in order, such as an SSO service.',
      batchFailedSome: 'Some entries did not answer on their port; the rest keep running.',
      batchStart: 'Start',
      batchStarting: 'Starting…',
      batchStop: 'Stop',
      batchWaiting: 'waiting',
      batchStartingNow: 'starting…',
      batchReady: 'ready',
      batchFailed: 'failed',
      batchTimeout: 'no port answer yet',
      batchCancelled: 'skipped',
      batchCancelledHint: 'Stopped. What had started keeps running.',
      batchStoppedHint: 'Stopped at the first failure; the rest were not started.',
      batchDone: 'Every selected entry is up.',
      batchSelectAll: 'Select all',
      batchSelectNone: 'Select none',
      batchRunningTag: 'already running',
      batchNothing: 'Nothing selected.',
      batchParticipate: 'Include in batch start',
      batchParticipateHint: 'Uncheck to keep it out of the top-bar Batch start.',
      launchColProject: 'Project',
      launchAdopted: 'adopted',
      launchAdoptedHint: 'Started before this host; Stop still kills its whole process tree',
      launchColPath: 'Directory',
      launchColState: 'State',
      launchColBranch: 'Branch',
      launchColScript: 'Command',
      launchColNode: 'Node',
      launchColPort: 'Port',
      launchColActions: 'Actions',
      launchColFollow: 'follow',
      launchNewTitle: 'New launcher',
      launchEditTitle: 'Edit launcher',
      footnote: 'Switching rewrites the nvm symlink, so new terminals and programs pick the version up; programs that are already running, DeepSeek Harness included, keep the version they started with. Installing downloads the release from nodejs.org through nvm, and the version in use cannot be removed.',
    }

    /** Chinese copy for the same keys. */
    const ZH = {
      workbench: 'Slim 工作台',
      workbenchSubtitle: '这台机器上的开发系统，一个面板一个。',
      systems: '系统',
      title: 'Node 管理',
      subtitle: '这台机器装了哪些 Node.js 版本，现在用的是哪个。',
      refresh: '刷新',
      refreshing: '刷新中…',
      refreshingInstalled: '正在刷新本机已安装的版本…',
      refreshOnlyInstalled: '只重新读取本机已安装的版本',
      loading: '正在读取 nvm-windows 安装信息…',
      current: '当前使用的 Node.js',
      none: '未链接任何版本',
      updatedAt: '更新时间',
      staleCache: '实时读取失败，下面显示的是 {time} 那次读取的结果。',
      inUse: '当前',
      tabInstalled: '已安装',
      tabAvailable: '可安装',
      searchPlaceholder: '搜索版本',
      ltsOnly: '只看 LTS',
      hideInstalled: '隐藏已安装',
      colVersion: '版本',
      colChannel: '通道',
      colDate: '发布日期',
      colActions: '操作',
      channelCurrent: 'Current',
      alreadyInstalled: '已安装',
      versionsCount: '个版本',
      use: '切换',
      switching: '切换中…',
      busySwitching: '正在切换到 v{version}…',
      install: '安装',
      installing: '安装中…',
      busyInstalling: '正在安装 v{version}，nvm 会从 nodejs.org 下载…',
      uninstall: '卸载',
      uninstalling: '卸载中…',
      busyUninstalling: '正在卸载 v{version}…',
      switchedTo: '已切换到 Node.js v{version}。',
      installDone: '已安装 Node.js v{version}。',
      uninstallDone: '已卸载 Node.js v{version}。',
      switchFailedDetail: '切换到 v{version} 失败：{detail}',
      installFailed: '安装 v{version} 失败：{detail}',
      uninstallFailed: '卸载 v{version} 失败：{detail}',
      unchanged: '当前使用的版本没有改变。',
      noReason: 'nvm 没有给出原因',
      releasesLoading: '正在读取 Node.js 已发布版本…',
      releasesFailed: '无法读取已发布版本列表。',
      releasesNone: '没有符合条件的版本。',
      releasesSource: '来源 nodejs.org，读取于 {time}',
      emptyInstalled: '该 nvm 目录下还没有安装任何版本。',
      browseAvailable: '去看看可安装版本',
      unsupportedTitle: '本系统不支持全机器切换版本',
      unsupportedFound: '在这台机器上找到 {count} 个 Node.js 版本；「一键启动」的每个项目可以各自锁定其中一个。',
      unsupported: '全机器切换需要 Windows 上的 nvm-windows。在 macOS / Linux 上 Node.js 版本属于 shell，请在终端切换（nvm alias default / fnm default）；「一键启动」仍可按项目锁定版本。',
      nvmMissing: '未找到 nvm-windows',
      nvmMissingHint: '请安装 nvm-windows，或在本插件的行配置中把 nvmHome 指向其他安装位置（见 README）。',
      lookedIn: '已查找',
      symlinkMissing: 'NVM_SYMLINK 不存在，当前没有链接任何版本。',
      readFailed: '无法读取 nvm 状态。',
      retry: '重试',
      launchTitle: '前端项目管理',
      launchSubtitle: '一个项目一行：选好目录、脚本和 Node 版本，点一下就起。',
      launchAdd: '添加',
      launchEdit: '编辑',
      launchNameLabel: '名称',
      launchNamePlaceholder: '前端项目',
      launchDirLabel: '目录',
      launchSave: '保存',
      launchCancel: '取消',
      launchStart: '启动',
      launchStarting: '启动中…',
      launchStop: '停止',
      launchStopping: '停止中…',
      launchRemove: '删除',
      launchStopped: '已停止',
      launchExited: '已退出',
      launchLoading: '正在读取启动项…',
      launchLoadFailed: '无法读取启动项。',
      launchStored: '存放在 {path}',
      launchNote: '命令用你的 shell 在各自目录下运行，关掉面板也不会停；点停止会杀掉整棵进程树，插件被卸载时也会停掉所有运行中的进程。',
      launchScriptLabel: '启动脚本',
      launchScriptPlaceholder: '请选择脚本…',
      launchScriptCustom: '自定义命令…',
      launchCustomLabel: '命令',
      launchCustomPlaceholder: 'pnpm --filter web dev',
      launchPmLabel: '包管理器',
      launchNodeLabel: 'Node.js',
      launchNodeFollowValue: '跟随工作台（{version}）',
      launchPortLabel: '端口（可选）',
      launchPortPlaceholder: '5173',
      launchPriorityLabel: '优先级',
      launchPriorityHint: '数字越小越靠前。目前只记录、暂时不参与启动顺序（顺序就是列表顺序）。',
      launchPick: '选择文件夹',
      launchDetected: '检测到 {what} —— 仅提示',
      launchNoLockfile: '没找到锁文件：包管理器请自行确认',
      launchNeedPm: '请选择包管理器',
      launchNeedScript: '请选择启动脚本',
      launchNeedCommand: '请填写要执行的命令',
      launchNeedName: '给这个启动项起个名字',
      launchPhaseStarting: '启动中…',
      launchPhaseReady: '就绪',
      launchLanHint: '局域网链接打不开，说明服务没监听 0.0.0.0（加 --host）。',
      launchInspecting: '正在读取项目…',
      launchInspectFailed: '读取项目失败：{message}',
      launchBlocked: '这条有阻断问题，处理前不能启动',
      refreshAllHint: '重新读取所有项目的分支、锁文件与警告',
      refreshAllBusy: '正在重新读取所有项目…',
      refreshMissing: '这些项目目录不存在：{names}',
      actionsMore: '更多',
      launchScriptLoading: '正在读取脚本…',
      launchLog: '输出',
      launchLogTitle: '输出 — {name}',
      launchLogEmpty: '这次运行还没有打印任何内容。',
      launchLogNoRun: '插件启动以来，这一条还没运行过。',
      launchLogHint: '只有这次运行打印的内容；颜色控制码已剥离。面板打开时会持续刷新。',
      launchLogTruncated: '只显示最后 {count} 行。',
      removeTitle: '删除这个启动项？',
      removeConfirm: '确定删除「{name}」。',
      removeConfirmHint: '只删除 launchers.json 里的这条记录，不会改动项目目录。',
      removeConfirmRunning: '它正在运行：会先停掉整棵进程树。',
      removing: '删除中…',
      backendTitle: '后端项目管理',
      backendSubtitle: 'Spring Boot 服务：选好项目和 profile，点一下就起。',
      launchNeedBuilder: '请先选择构建工具',
      launchBuilderLabel: '构建工具',
      launchBuilderMaven: 'Maven',
      launchBuilderGradle: 'Gradle',
      launchGoalLabel: '启动目标',
      launchProfileLabel: 'Profile',
      launchProfileFollow: '默认（跟随项目配置）',
      launchProfileHint: '从 src/main/resources 里读到的 Spring profile；「默认」使用 spring.profiles.active。',
      launchCurrent: '当前',
      launchColProfile: 'Profile',
      launchNoBackendBuild: '这里没有 pom.xml 或 build.gradle',
      launchBuilderDetected: '检测到',
      launchNoNvm: '这台机器没装 nvm：无法按项目锁定 Node 版本',
      launchNoNodeVersions: '还没装任何版本：只能跟随系统默认 Node',
      launchNvmAbsentNote: '这台机器没装 nvm：不能按项目锁定 Node 版本，所有项目都用系统默认 Node 启动。',
      launchBackendEmpty: '还没有后端项目。',
      launchFrontendEmpty: '还没有前端项目。',
      launchBatch: '批量启动',
      batchTitle: '批量启动',
      batchMode: '启动方式',
      batchModeParallel: '同时启动',
      batchModeSerial: '逐个启动',
      batchParallelHint: '选中的条目立刻全部启动，各自等自己的端口应答；有依赖的项目可能在前者就绪前报连接错误。',
      batchSerialHint: '上一条端口就绪后才启动下一条，按列表顺序（创建先后）—— 需要按顺序起的项目（例如 SSO）把它建在前面。',
      batchFailedSome: '有启动项端口未就绪；已经起来的继续运行。',
      batchStart: '开始启动',
      batchStarting: '启动中…',
      batchStop: '停止',
      batchWaiting: '等待',
      batchStartingNow: '启动中…',
      batchReady: '就绪',
      batchFailed: '失败',
      batchTimeout: '端口未就绪',
      batchCancelled: '已跳过',
      batchCancelledHint: '已停止；已经起来的进程继续运行。',
      batchStoppedHint: '遇到失败已停止，后面的没有启动。',
      batchDone: '选中的启动项已全部就绪。',
      batchSelectAll: '全选',
      batchSelectNone: '全不选',
      batchRunningTag: '已在运行',
      batchNothing: '没有选中任何启动项。',
      batchParticipate: '参与批量启动',
      batchParticipateHint: '取消勾选后，顶部「批量启动」不会启动它。',
      launchColProject: '项目',
      launchAdopted: '接管',
      launchAdoptedHint: '这是本次启动之前就在跑的进程；「停止」仍会杀掉整棵进程树',
      launchColPath: '项目地址',
      launchColState: '状态',
      launchColBranch: '分支',
      launchColScript: '命令',
      launchColNode: 'Node',
      launchColPort: '端口',
      launchColActions: '操作',
      launchColFollow: '跟随',
      launchNewTitle: '新建启动项',
      launchEditTitle: '编辑启动项',
      footnote: '切换会改写 nvm 的符号链接，新开的终端和程序生效；已在运行的程序（含 DeepSeek Harness 自身）仍使用启动时的版本。安装会通过 nvm 从 nodejs.org 下载对应版本；正在使用的版本不能卸载。',
    }

    /**
     * The Workbench frame: a two-column page in the center column, mirroring the
     * shell's own settings pages (title row, then a navigation list beside a pane).
     */
    const WBM_STYLES = `
.wbm { display: flex; flex-direction: column; box-sizing: border-box; height: 100%; padding: 0 24px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.wbm-head { flex: none; width: 100%; padding: 24px 0 16px; }
.wbm-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.35; }
.wbm-sub { margin: 4px 0 0; font-size: 13px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.wbm-body { flex: 1; min-height: 0; display: flex; gap: 24px; width: 100%; }
.wbm-nav { flex: none; width: 180px; display: flex; flex-direction: column; gap: 2px; padding-bottom: 24px; overflow-y: auto; }
.wbm-nav-head { margin: 0 0 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wbm-nav-item { appearance: none; margin: 0; padding: 8px 10px; font: inherit; font-size: 13px; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid transparent; border-radius: var(--dsw-radius-md, 8px); cursor: pointer; }
.wbm-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.wbm-nav-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
.wbm-nav-item[data-active="true"] { background: var(--dsw-alias-bg-layer-2); }
.wbm-pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding-bottom: 24px; overflow-y: auto; }
@media (max-width: 720px) {
  .wbm { padding: 0 16px; }
  .wbm-body { flex-direction: column; gap: 12px; }
  .wbm-nav { width: 100%; flex-direction: row; gap: 6px; overflow-x: auto; padding-bottom: 0; }
  .wbm-nav-head { display: none; }
  .wbm-nav-item { white-space: nowrap; }
}
`

    /**
     * One system's console. The head, the state, and the tabs are pinned; only the
     * rows scroll, in their own container, with the table header stuck to its top.
     * Every colour is a host theme token, with the value the shell's own pages use
     * as the fallback.
     */
    const SYSTEM_STYLES = `
.ndv-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
.ndv-pinned { display: flex; flex-direction: column; gap: 12px; }
.ndv-head { display: flex; flex-direction: column; gap: 3px; }
.ndv-head-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.ndv-head-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ndv-scroll { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; overflow: auto; scrollbar-width: thin; }
.ndv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-variant-numeric: tabular-nums; }
.ndv-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ndv-status { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1)); border-radius: var(--dsw-radius-xl, 12px); }
.ndv-dot { flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.ndv-dot[data-on="true"] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); }
.ndv-status-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.ndv-status-line { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ndv-status-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ndv-status-value { font-size: 16px; font-weight: 600; line-height: 1.3; }
.ndv-paths { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; }
.ndv-path { display: flex; gap: 6px; min-width: 0; font-size: 12px; }
.ndv-path-key { flex: none; color: var(--dsw-alias-label-secondary); }
.ndv-path-value { word-break: break-all; }
.ndv-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ndv-tabs { display: flex; gap: 2px; }
.ndv-tab { display: inline-flex; align-items: center; gap: 6px; appearance: none; margin: 0 0 -1px; padding: 7px 12px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-secondary); background: transparent; border: 0; border-bottom: 2px solid transparent; cursor: pointer; }
.ndv-tab:hover { color: var(--dsw-alias-label-primary); }
.ndv-tab:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
.ndv-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.ndv-count { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; line-height: 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.ndv-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-left: auto; padding-bottom: 6px; }
.ndv-search { appearance: none; width: 170px; height: 26px; padding: 0 9px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); }
.ndv-search:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.ndv-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.ndv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ndv-table th { padding: 6px 8px; font-size: 11.5px; font-weight: 400; letter-spacing: 0.02em; text-align: left; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.ndv-table td { padding: 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); vertical-align: middle; }
.ndv-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ndv-table tbody tr[data-current="true"] td:first-child { box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.ndv-col-actions { width: 1%; text-align: right; white-space: nowrap; }
.ndv-row-actions { display: inline-flex; gap: 6px; justify-content: flex-end; }
.ndv-tag { display: inline-block; padding: 0 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ndv-tag--on { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
.ndv-dim { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.ndv-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 18px 16px; border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xl, 12px); }
.ndv-empty-text { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.ndv-source { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.ndv-button { flex: none; appearance: none; margin: 0; padding: 4px 12px; min-height: 26px; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); cursor: pointer; }
.ndv-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.ndv-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
.ndv-button:disabled { opacity: 0.55; cursor: default; }
.ndv-note { margin: 0; font-size: 12px; }
.ndv-note--muted { color: var(--dsw-alias-label-secondary); }
.ndv-notice { margin: 0; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px); font-size: 13px; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.ndv-notice[data-kind="ok"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.ndv-notice[data-kind="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.ndv-warn { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border: 0.5px solid var(--dsw-alias-state-warn-primary); border-radius: var(--dsw-radius-xl, 12px); }
.ndv-warn-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
.ndv-footnote { flex: none; margin: auto 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ndv-loading { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ndv-spin { display: inline-block; flex: none; width: 11px; height: 11px; border: 1.5px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: ndv-spin 700ms linear infinite; }
@keyframes ndv-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ndv-spin { animation: none; }
}
/* A refresh keeps the old rows visible but says they are the old answer. */
.ndv-scroll[data-busy="true"] { opacity: 0.55; }
.ndv-refresh { display: inline-flex; align-items: center; gap: 6px; }
@media (max-width: 720px) {
  .ndv-search { width: 120px; }
  .ndv-col-date { display: none; }
}
`

    /**
     * The launcher system: one row per command, with a status dot, the command, its
     * directory, and the actions that fit the run's state. The log view replaces the
     * list rather than nesting a second scroll container.
     */
    const LAUNCH_STYLES = `
.lch-table { table-layout: fixed; width: max(100%, 1210px); }
.lch-table th { position: sticky; top: 0; z-index: 1; padding-top: 8px; padding-bottom: 8px; background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)); }
/* Fixed widths, in pixels: a squeezed column is worse than a horizontal scrollbar. */
.lch-table th:nth-child(1) { width: 190px; }
.lch-table th:nth-child(2) { width: 260px; }
.lch-table th:nth-child(3) { width: 84px; }
.lch-table th:nth-child(4) { width: 120px; }
.lch-table th:nth-child(5) { width: 200px; }
.lch-table th:nth-child(6) { width: 92px; }
.lch-table th:nth-child(7) { width: 96px; }
.lch-table th:nth-child(8) { width: 168px; }
.lch-trow td { padding: 10px 8px; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The name and the actions stay put; only the middle columns scroll sideways. */
.lch-table th:nth-child(1),
.lch-table td:nth-child(1),
.lch-table th:nth-child(8),
.lch-table td:nth-child(8) {
  position: sticky;
  z-index: 2;
  background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));
}
.lch-table th:nth-child(1), .lch-table td:nth-child(1) { left: 0; box-shadow: 1px 0 0 0 var(--dsw-alias-border-l1); }
.lch-table th:nth-child(8), .lch-table td:nth-child(8) { right: 0; box-shadow: -1px 0 0 0 var(--dsw-alias-border-l1); }
.lch-table thead th:nth-child(1), .lch-table thead th:nth-child(8) { top: 0; z-index: 3; }
.lch-cell-name { overflow: hidden; font-size: 13.5px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.lch-cell-cwd { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); text-overflow: ellipsis; white-space: nowrap; }
.lch-cell-state { display: flex; flex-direction: column; gap: 6px; }
.lch-cell-mono { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; }
.lch-dim { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.lch-dim { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.lch-links { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.lch-state { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.lch-orphan { margin-left: 6px; padding: 0 5px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-badge, var(--dsw-alias-bg-layer-2)); border-radius: var(--dsw-radius-sm, 4px); }
.lch-state[data-state="running"] { color: var(--dsw-alias-state-success-primary); }
.lch-state[data-state="exited"] { color: var(--dsw-alias-state-error-primary); }
.lch-stage { display: flex; align-items: center; gap: 4px; max-width: 120px; }
.lch-stage-seg { position: relative; flex: 1 1 0; height: 4px; overflow: hidden; border-radius: 999px; background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
.lch-stage-seg[data-on="true"] { background: var(--dsw-alias-brand-primary); }
.lch-stage-seg[data-pulse="true"]::after { position: absolute; inset: 0 auto 0 0; width: 40%; border-radius: inherit; background: var(--dsw-alias-brand-primary); content: ''; animation: lch-pulse 1200ms ease-in-out infinite; }
@keyframes lch-pulse {
  0% { transform: translateX(-100%); opacity: 0.35; }
  50% { opacity: 0.9; }
  100% { transform: translateX(250%); opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .lch-stage-seg[data-pulse="true"]::after { animation: none; width: 100%; opacity: 0.45; transform: none; }
}
.lch-link { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); font-size: 11.5px; line-height: 20px; text-decoration: none; font-variant-numeric: tabular-nums; }
@media (hover: hover) {
  .lch-link:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3)); text-decoration: underline; text-underline-offset: 2px; }
}
.lch-link:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.lch-tailcell { padding: 0 8px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.lch-tailcell { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); text-overflow: ellipsis; white-space: nowrap; }
.lch-tailcell[data-state="exited"] { color: var(--dsw-alias-state-error-primary); }
.lch-warncell { padding: 0 8px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.lch-warnbox { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-left: 2px solid var(--dsw-alias-state-warn-primary); border-radius: var(--dsw-radius-sm, 6px); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); font-size: 12px; line-height: 18px; }
.lch-warnline { display: flex; }
.lch-warnline[data-level="block"] { color: var(--dsw-alias-state-error-primary); }
.lch-warnline[data-level="notice"] { color: var(--dsw-alias-state-warn-primary); }
.lch-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.lch-headactions { flex: none; display: inline-flex; align-items: center; gap: 8px; }
.lch-refresh-all { display: inline-flex; align-items: center; gap: 6px; }
.lch-actions { flex: none; display: inline-flex; flex-wrap: nowrap; align-items: center; justify-content: flex-start; gap: 6px; }
.lch-actions .ndv-button { min-height: 26px; padding: 3px 7px; font-size: 12px; }
.lch-primary { color: var(--dsw-alias-label-primary-foreground, #ffffff); background: var(--dsw-alias-brand-primary); border-color: transparent; }
@media (hover: hover) {
  .lch-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); filter: brightness(1.08); }
}
.lch-danger { color: var(--dsw-alias-state-error-primary); }
@media (hover: hover) {
  .lch-danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); }
}
.lch-danger-solid { color: var(--dsw-alias-label-primary-foreground, #ffffff); background: var(--dsw-alias-state-error-primary); border-color: transparent; }
@media (hover: hover) {
  .lch-danger-solid:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary); filter: brightness(1.08); }
}
.lch-modal-backdrop { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 28px; background: color-mix(in srgb, var(--dsw-alias-bg-base, #000000) 45%, transparent); backdrop-filter: blur(2px); }
.lch-modal { display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; width: min(560px, 100%); max-height: min(82vh, 760px); padding: 20px; overflow: auto; border-radius: var(--dsw-radius-xl, 12px); background: var(--dsw-alias-bg-layer-1, #ffffff); box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.18)); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2, var(--dsw-alias-border-l2)); }
.lch-log { margin: 0; padding: 10px 12px; max-height: min(52vh, 520px); overflow: auto; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 11.5px; line-height: 17px; white-space: pre-wrap; word-break: break-word; }
.lch-confirm-text { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.lch-confirm-path { margin: 0; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); text-overflow: ellipsis; white-space: nowrap; }
.lch-modal-head { display: flex; align-items: center; gap: 8px; }
.lch-modal-title { flex: 1; margin: 0; font-size: 16px; font-weight: 600; line-height: 24px; }
.lch-modal-close { flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 15px; line-height: 1; cursor: pointer; }
@media (hover: hover) {
  .lch-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
}
.lch-modal-close:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.lch-form { display: flex; flex-direction: column; gap: 12px; }
.lch-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.lch-input,
.lch-select { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); }
.lch-input:focus,
.lch-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.lch-inline { display: flex; align-items: center; gap: 8px; }
.lch-inline > .lch-input { flex: 1 1 auto; min-width: 0; }
.lch-modal--wide { width: min(680px, 100%); }
.lch-batch-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.lch-batch-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px); }
@media (hover: hover) {
  .lch-batch-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
}
.lch-batch-order { flex: none; width: 18px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; text-align: right; }
.lch-batch-label { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
.lch-batch-label > input { flex: none; margin: 0; width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); }
.lch-batch-name { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.lch-batch-state { flex: none; max-width: 45%; overflow: hidden; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); text-overflow: ellipsis; white-space: nowrap; }
.lch-batch-state[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); }
.lch-batch-state[data-kind="running"] { color: var(--dsw-alias-brand-primary); }
.lch-batch-state[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.lch-hint[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); }
.lch-hint[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.lch-hint[data-kind="notice"] { color: var(--dsw-alias-state-warn-primary); }
.lch-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.lch-seg { display: inline-flex; gap: 2px; padding: 3px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2); }
.lch-seg > button { flex: 1 1 0; height: 24px; padding: 0 10px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); background: transparent; border: 0; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; }
@media (hover: hover) {
  .lch-seg > button:hover { color: var(--dsw-alias-label-primary); }
}
.lch-seg > button[data-on="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, #ffffff); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
.lch-seg > button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -1px; }
.lch-hint { margin: 0; font-size: 11.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.lch-spacer { flex: 1 1 auto; }
.lch-check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.lch-check > input { margin: 0; width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); }
.lch-form-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.lch-form-actions .ndv-button { min-height: 32px; padding: 5px 16px; font-size: 13px; }
.lch-form-actions .lch-primary { order: 2; margin-left: auto; }
@media (max-width: 720px) {
  .lch-modal-backdrop { padding: 12px; }
  .lch-grid2 { grid-template-columns: minmax(0, 1fr); }
  .lch-table th:nth-child(3),
  .lch-table td:nth-child(3) { display: none; }
}
.lch-footer { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; }
.lch-footer-path { margin-left: auto; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); text-overflow: ellipsis; white-space: nowrap; }
.lch-table th.ndv-col-actions { text-align: left; }
.lch-table td.ndv-col-actions { text-align: left; white-space: nowrap; overflow: visible; }
.lch-more { display: inline-flex; align-items: center; gap: 4px; }
.lch-caret { font-size: 9px; line-height: 1; opacity: 0.7; }
.lch-menu-overlay { position: fixed; inset: 0; z-index: 55; pointer-events: none; }
.lch-menu { position: fixed; display: flex; flex-direction: column; gap: 2px; min-width: 152px; padding: 5px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1, #ffffff); box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.18)); pointer-events: auto; }
.lch-menu-item { appearance: none; margin: 0; padding: 7px 10px; font: inherit; font-size: 12.5px; line-height: 1.4; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 0; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; }
@media (hover: hover) {
  .lch-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
}
.lch-menu-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -1px; }
.lch-menu-item:disabled { opacity: 0.55; cursor: default; }
`

    /**
     * Resolve one translate function for the active locale, falling back to the
     * bundled English copy when the locale service answers with the key itself.
     * @param {object} props the entry's props, which carry `t` when the registration names a locale.
     * @returns {(key: string) => string} the translate function.
     */
    function translator(props) {
      const bound = typeof props?.t === 'function' ? props.t : null
      return (key) => {
        if (bound !== null) {
          try {
            const text = bound(key)
            if (typeof text === 'string' && text !== '' && text !== key) return text
          } catch {
            // A locale service error must not blank the page: English stands in.
          }
        }
        return EN[key] ?? key
      }
    }

    /**
     * Fill `{name}` placeholders in one copy entry.
     * @param {string} template the copy entry.
     * @param {Record<string, string>} values placeholder values.
     * @returns {string} the filled text.
     */
    function fill(template, values) {
      return Object.entries(values).reduce(
        (text, [key, value]) => text.split(`{${key}}`).join(value),
        template,
      )
    }

    /**
     * Read one JSON route and reject with the Host's message on a non-2xx answer.
     * @param {string} route document-relative route.
     * @param {RequestInit} init fetch options, including the abort signal.
     * @returns {Promise<any>} the decoded payload.
     */
    /**
     * The error `readJson` throws carries the body it could not use, so a caller that wants
     * the payload of a failed request (the cached Node read, answered with 503) can have it.
     * @param {unknown} error the rejection.
     * @returns {Promise<object | null>} the parsed body, or null.
     */
    async function readJsonBody(error) {
      const payload = error?.payload
      return payload !== null && typeof payload === 'object' ? payload : null
    }

    async function readJson(route, init) {
      const response = await fetch(route, { cache: 'no-store', ...init })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const failure = new Error(typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`)
        failure.payload = payload
        throw failure
      }
      return payload
    }

    /**
     * Run one versioned action on the Host.
     * @param {'use' | 'install' | 'uninstall'} kind the operation.
     * @param {string} version the version to act on.
     * @returns {Promise<{ ok: true, state: object } | { ok: false, detail: string }>} the outcome.
     */
    async function requestAction(kind, version) {
      try {
        const outcome = await readJson(ROUTES[kind], {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ version }),
        })
        if (outcome?.ok === true) return { ok: true, state: outcome.state }
        return { ok: false, detail: String(outcome?.message ?? '').trim() }
      } catch (error) {
        return { ok: false, detail: String(error?.message ?? error).trim() }
      }
    }

    /**
     * The Node.js system: the linked version, the installed versions, and the
     * published versions that can be installed.
     * @param {object} props the pane props, carrying the locale translator.
     * @returns {object} the system element.
     */
    function NodeSystem(props) {
      const t = translator(props)
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading', state: null, error: null })
      const [releases, setReleases] = React.useState({ status: 'idle', payload: null, error: null })
      const [tab, setTab] = React.useState('installed')
      const [query, setQuery] = React.useState('')
      const [ltsOnly, setLtsOnly] = React.useState(true)
      const [hideInstalled, setHideInstalled] = React.useState(true)
      const [pending, setPending] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [attempt, setAttempt] = React.useState(0)

      React.useEffect(() => {
        const controller = new AbortController()
        let live = true
        // A re-read keeps the last known state on screen instead of flashing the loader.
        setSnapshot((current) => ({ phase: 'loading', state: current.state, error: null }))
        readJson(ROUTES.state, { headers: { accept: 'application/json' }, signal: controller.signal }).then(
          (payload) => {
            if (!live) return
            if (payload?.ok === false) {
              // The live read failed: fall back to what the Host remembered, which carries
              // its own readAt so the strip keeps telling the truth about its age.
              setSnapshot({ phase: 'error', state: payload.cached ?? null, error: String(payload.message ?? '') })
              return
            }
            setSnapshot({ phase: 'ready', state: payload, error: null })
          },
          async (error) => {
            if (!live || controller.signal.aborted) return
            // The Host answers 503 with the cached read; readJson treats that as a failure,
            // so read the body it attached instead of dropping the fallback on the floor.
            const body = await readJsonBody(error)
            if (!live || controller.signal.aborted) return
            if (body?.ok === false && body.cached !== undefined) {
              setSnapshot({ phase: 'error', state: body.cached, error: String(body.message ?? '') })
              return
            }
            setSnapshot({ phase: 'error', state: null, error: String(error?.message ?? error) })
          },
        )
        return () => {
          live = false
          controller.abort()
        }
      }, [attempt])

      React.useEffect(() => {
        if (releases.status !== 'loading') return undefined
        const controller = new AbortController()
        let live = true
        readJson(ROUTES.releases, { headers: { accept: 'application/json' }, signal: controller.signal }).then(
          (payload) => {
            if (live) setReleases({ status: 'ready', payload, error: null })
          },
          (error) => {
            if (live && !controller.signal.aborted) {
              setReleases({ status: 'error', payload: null, error: String(error?.message ?? error) })
            }
          },
        )
        return () => {
          live = false
          controller.abort()
        }
      }, [releases.status])

      const state = snapshot.state
      const busy = pending !== null
      const refreshing = snapshot.phase === 'loading'
      const currentVersion = typeof state?.current === 'string' && state.current !== '' ? state.current : null
      // When this answer was read, so the strip can say how fresh the list is.
      const readAt = typeof state?.readAt === 'number' ? state.readAt : null
      const managed = state !== null && state.available === true && state.supported !== false
      const installed = Array.isArray(state?.versions) ? state.versions : []
      const installedSet = new Set(installed.map((entry) => entry.version))
      const visibleReleases = (releases.payload?.versions ?? []).filter((entry) => {
        if (ltsOnly && entry.lts === null) return false
        if (hideInstalled && installedSet.has(entry.version)) return false
        const needle = query.trim().replace(/^v/, '')
        return needle === '' || entry.version.includes(needle)
      })

      /**
       * Show one tab, loading the release index the first time it is needed.
       * @param {'installed' | 'available'} next the tab to show.
       * @returns {void}
       */
      const showTab = (next) => {
        setTab(next)
        if (next === 'available' && (releases.status === 'idle' || releases.status === 'error')) {
          setReleases({ status: 'loading', payload: null, error: null })
        }
      }

      /**
       * Run one action and publish its outcome. A failure re-reads the state: a
       * partly applied `nvm` command must not leave the page asserting a version.
       * @param {'use' | 'install' | 'uninstall'} kind the operation.
       * @param {string} version the version to act on.
       * @returns {Promise<void>} settles when the Host answered.
       */
      const perform = async (kind, version) => {
        setPending({ kind, version })
        setNotice(null)
        const outcome = await requestAction(kind, version)
        if (outcome.ok) {
          setSnapshot({ phase: 'ready', state: outcome.state, error: null })
          // A fresh install belongs in the installed list, where its new row is visible.
          if (kind === 'install') setTab('installed')
          const current = String(outcome.state?.current ?? version)
          setNotice({
            kind: 'ok',
            text: kind === 'use'
              ? fill(t('switchedTo'), { version: current })
              : kind === 'install'
                ? fill(t('installDone'), { version })
                : fill(t('uninstallDone'), { version }),
          })
        } else {
          const detail = outcome.detail === '' ? t('noReason') : outcome.detail
          setNotice({
            kind: 'error',
            text: kind === 'use'
              ? `${fill(t('switchFailedDetail'), { version, detail })} ${t('unchanged')}`
              : kind === 'install'
                ? fill(t('installFailed'), { version, detail })
                : fill(t('uninstallFailed'), { version, detail }),
          })
          setAttempt((value) => value + 1)
        }
        setPending(null)
      }

      /**
       * The status strip: the linked version, the nvm version, and both paths.
       * @returns {object} the strip element.
       */
      function statusStrip() {
        return h('div', { className: 'ndv-status' },
          h('span', { className: 'ndv-dot', 'data-on': currentVersion === null ? 'false' : 'true', 'aria-hidden': 'true' }),
          h('div', { className: 'ndv-status-body' },
            h('div', { className: 'ndv-status-line' },
              h('span', { className: 'ndv-status-label' }, t('current')),
              h('span', { className: currentVersion === null ? 'ndv-status-value' : 'ndv-status-value ndv-mono' },
                currentVersion === null ? t('none') : `v${currentVersion}`),
              h('span', { className: 'ndv-meta' },
                state.nvmVersion === null || state.nvmVersion === undefined ? 'nvm' : `nvm ${state.nvmVersion}`),
              readAt === null ? null : h('span', {
                className: 'ndv-meta',
                // The clock alone is enough in the strip; the full stamp is in the tooltip,
                // which is also what makes an old answer obvious after a long session.
                title: new Date(readAt).toLocaleString(),
              }, `${t('updatedAt')} ${new Date(readAt).toLocaleTimeString()}`),
            ),
            h('ul', { className: 'ndv-paths' },
              h('li', { className: 'ndv-path' },
                h('span', { className: 'ndv-path-key' }, 'NVM_HOME'),
                h('span', { className: 'ndv-mono ndv-path-value' }, String(state.nvmHome ?? ''))),
              h('li', { className: 'ndv-path' },
                h('span', { className: 'ndv-path-key' }, 'NVM_SYMLINK'),
                h('span', { className: 'ndv-mono ndv-path-value' }, String(state.symlink ?? ''))),
            ),
            state.symlinkPresent === false
              ? h('p', { className: 'ndv-note ndv-note--muted' }, t('symlinkMissing'))
              : null,
          ),
          h('button', {
            type: 'button',
            className: 'ndv-button ndv-refresh',
            // Only the installed list is re-read: the release index keeps whatever it
            // already fetched, so switching tabs afterwards costs no request.
            title: t('refreshOnlyInstalled'),
            onClick: () => {
              setNotice(null)
              setAttempt((value) => value + 1)
            },
            disabled: refreshing || busy,
            'aria-busy': refreshing ? 'true' : undefined,
          },
            refreshing ? h('span', { key: 'spin', className: 'ndv-spin', 'aria-hidden': 'true' }) : null,
            h('span', { key: 'label' }, refreshing ? t('refreshing') : t('refresh'))),
        )
      }

      /**
       * The tab bar, with the filters the available view offers.
       * @returns {object} the bar element.
       */
      function tabBar() {
        return h('div', { className: 'ndv-bar' },
          h('div', { className: 'ndv-tabs', role: 'tablist' },
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'ndv-tab',
              'data-active': tab === 'installed' ? 'true' : 'false',
              'aria-selected': tab === 'installed' ? 'true' : 'false',
              onClick: () => { showTab('installed') },
            }, t('tabInstalled'), h('span', { className: 'ndv-count' }, String(installed.length))),
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'ndv-tab',
              'data-active': tab === 'available' ? 'true' : 'false',
              'aria-selected': tab === 'available' ? 'true' : 'false',
              onClick: () => { showTab('available') },
            }, t('tabAvailable'),
            releases.payload === null ? null : h('span', { className: 'ndv-count' }, String(releases.payload.versions.length))),
          ),
          tab === 'available'
            ? h('div', { className: 'ndv-toolbar' },
              h('input', {
                className: 'ndv-search',
                type: 'search',
                value: query,
                placeholder: t('searchPlaceholder'),
                'aria-label': t('searchPlaceholder'),
                onChange: (event) => { setQuery(event.target.value) },
              }),
              h('label', { className: 'ndv-check' },
                h('input', {
                  type: 'checkbox',
                  checked: ltsOnly,
                  onChange: (event) => { setLtsOnly(event.target.checked) },
                }),
                t('ltsOnly')),
              h('label', { className: 'ndv-check' },
                h('input', {
                  type: 'checkbox',
                  checked: hideInstalled,
                  onChange: (event) => { setHideInstalled(event.target.checked) },
                }),
                t('hideInstalled')),
            )
            : null,
        )
      }

      /**
       * The installed versions, one row each: state, switch, remove.
       * @returns {object} the table, or the empty state.
       */
      function installedTable() {
        if (installed.length === 0) {
          return h('div', { className: 'ndv-empty' },
            h('p', { className: 'ndv-empty-text' }, t('emptyInstalled')),
            h('button', {
              type: 'button',
              className: 'ndv-button',
              onClick: () => { showTab('available') },
            }, t('browseAvailable')),
          )
        }
        return h('table', { className: 'ndv-table' },
          h('thead', null, h('tr', null,
            h('th', null, t('colVersion')),
            h('th', null, t('colChannel')),
            h('th', { className: 'ndv-col-actions' }, t('colActions')),
          )),
          h('tbody', null, installed.map((entry) => {
            const inUse = entry.version === currentVersion
            const working = pending !== null && pending.version === entry.version ? pending.kind : null
            return h('tr', {
              key: entry.version,
              'data-current': inUse ? 'true' : 'false',
            },
            h('td', { className: 'ndv-mono' }, `v${entry.version}`),
            h('td', null, inUse
              ? h('span', { className: 'ndv-tag ndv-tag--on' }, t('inUse'))
              : h('span', { className: 'ndv-dim' }, '—')),
            h('td', { className: 'ndv-col-actions' },
              h('div', { className: 'ndv-row-actions' },
                h('button', {
                  type: 'button',
                  className: 'ndv-button',
                  disabled: busy || inUse,
                  'aria-label': `${t('use')} v${entry.version}`,
                  onClick: inUse ? undefined : () => { perform('use', entry.version).catch(() => {}) },
                }, working === 'use' ? t('switching') : t('use')),
                h('button', {
                  type: 'button',
                  className: 'ndv-button',
                  disabled: busy || inUse,
                  'aria-label': `${t('uninstall')} v${entry.version}`,
                  onClick: inUse ? undefined : () => { perform('uninstall', entry.version).catch(() => {}) },
                }, working === 'uninstall' ? t('uninstalling') : t('uninstall')),
              ),
            ),
            )
          })),
        )
      }

      /**
       * The published versions that can still be installed, filtered by the toolbar.
       * @returns {object} the table, the loading note, the failure notice, or the empty state.
       */
      function availableTable() {
        if (releases.status === 'loading' || releases.status === 'idle') {
          return h('p', { className: 'ndv-note ndv-note--muted' }, t('releasesLoading'))
        }
        if (releases.status === 'error') {
          return h('div', { className: 'ndv-warn' },
            h('p', { className: 'ndv-warn-title' }, t('releasesFailed')),
            h('p', { className: 'ndv-note ndv-note--muted ndv-mono' }, String(releases.error ?? '')),
            h('div', null,
              h('button', {
                type: 'button',
                className: 'ndv-button',
                onClick: () => { setReleases({ status: 'loading', payload: null, error: null }) },
              }, t('retry'))),
          )
        }
        if (visibleReleases.length === 0) {
          return h('p', { className: 'ndv-note ndv-note--muted' }, t('releasesNone'))
        }
        return h(React.Fragment, null,
          h('table', { className: 'ndv-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('colVersion')),
              h('th', null, t('colChannel')),
              h('th', { className: 'ndv-col-date' }, t('colDate')),
              h('th', { className: 'ndv-col-actions' }, t('colActions')),
            )),
            h('tbody', null, visibleReleases.map((entry) => {
              const working = pending !== null && pending.version === entry.version ? pending.kind : null
              return h('tr', { key: entry.version },
                h('td', { className: 'ndv-mono' }, `v${entry.version}`),
                h('td', null, entry.lts === null
                  ? h('span', { className: 'ndv-dim' }, t('channelCurrent'))
                  : h('span', { className: 'ndv-tag' }, `LTS ${entry.lts}`)),
                h('td', { className: 'ndv-dim ndv-col-date' }, entry.date),
                h('td', { className: 'ndv-col-actions' },
                  installedSet.has(entry.version)
                    ? h('span', { className: 'ndv-tag ndv-tag--on' }, t('alreadyInstalled'))
                    : h('button', {
                      type: 'button',
                      className: 'ndv-button',
                      disabled: busy,
                      'aria-label': `${t('install')} v${entry.version}`,
                      onClick: () => { perform('install', entry.version).catch(() => {}) },
                    }, working === 'install' ? t('installing') : t('install'))),
              )
            })),
          ),
          h('p', { className: 'ndv-source' },
            `${visibleReleases.length} ${t('versionsCount')} · `,
            fill(t('releasesSource'), {
              time: releases.payload?.fetchedAt === undefined
                ? ''
                : new Date(releases.payload.fetchedAt).toLocaleTimeString(),
            })),
        )
      }

      /**
       * The region under the pinned head: what the current state has to show.
       * @returns {object} the rows, or the state that replaces them.
       */
      function body() {
        if (state === null) {
          if (snapshot.phase !== 'error') return h('p', { className: 'ndv-note ndv-note--muted' }, t('loading'))
          return h('div', { className: 'ndv-warn' },
            h('p', { className: 'ndv-warn-title' }, t('readFailed')),
            h('p', { className: 'ndv-note ndv-note--muted ndv-mono' }, String(snapshot.error ?? '')),
            h('div', null,
              h('button', {
                type: 'button',
                className: 'ndv-button',
                onClick: () => { setAttempt((value) => value + 1) },
              }, t('retry'))),
          )
        }
        if (state.supported === false) {
          // No nvm-windows here. Version *switching* is unavailable, but the versions
          // this machine does have are worth showing: launcher entries can pin them.
          const detected = Array.isArray(state.versions) ? state.versions : []
          return h('div', null,
            h('div', { className: 'ndv-warn' },
              h('p', { className: 'ndv-warn-title' }, t('unsupportedTitle')),
              h('p', { className: 'ndv-note ndv-note--muted' }, t('unsupported')),
            ),
            detected.length === 0
              ? null
              : h('div', null,
                h('p', { className: 'ndv-note ndv-note--muted' }, fill(t('unsupportedFound'), { count: String(detected.length) })),
                h('table', { className: 'ndv-table' },
                  h('thead', null,
                    h('tr', null, h('th', null, t('colVersion'))),
                  ),
                  h('tbody', null, detected.map((entry) => h('tr', { key: entry.version },
                    h('td', { className: 'ndv-mono' }, `v${entry.version}`),
                  ))),
                ),
              ),
          )
        }
        if (state.available !== true) {
          return h('div', { className: 'ndv-warn' },
            h('p', { className: 'ndv-warn-title' }, t('nvmMissing')),
            h('p', { className: 'ndv-note ndv-note--muted' }, t('nvmMissingHint')),
            Array.isArray(state.checked) && state.checked.length > 0
              ? h('div', null,
                h('p', { className: 'ndv-note ndv-note--muted' }, t('lookedIn')),
                h('ul', { className: 'ndv-paths' },
                  state.checked.map((entry) => h('li', { key: entry, className: 'ndv-path' },
                    h('span', { className: 'ndv-mono ndv-path-value' }, String(entry))))),
              )
              : null,
          )
        }
        return tab === 'installed' ? installedTable() : availableTable()
      }

      // A switch or install in flight outranks a stale outcome: it says what is happening now.
      const banner = busy
        ? {
          kind: 'busy',
          text: pending.kind === 'use'
            ? fill(t('busySwitching'), { version: pending.version })
            : pending.kind === 'install'
              ? fill(t('busyInstalling'), { version: pending.version })
              : fill(t('busyUninstalling'), { version: pending.version }),
        }
        : notice

      // A refresh over data already on screen says so in place, and dims the list it is
      // about to replace: the rows are the old answer until the new one lands. The release
      // tab is not being re-read, so it is never dimmed.
      const reloading = refreshing && state !== null
      const dimmed = reloading && tab === 'installed'
      return h('div', { className: 'ndv-body' },
        h('style', null, SYSTEM_STYLES),
        h('div', { className: 'ndv-pinned' },
          h('div', { className: 'ndv-head' },
            h('h2', { className: 'ndv-head-title' }, t('title')),
            h('p', { className: 'ndv-head-sub' }, t('subtitle')),
          ),
          banner === null ? null : h('p', {
            className: 'ndv-notice',
            'data-kind': banner.kind,
            role: banner.kind === 'error' ? 'alert' : 'status',
          }, banner.text),
          snapshot.phase === 'error' && state !== null
            ? h('p', { className: 'ndv-notice', 'data-kind': 'error', role: 'status' },
              fill(t('staleCache'), { time: readAt === null ? '?' : new Date(readAt).toLocaleString() }))
            : null,
          managed ? statusStrip() : null,
          reloading ? h('p', { className: 'ndv-loading', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'ndv-spin', 'aria-hidden': 'true' }),
            h('span', null, t('refreshingInstalled'))) : null,
          managed ? tabBar() : null,
        ),
        h('div', { className: 'ndv-scroll', 'data-busy': dimmed ? 'true' : undefined }, body()),
        managed ? h('p', { className: 'ndv-footnote' }, t('footnote')) : null,
      )
    }

    /**
     * The launcher system: commands the user adds, starts, watches, and stops.
     * @param {object} props the pane props, carrying the locale translator.
     * @returns {object} the system element.
     */
    function LauncherSystem(props) {
      const t = translator(props)
      const stack = props.stack === 'backend' ? 'backend' : 'frontend'
      const [data, setData] = React.useState({ status: 'loading', payload: null, error: null })
      const [form, setForm] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [token, setToken] = React.useState(0)
      // Re-reading every project at once: one request, one spinner, one file write.
      const [refreshAll, setRefreshAll] = React.useState(false)
      // The entry whose delete confirmation is open, if any.
      const [removeTarget, setRemoveTarget] = React.useState(null)
      const confirmCancelRef = React.useRef(null)
      // A destructive dialog: Escape cancels, and the safe button holds the focus.
      const confirmOpen = removeTarget !== null
      React.useEffect(() => {
        if (!confirmOpen) return undefined
        const node = confirmCancelRef.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setRemoveTarget(null)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [confirmOpen])

      const [insp, setInsp] = React.useState({ status: 'idle', facts: null, error: null })
      // A re-read forced by opening the editor, which must not sit behind the fact cache.
      const [inspectToken, setInspectToken] = React.useState(0)
      const freshInspect = React.useRef(false)
      // The row whose More menu is open, anchored to the button that opened it.
      const [menu, setMenu] = React.useState(null)
      const menuRef = React.useRef(null)
      // The entry whose output is open, and what the Host last answered for it.
      const [logTarget, setLogTarget] = React.useState(null)
      const [logView, setLogView] = React.useState(null)
      const logOpen = logTarget !== null
      // Batch start: which entries were picked, how they are started, and how far the run got.
      const [batchOpen, setBatchOpen] = React.useState(false)
      const [batchMode, setBatchMode] = React.useState('parallel')
      const [batchRun, setBatchRun] = React.useState(null)
      const batchCancel = React.useRef(false)
      const fieldRef = React.useRef(null)

      // Read the run's output, and keep re-reading it while that run is alive: a dev
      // server's useful lines arrive after the panel has already drawn the table.
      React.useEffect(() => {
        if (!logOpen) return undefined
        const id = logTarget.id
        const controller = new AbortController()
        let live = true
        setLogView({ status: 'loading', text: '', truncated: false, error: null })
        const load = () => {
          const route = `${ROUTES.launchLog}?id=${encodeURIComponent(id)}&lines=${LOG_VIEW_LINES}`
          readJson(route, { headers: { accept: 'application/json' }, signal: controller.signal }).then(
            (payload) => {
              if (!live) return
              if (payload?.ok === true) {
                setLogView({
                  status: 'ready',
                  text: String(payload.text ?? ''),
                  truncated: payload.truncated === true,
                  running: payload.running === true,
                  error: null,
                })
                return
              }
              // "No run in this process" is an answer, not a failure: say so plainly.
              setLogView({
                status: payload?.code === 'no-run' ? 'norun' : 'error',
                text: '',
                truncated: false,
                error: String(payload?.message ?? ''),
              })
            },
            (error) => {
              if (live && !controller.signal.aborted) {
                setLogView({ status: 'error', text: '', truncated: false, error: String(error?.message ?? error) })
              }
            },
          )
        }
        load()
        const timer = setInterval(load, LOG_POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
          controller.abort()
        }
      }, [logOpen, logTarget?.id])

      // Escape closes the log view, like the editor and the delete confirmation.
      React.useEffect(() => {
        if (!logOpen) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setLogTarget(null)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [logOpen])

      // Focus the first field when the editor opens, and let Escape close it.
      const editorOpen = form !== null
      React.useEffect(() => {
        if (!editorOpen) return undefined
        const node = fieldRef.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setForm(null)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [editorOpen])

      /**
       * A blank edit form.
       * @param {object | null} payload the state payload, for its default directory.
       * @returns {object} the form.
       */
      const emptyForm = (payload) => ({
        id: undefined,
        name: '',
        projectPath: String(payload?.defaultProjectPath ?? payload?.defaultCwd ?? ''),
        kind: 'script',
        pm: null,
        script: null,
        customCommand: '',
        nodeVersion: null,
        port: '',
        priority: 1,
        batchEnabled: true,
        builder: null,
        profile: null,
      })

      /**
       * Map a stored entry onto the edit form.
       * @param {object} entry the entry.
       * @returns {object} the form.
       */
      const formOf = (entry) => ({
        id: entry.id,
        name: entry.name,
        projectPath: entry.projectPath ?? entry.cwd ?? '',
        kind: entry.kind === 'custom' ? 'custom' : 'script',
        pm: entry.pm ?? null,
        script: entry.script ?? null,
        customCommand: entry.customCommand ?? '',
        nodeVersion: entry.nodeVersion ?? null,
        port: entry.port === null || entry.port === undefined ? '' : String(entry.port),
        priority: entry.priority ?? 1,
        batchEnabled: entry.batchEnabled !== false,
        builder: entry.builder ?? null,
        profile: entry.profile ?? null,
      })

      // Read the folder's facts (scripts, lockfile, git, warnings) whenever the path
      // changes, or when the editor is opened on an entry and asks for a fresh read.
      React.useEffect(() => {
        const directory = typeof form?.projectPath === 'string' ? form.projectPath.trim() : ''
        if (directory === '') {
          setInsp({ status: 'idle', facts: null, error: null })
          return undefined
        }
        const fresh = freshInspect.current
        freshInspect.current = false
        const controller = new AbortController()
        // The previous facts stay for the hint, but the script list shows a loading row:
        // what the user picks must come from the read that is still running.
        setInsp((current) => ({ status: 'loading', facts: current.facts, error: null }))
        const timer = setTimeout(() => {
          const query = `dir=${encodeURIComponent(directory)}&stack=${stack}${fresh ? '&fresh=1' : ''}`
          readJson(`${ROUTES.launchInspect}?${query}`, {
            headers: { accept: 'application/json' },
            signal: controller.signal,
          }).then(
            (payload) => {
              if (payload?.ok === true) {
                setInsp({ status: 'ready', facts: payload, error: null })
                const declared = payload?.backend?.serverPort
                if (stack === 'backend' && typeof declared === 'number') {
                  setForm((current) => (current === null || current.port !== '')
                    ? current
                    : { ...current, port: String(declared) })
                }
              } else {
                setInsp({ status: 'error', facts: null, error: String(payload?.message ?? '') })
              }
            },
            (error) => {
              if (!controller.signal.aborted) {
                setInsp({ status: 'error', facts: null, error: String(error?.message ?? error) })
              }
            },
          )
        }, 350)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [form?.projectPath, inspectToken])

      /**
       * Open the editor for one entry, re-reading that project first.
       *
       * The row no longer carries a 更新 action: opening the editor is the moment the
       * project is read again, so the script list can never be the stale one and the two
       * buttons a row shows stay the two a run actually needs.
       * @param {object} entry the entry to edit.
       * @returns {void}
       */
      const openEditor = (entry) => {
        freshInspect.current = true
        setForm(formOf(entry))
        setInspectToken((value) => value + 1)
      }

      /**
       * Open one row's More menu under its button, kept inside the viewport.
       * @param {object} entry the entry the menu acts on.
       * @param {object | null} node the button that opened it.
       * @returns {void}
       */
      const openMenu = (entry, node) => {
        const width = 152
        const height = 3 * 34 + 12
        const rect = node === null || node === undefined || typeof node.getBoundingClientRect !== 'function'
          ? null
          : node.getBoundingClientRect()
        const viewportWidth = typeof window.innerWidth === 'number' ? window.innerWidth : 1024
        const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 768
        const right = rect === null ? viewportWidth - 8 : rect.right
        const bottom = rect === null ? 8 : rect.bottom
        setMenu({
          entry,
          left: Math.max(8, Math.min(right - width, viewportWidth - width - 8)),
          top: Math.max(8, Math.min(bottom + 4, viewportHeight - height - 8)),
        })
      }

      // Escape, an outside click, a scroll, or a resize closes the menu: it is anchored
      // to a row that moves. The overlay itself lets clicks through, so closing the menu
      // never costs the click the user meant to make.
      const menuOpen = menu !== null
      React.useEffect(() => {
        if (!menuOpen) return undefined
        const close = () => { setMenu(null) }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }
        const onMouseDown = (event) => {
          const node = menuRef.current
          if (node === null || node === undefined) return
          if (typeof node.contains === 'function' && node.contains(event.target)) return
          close()
        }
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('mousedown', onMouseDown, true)
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('mousedown', onMouseDown, true)
          window.removeEventListener('scroll', close, true)
          window.removeEventListener('resize', close)
        }
      }, [menuOpen])

      /** Open the Host-native folder picker and adopt the choice. */
      const pickFolder = async () => {
        const workspace = pluginCtx === null ? null : pluginCtx.get('uiWorkspace')
        if (workspace === null || workspace === undefined || typeof workspace.pickDirectory !== 'function') return
        let picked = null
        try {
          picked = await workspace.pickDirectory()
        } catch {
          picked = null
        }
        if (typeof picked !== 'string' || picked === '') return
        setForm((current) => {
          if (current === null) return current
          const base = picked.split(/[\\/]/).filter((part) => part !== '').pop() ?? ''
          return {
            ...current,
            projectPath: picked,
            pm: null,
            script: null,
            name: current.name.trim() === '' ? base : current.name,
          }
        })
      }


      React.useEffect(() => {
        const controller = new AbortController()
        let live = true
        // Polled: a run ends on its own, and the rows must say so without a reload.
        const load = () => {
          readJson(ROUTES.launchState, { headers: { accept: 'application/json' }, signal: controller.signal }).then(
            (payload) => {
              if (live) setData({ status: 'ready', payload, error: null })
            },
            (error) => {
              if (live && !controller.signal.aborted) {
                setData({ status: 'error', payload: null, error: String(error?.message ?? error) })
              }
            },
          )
        }
        load()
        const timer = setInterval(load, 2500)
        return () => {
          live = false
          clearInterval(timer)
          controller.abort()
        }
      }, [token])

      const entries = Array.isArray(data.payload?.entries)
        ? data.payload.entries.filter((entry) => (entry.stack ?? 'frontend') === stack)
        : []
      const nodeVersions = Array.isArray(data.payload?.nodeVersions) ? data.payload.nodeVersions : []
      const nvmInfo = data.payload?.nvm ?? null
      const busy = pending !== null
      // Anything that opens a dialog built from this list waits while the list is being
      // re-read: 批量启动 needs the entries, 添加 opens a form prefilled from the snapshot.
      const locked = busy || refreshAll

      /**
       * Describe one run's state for the row and the log header.
       * @param {object} entry the entry.
       * @returns {string} the state text.
       */
      const statusText = (entry) => {
        if (entry.status === 'running') {
          return entry.phase === 'ready' ? t('launchPhaseReady') : t('launchPhaseStarting')
        }
        if (entry.status === 'exited') {
          return entry.code === null || entry.code === undefined
            ? t('launchExited')
            : `${t('launchExited')} (${entry.code})`
        }
        return t('launchStopped')
      }

      /**
       * Post one launcher action and publish its outcome.
       * @param {'start' | 'stop' | 'remove'} kind the action.
       * @param {object} entry the entry it applies to.
       * @returns {Promise<void>} settles when the Host answered.
       */
      const act = async (kind, entry) => {
        setPending({ kind, id: entry.id })
        setNotice(null)
        const route = kind === 'start'
          ? ROUTES.launchStart
          : kind === 'stop' ? ROUTES.launchStop : ROUTES.launchRemove
        try {
          const outcome = await readJson(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id: entry.id }),
          })
          if (outcome?.ok === true) {
            // No success banner: the row itself reports the new state.
            setData({ status: 'ready', payload: outcome.state, error: null })
            if (kind === 'remove') setRemoveTarget(null)
          } else {
            setNotice({ kind: 'error', text: String(outcome?.message ?? '') })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) })
        }
        setPending(null)
      }

      /**
       * Save the entry being edited, creating one when it has no id yet.
       * @returns {Promise<void>} settles when the Host answered.
       */
      const save = async () => {
        if (form === null) return
        setPending({ kind: 'save', id: form.id })
        setNotice(null)
        try {
          const outcome = await readJson(ROUTES.launchSave, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              id: form.id,
              name: form.name,
              stack,
              builder: stack === 'backend' ? form.builder : null,
              profile: stack === 'backend' ? form.profile : null,
              projectPath: form.projectPath,
              kind: form.kind,
              pm: form.pm,
              script: form.script,
              customCommand: form.kind === 'custom' ? form.customCommand : null,
              nodeVersion: form.nodeVersion,
              port: form.port === '' ? null : Number(form.port),
              // Stored and echoed back so the value round-trips; nothing consumes it yet.
              priority: Number(form.priority) || 0,
              batchEnabled: form.batchEnabled !== false,
            }),
          })
          if (outcome?.ok === true) {
            // The modal closing is the confirmation; only failures need a banner.
            setData({ status: 'ready', payload: outcome.state, error: null })
            setForm(null)
          } else {
            setNotice({ kind: 'error', text: String(outcome?.message ?? '') })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) })
        }
        setPending(null)
      }

      /**
       * Re-read every project on this pane: branch, lockfile, and warnings, in one request.
       *
       * The row used to own this action; with one button above the list, refreshing is one
       * round trip and one write instead of N of each, and the list stays consistent.
       * @returns {Promise<void>} settles when the Host answered.
       */
      const refreshEverything = async () => {
        setRefreshAll(true)
        setNotice(null)
        try {
          const outcome = await readJson(ROUTES.launchRefreshAll, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          })
          if (outcome?.ok === true) {
            setData({ status: 'ready', payload: outcome.state, error: null })
            // A folder that is gone is the first thing to say, and by name.
            const missing = Array.isArray(outcome.missing) ? outcome.missing : []
            if (missing.length > 0) {
              setNotice({
                kind: 'error',
                text: fill(t('refreshMissing'), {
                  names: missing.map((item) => `${item.name}（${item.projectPath}）`).join('；'),
                }),
              })
            }
          } else {
            setNotice({ kind: 'error', text: String(outcome?.message ?? '') })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) })
        }
        setRefreshAll(false)
      }

      /**
       * The two actions a row always shows, plus everything else under More.
       *
       * A row is scanned, not studied: 启动/停止 and 编辑 are the two it earns, and 输出,
       * 删除 stay one click away instead of pushing the column into a second line.
       * @param {object} entry the entry.
       * @param {boolean} blocked whether a warning forbids starting it.
       * @returns {object} the action group.
       */
      function actionsOf(entry, blocked) {
        const working = pending !== null && pending.id === entry.id ? pending.kind : null
        const running = entry.status === 'running'
        const primary = running
          ? h('button', {
            key: 'primary',
            type: 'button',
            className: 'ndv-button',
            disabled: busy,
            'aria-label': `${t('launchStop')} ${entry.name}`,
            onClick: () => { act('stop', entry).catch(() => {}) },
          }, working === 'stop' ? t('launchStopping') : t('launchStop'))
          : h('button', {
            key: 'primary',
            type: 'button',
            className: 'ndv-button lch-primary',
            disabled: busy || blocked,
            title: blocked ? t('launchBlocked') : undefined,
            'aria-label': `${t('launchStart')} ${entry.name}`,
            onClick: () => { act('start', entry).catch(() => {}) },
          }, working === 'start' ? t('launchStarting') : t('launchStart'))
        return h('div', { className: 'lch-actions' },
          primary,
          h('button', {
            key: 'edit',
            type: 'button',
            className: 'ndv-button',
            disabled: busy,
            title: t('launchEdit'),
            onClick: () => { openEditor(entry) },
          }, t('launchEdit')),
          h('button', {
            key: 'more',
            type: 'button',
            className: 'ndv-button lch-more',
            'aria-haspopup': 'menu',
            'aria-expanded': menu !== null && menu.entry.id === entry.id ? 'true' : 'false',
            'aria-label': `${t('actionsMore')} ${entry.name}`,
            onClick: (event) => { openMenu(entry, event.currentTarget) },
          }, t('actionsMore'), h('span', { className: 'lch-caret', 'aria-hidden': 'true' }, '▾')),
        )
      }

      /**
       * The More menu: the row's remaining actions, floating above the table.
       * @returns {object} the overlay element.
       */
      function moreMenu() {
        const entry = menu.entry
        const items = [
          {
            key: 'log',
            label: t('launchLog'),
            title: t('launchLogHint'),
            run: () => { setLogTarget(entry) },
          },
          {
            key: 'remove',
            label: t('launchRemove'),
            danger: true,
            disabled: busy,
            run: () => { setRemoveTarget(entry) },
          },
        ]
        return h('div', {
          className: 'lch-menu-overlay',
          onContextMenu: (event) => { event.preventDefault(); setMenu(null) },
        },
          h('div', {
            className: 'lch-menu',
            role: 'menu',
            ref: menuRef,
            'aria-label': `${t('actionsMore')} ${entry.name}`,
            style: { left: `${menu.left}px`, top: `${menu.top}px` },
          }, items.map((item) => h('button', {
            key: item.key,
            type: 'button',
            role: 'menuitem',
            className: item.danger ? 'lch-menu-item lch-danger' : 'lch-menu-item',
            title: item.title,
            disabled: item.disabled === true,
            onClick: () => { setMenu(null); item.run() },
          }, item.label))),
        )
      }
      /**
       * The entry editor, rendered inside the modal.
       * @returns {object} the form element.
       */
      function formView() {
        const facts = insp.facts
        const warnings = []
        if (insp.status === 'error') {
          warnings.push({
            level: 'block',
            text: fill(t('launchInspectFailed'), { message: String(insp.error ?? '') }),
          })
        }
        for (const warning of Array.isArray(facts?.warnings) ? facts.warnings : []) {
          warnings.push({ level: warning.level, text: warning.text })
        }
        if (stack === 'backend') {
          if (form.kind === 'script' && form.builder === null) {
            warnings.push({ level: 'block', text: t('launchNeedBuilder') })
          }
          if (form.kind === 'custom' && form.customCommand.trim() === '') {
            warnings.push({ level: 'block', text: t('launchNeedCommand') })
          }
        } else if (form.kind === 'script') {
          if (form.pm === null) warnings.push({ level: 'block', text: t('launchNeedPm') })
          if (form.script === null) warnings.push({ level: 'block', text: t('launchNeedScript') })
        } else if (form.customCommand.trim() === '') {
          warnings.push({ level: 'block', text: t('launchNeedCommand') })
        }
        if (form.name.trim() === '') warnings.push({ level: 'block', text: t('launchNeedName') })

        const scripts = orderedScripts(Array.isArray(facts?.scripts) ? facts.scripts : [])
        const scriptsLoading = insp.status === 'loading'
        const backendFacts = facts?.backend ?? null
        const profiles = Array.isArray(backendFacts?.profiles) ? backendFacts.profiles : []
        const activeProfile = backendFacts?.activeProfile ?? null
        const detectedBuilder = backendFacts?.maven?.present === true
          ? 'maven'
          : backendFacts?.gradle?.present === true ? 'gradle' : null
        const builderName = (builder) => (builder === 'gradle' ? t('launchBuilderGradle') : t('launchBuilderMaven'))
        const goalOf = (builder) => (builder === 'gradle' ? 'bootRun' : 'spring-boot:run')
        const blocked = warnings.some((warning) => warning.level === 'block')
        // Saving before the folder has been read would submit a choice the user could not
        // see yet; the read is quick, and the button says so by staying disabled.
        const canSave = !busy && !blocked && !scriptsLoading
        const lockfile = facts?.lockfile ?? null
        const detection = insp.status === 'loading'
          ? t('launchInspecting')
          : stack === 'backend'
            ? detectedBuilder === null
              ? t('launchNoBackendBuild')
              : t('launchBuilderDetected') + ' ' + builderName(detectedBuilder)
                + (backendFacts?.maven?.javaVersion ? ' · Java ' + backendFacts.maven.javaVersion : '')
                + (backendFacts?.serverPort === null || backendFacts?.serverPort === undefined ? '' : ' · :' + String(backendFacts.serverPort))
            : lockfile === null
              ? t('launchNoLockfile')
              : fill(t('launchDetected'), { what: lockfile.name })
        const followValue = fill(t('launchNodeFollowValue'), {
          version: nodeVersions.length === 0 ? '—' : String(data.payload?.currentVersion ?? nodeVersions[0]),
        })

        return h('div', { className: 'lch-form' },
          h('label', { className: 'lch-field' },
            h('span', null, t('launchNameLabel')),
            h('input', {
              className: 'lch-input',
              ref: fieldRef,
              value: form.name,
              placeholder: t('launchNamePlaceholder'),
              onChange: (event) => { setForm({ ...form, name: event.target.value }) },
            }),
          ),
          h('label', { className: 'lch-field' },
            h('span', null, t('launchDirLabel')),
            h('div', { className: 'lch-inline' },
              h('input', {
                className: 'lch-input ndv-mono',
                value: form.projectPath,
                placeholder: String(data.payload?.defaultProjectPath ?? data.payload?.defaultCwd ?? ''),
                onChange: (event) => {
                  const projectPath = event.target.value
                  setForm((current) => current === null ? current : { ...current, projectPath, pm: null, script: null })
                },
              }),
              h('button', {
                type: 'button',
                className: 'ndv-button',
                onClick: () => { pickFolder().catch(() => {}) },
              }, t('launchPick')),
            ),
          ),
          h('p', { className: 'lch-hint' }, detection),
          stack === 'backend'
            ? h(React.Fragment, null,
              h('div', { className: 'lch-field' },
                h('span', null, t('launchBuilderLabel')),
                h('div', { className: 'lch-seg', role: 'group', 'aria-label': t('launchBuilderLabel') },
                  ['maven', 'gradle'].map((builder) => h('button', {
                    key: builder,
                    type: 'button',
                    'data-on': form.builder === builder ? 'true' : 'false',
                    onClick: () => { setForm({ ...form, builder }) },
                  }, builderName(builder))),
                ),
              ),
              form.kind === 'custom'
                ? h('label', { className: 'lch-field' },
                  h('span', null, t('launchCustomLabel')),
                  h('input', {
                    className: 'lch-input ndv-mono',
                    value: form.customCommand,
                    placeholder: 'mvn spring-boot:run -Dspring-boot.run.profiles=dev',
                    onChange: (event) => { setForm({ ...form, customCommand: event.target.value }) },
                  }),
                )
                : h(React.Fragment, null,
                  h('div', { className: 'lch-grid2' },
                    h('label', { className: 'lch-field' },
                      h('span', null, t('launchGoalLabel')),
                      h('input', {
                        className: 'lch-input ndv-mono',
                        readOnly: true,
                        value: form.builder === null ? '' : goalOf(form.builder),
                        placeholder: goalOf('maven'),
                      }),
                    ),
                    h('label', { className: 'lch-field' },
                      h('span', null, t('launchProfileLabel')),
                      h('select', {
                        className: 'lch-select',
                        value: form.profile ?? '',
                        onChange: (event) => {
                          const profile = event.target.value === '' ? null : event.target.value
                          setForm({ ...form, profile })
                        },
                      },
                        h('option', { value: '' }, t('launchProfileFollow')),
                        profiles.map((profile) => h('option', { key: profile, value: profile },
                          profile === activeProfile ? profile + ' (' + t('launchCurrent') + ')' : profile)),
                      ),
                    ),
                  ),
                  h('p', { className: 'lch-hint' }, t('launchProfileHint')),
                ),
            )
            : h(React.Fragment, null,
          h('label', { className: 'lch-field' },
            h('span', null, t('launchScriptLabel')),
            h('select', {
              className: 'lch-select',
              // While the folder is being read, the list belongs to the previous read:
              // offering it would let the user pick a script that no longer exists.
              disabled: scriptsLoading,
              value: scriptsLoading ? '' : form.kind === 'custom' ? '__custom__' : form.script ?? '',
              onChange: (event) => {
                const value = event.target.value
                if (value === '__custom__') setForm({ ...form, kind: 'custom', script: null })
                else if (value === '') setForm({ ...form, kind: 'script', script: null })
                else setForm({ ...form, kind: 'script', script: value })
              },
            },
              scriptsLoading
                ? h('option', { value: '' }, t('launchScriptLoading'))
                : [
                  h('option', { key: 'placeholder', value: '' }, t('launchScriptPlaceholder')),
                  ...scripts.map((item) => h('option', { key: item.name, value: item.name }, `${item.name} — ${item.value}`)),
                  h('option', { key: 'custom', value: '__custom__' }, t('launchScriptCustom')),
                ],
            ),
          ),
          form.kind === 'custom'
            ? h('label', { className: 'lch-field' },
              h('span', null, t('launchCustomLabel')),
              h('input', {
                className: 'lch-input ndv-mono',
                value: form.customCommand,
                placeholder: t('launchCustomPlaceholder'),
                onChange: (event) => { setForm({ ...form, customCommand: event.target.value }) },
              }),
            )
            : null,
          h('div', { className: 'lch-field' },
            h('span', null, t('launchPmLabel')),
            h('div', { className: 'lch-seg', role: 'group', 'aria-label': t('launchPmLabel') },
              PACKAGE_MANAGERS.map((pm) => h('button', {
                key: pm,
                type: 'button',
                'data-on': form.pm === pm ? 'true' : 'false',
                'aria-pressed': form.pm === pm,
                onClick: () => { setForm({ ...form, pm: form.pm === pm ? null : pm }) },
              }, pm)),
            ),
          ),
          h('label', { className: 'lch-field' },
            h('span', null, t('launchNodeLabel')),
            h('select', {
              className: 'lch-select',
              value: form.nodeVersion ?? '',
              onChange: (event) => {
                const value = event.target.value
                setForm({ ...form, nodeVersion: value === '' ? null : value })
              },
            },
              h('option', { value: '' }, followValue),
              nodeVersions.map((version) => h('option', { key: version, value: version }, `v${version}`)),
            ),
          ),
          nvmInfo === null || nvmInfo.available === true
            ? (nodeVersions.length === 0 ? h('p', { className: 'lch-hint' }, t('launchNoNodeVersions')) : null)
            : h('p', { className: 'lch-hint', 'data-kind': 'error' }, t('launchNoNvm')),
          ),
          h('div', { className: 'lch-grid2' },
            h('label', { className: 'lch-field' },
              h('span', null, t('launchPortLabel')),
              h('input', {
                className: 'lch-input',
                value: form.port,
                placeholder: t('launchPortPlaceholder'),
                inputMode: 'numeric',
                onChange: (event) => { setForm({ ...form, port: event.target.value.replace(/[^\d]/g, '') }) },
              }),
            ),
            h('label', { className: 'lch-field' },
              h('span', null, t('launchPriorityLabel')),
              h('input', {
                className: 'lch-input',
                value: String(form.priority),
                inputMode: 'numeric',
                min: 0,
                max: 99,
                title: t('launchPriorityHint'),
                onChange: (event) => {
                  const digits = event.target.value.replace(/[^\d]/g, '')
                  const parsed = Number.parseInt(digits === '' ? '1' : digits, 10)
                  setForm({ ...form, priority: Math.min(99, Math.max(0, Number.isFinite(parsed) ? parsed : 1)) })
                },
              }),
            ),
          ),
          h('p', { className: 'lch-hint' }, t('launchPriorityHint')),
          h('label', { className: 'lch-check' },
            h('input', {
              type: 'checkbox',
              checked: form.batchEnabled !== false,
              onChange: (event) => { setForm({ ...form, batchEnabled: event.target.checked }) },
            }),
            h('span', null, t('batchParticipate')),
          ),
          h('p', { className: 'lch-hint' }, t('batchParticipateHint')),
          warnings.length === 0 ? null : h('div', { className: 'lch-warnbox' },
            warnings.map((warning, index) => h('span', {
              key: index,
              className: 'lch-warnline',
              'data-level': warning.level,
            }, warning.text)),
          ),
          h('div', { className: 'lch-form-actions' },

            h('button', {
              type: 'button',
              className: 'ndv-button lch-primary',
              disabled: !canSave,
              title: blocked ? t('launchBlocked') : undefined,
              onClick: () => { save().catch(() => {}) },
            }, t('launchSave')),
            h('button', {
              type: 'button',
              className: 'ndv-button',
              disabled: busy,
              onClick: () => { setForm(null) },
            }, t('launchCancel')),
          ),
        )
      }


      /**
       * One entry as table rows: the data row plus a warning row when it has any.
       * @param {object} entry the entry, with its run view.
       * @returns {object} the fragment of rows.
       */
      function entryRows(entry) {
        const warnings = Array.isArray(entry.warnings) ? entry.warnings : []
        const blocking = warnings.filter((warning) => warning.level === 'block')
        const shown = warnings.filter((warning) => warning.level !== 'info')
        const starting = entry.status === 'running' && entry.phase !== 'ready'
        const ready = entry.status === 'running' && entry.phase === 'ready'
        const effectivePort = entry.runPort ?? entry.port ?? null
        const links = []
        // Only the LAN address: the local one is implied by the machine you are on.
        if (ready && typeof entry.lanUrl === 'string' && entry.lanUrl !== '') {
          links.push(h('a', {
            key: 'lan',
            className: 'lch-link',
            href: entry.lanUrl,
            target: '_blank',
            rel: 'noreferrer',
            title: t('launchLanHint'),
          }, String(entry.lanUrl).replace(/^https?:\/\//, '')))
        }
        const nodeText = typeof entry.actualNode === 'string' && entry.actualNode !== ''
          ? `v${entry.actualNode}`
          : entry.nodeVersion === null || entry.nodeVersion === undefined
            ? t('launchColFollow')
            : `v${entry.nodeVersion}`
        return h(React.Fragment, { key: entry.id },
          h('tr', { className: 'lch-trow', 'data-state': entry.status },
            h('td', null,
              h('span', { className: 'lch-cell-name', title: entry.name }, entry.name),
            ),
            h('td', { className: 'lch-cell-cwd', title: entry.projectPath }, entry.projectPath),
            h('td', null,
              h('div', { className: 'lch-cell-state' },
                h('span', { className: 'lch-state', 'data-state': entry.status }, statusText(entry)),
                entry.orphan === true
                  ? h('span', { className: 'lch-orphan', title: t('launchAdoptedHint') }, t('launchAdopted'))
                  : null,

                starting
                  ? h('div', { className: 'lch-stage' },
                    h('span', { className: 'lch-stage-seg', 'data-on': 'true' }),
                    h('span', {
                      className: 'lch-stage-seg',
                      'data-on': typeof entry.tail === 'string' && entry.tail !== '' ? 'true' : 'false',
                      'data-pulse': typeof entry.tail === 'string' && entry.tail !== '' ? 'false' : 'true',
                    }),
                    h('span', { className: 'lch-stage-seg', 'data-on': 'false' }),
                  )
                  : null,
              ),
            ),
            h('td', { className: 'lch-cell-mono' },
              typeof entry.branch === 'string' && entry.branch !== ''
                ? entry.branch
                : h('span', { className: 'lch-dim' }, '—'),
            ),
            h('td', { className: 'lch-cell-mono', title: String(entry.command ?? '') }, String(entry.command ?? '')),
            h('td', { className: 'lch-cell-mono' },
              stack === 'backend'
                ? (entry.profile === null || entry.profile === undefined
                  ? h('span', { className: 'lch-dim' }, t('launchProfileFollow'))
                  : entry.profile)
                : nodeText),
            h('td', null, links.length === 0
              ? h('span', { className: 'lch-dim lch-cell-mono' },
                effectivePort === null ? '—' : `:${effectivePort}`)
              : h('span', { className: 'lch-links' }, links)),
            h('td', { className: 'ndv-col-actions' }, actionsOf(entry, blocking.length > 0)),
          ),
          entry.status === 'exited' && typeof entry.tail === 'string' && entry.tail !== ''
            ? h('tr', { key: `${entry.id}-tail` },
              h('td', {
                colSpan: 8,
                className: 'lch-tailcell',
                'data-state': entry.status,
              }, entry.tail),
            )
            : null,
          shown.length === 0
            ? null
            : h('tr', { key: `${entry.id}-warn` },
              h('td', { colSpan: 8, className: 'lch-warncell' },
                h('div', { className: 'lch-warnbox' },
                  shown.map((warning, index) => h('span', {
                    key: index,
                    className: 'lch-warnline',
                    'data-level': warning.level,
                  }, warning.text)),
                ),
              ),
            ),
        )
      }

      /**
       * The editor as a modal dialog over the pane. Hook-free: the component owns
       * the focus and Escape wiring, so this can be rendered conditionally.
       * @returns {object} the overlay element.
       */
      function formModal() {
        const editing = form.id !== undefined
        return h('div', {
          className: 'lch-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) setForm(null)
          },
        },
          h('div', {
            className: 'lch-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': editing ? t('launchEditTitle') : t('launchNewTitle'),
          },
            h('div', { className: 'lch-modal-head' },
              h('h3', { className: 'lch-modal-title' }, editing ? t('launchEditTitle') : t('launchNewTitle')),
              h('button', {
                type: 'button',
                className: 'lch-modal-close',
                'aria-label': t('launchCancel'),
                title: t('launchCancel'),
                onClick: () => { setForm(null) },
              }, '\u2715'),
            ),
            formView(),
          ),
        )
      }

      /**
       * Entries in start order: creation order.
       *
       * `priority` is stored, editable, and shown on the row, but nothing consumes it yet:
       * the order is simply what was added first. When it does get a rule, the values are
       * already there.
       * @returns {Array<object>} the ordered entries.
       */
      function orderedEntries() {
        return [...entries].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
      }

      /**
       * Open the batch dialog with the entries the stored flags currently include.
       *
       * The checkboxes are the persisted participation flag, not a scratch selection:
       * what the dialog shows is what the next batch start will use.
       * @returns {void}
       */
      function openBatch() {
        batchCancel.current = false
        setBatchRun(null)
        // Re-read before showing: the checkboxes must be the saved ones, not a stale poll.
        setToken((value) => value + 1)
        setBatchOpen(true)
      }

      /**
       * Persist one entry's batch participation.
       * @param {object} entry the entry.
       * @param {boolean} on whether it takes part.
       * @returns {Promise<void>} settles when the Host answered.
       */
      async function setEntryBatch(entry, on) {
        // Optimistic: a checkbox must not wait for a round trip, and reopening the
        // dialog right after clicking must already show the new state.
        setData((current) => {
          const entries = current?.payload?.entries
          if (!Array.isArray(entries)) return current
          return {
            ...current,
            payload: {
              ...current.payload,
              entries: entries.map((candidate) => (candidate.id === entry.id ? { ...candidate, batchEnabled: on } : candidate)),
            },
          }
        })
        try {
          const outcome = await readJson(ROUTES.launchBatchEnabled, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id: entry.id, batchEnabled: on }),
          })
          if (outcome?.ok === true) {
            setData({ status: 'ready', payload: outcome.state, error: null })
            return
          }
          setNotice({ kind: 'error', text: String(outcome?.message ?? '') })
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) })
        }
        // The write failed: rebuild from the Host so the checkbox tells the truth.
        setToken((value) => value + 1)
      }

      /**
       * Set batch participation for several entries, in order.
       * @param {Array<object>} targets the entries.
       * @param {boolean} on whether they take part.
       * @returns {Promise<void>} settles when the last write answered.
       */
      async function setEntryBatchAll(targets, on) {
        for (const entry of targets) await setEntryBatch(entry, on)
      }

      /**
       * Wait until one entry answers on its port, exits, or runs out of time.
       *
       * A dev server is "up" when its port accepts a connection; in the serial mode
       * starting the next project earlier would race against it (the SSO case: the
       * others log in through it, so it has to be listening first). The budget follows
       * the stack: a backend entry compiles before it listens, so it gets longer.
       * @param {string} id the entry.
       * @param {number} budget how long this entry may take, in milliseconds.
       * @returns {Promise<string>} `ready`, `cancelled`, `missing`, `timeout`, or `failed:<tail>`.
       */
      async function waitForReady(id, budget) {
        const deadline = Date.now() + budget
        while (Date.now() < deadline) {
          if (batchCancel.current) return 'cancelled'
          const payload = await readJson(ROUTES.launchState, { headers: { accept: 'application/json' } })
          if (payload?.ok === false) return 'missing'
          const entry = (payload?.entries ?? []).find((candidate) => candidate.id === id)
          if (entry === undefined) return 'missing'
          setData({ status: 'ready', payload, error: null })
          if (entry.phase === 'ready') return 'ready'
          if (entry.status === 'exited') return `failed:${String(entry.tail ?? '')}`
          await new Promise((resolve) => { setTimeout(resolve, 800) })
        }
        return 'timeout'
      }

      /** How long one entry of this stack may take to answer on its port. */
      const readyBudgetOf = (entry) => (
        entry.stack === 'backend' ? BATCH_READY_TIMEOUT_BACKEND_MS : BATCH_READY_TIMEOUT_MS
      )

      /**
       * Start one entry from a batch, recording a refusal instead of throwing.
       * @param {object} entry the entry.
       * @param {object} results per-entry outcomes, mutated in place.
       * @returns {Promise<boolean>} whether it started.
       */
      async function startForBatch(entry, results) {
        try {
          const outcome = await readJson(ROUTES.launchStart, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id: entry.id }),
          })
          if (outcome?.ok !== true) {
            results[entry.id] = `failed:${String(outcome?.message ?? '')}`
            return false
          }
          setData({ status: 'ready', payload: outcome.state, error: null })
          return true
        } catch (error) {
          results[entry.id] = `failed:${String(error?.message ?? error)}`
          return false
        }
      }

      /**
       * Start every picked entry at once, then watch all their ports together.
       *
       * This is the default because most projects do not depend on each other, and
       * waiting for a port that will answer in 40 seconds to start the next one only
       * makes the batch as slow as the sum of its parts. A dependency that needs the
       * other service already listening belongs to the serial mode.
       * @param {Array<object>} queue the entries, in list order.
       * @param {object} results per-entry outcomes, mutated in place.
       * @param {(phase: string, index: number) => void} publish push the dialog's state.
       * @returns {Promise<void>} settles when every port answered, failed, or ran out of time.
       */
      async function runBatchParallel(queue, results, publish) {
        const waiting = new Map()
        for (const entry of queue) {
          if (batchCancel.current) {
            for (const pendingEntry of queue) {
              if (results[pendingEntry.id] === undefined) results[pendingEntry.id] = 'cancelled'
            }
            publish('cancelled', 0)
            return
          }
          results[entry.id] = 'starting'
          publish('running', 0)
          if (await startForBatch(entry, results)) waiting.set(entry.id, Date.now() + readyBudgetOf(entry))
        }
        publish('running', 0)
        while (waiting.size > 0) {
          if (batchCancel.current) {
            for (const id of waiting.keys()) results[id] = 'cancelled'
            publish('cancelled', 0)
            return
          }
          await new Promise((resolve) => { setTimeout(resolve, 800) })
          let payload
          try {
            payload = await readJson(ROUTES.launchState, { headers: { accept: 'application/json' } })
          } catch (error) {
            for (const id of waiting.keys()) results[id] = `failed:${String(error?.message ?? error)}`
            publish('failed', 0)
            return
          }
          setData({ status: 'ready', payload, error: null })
          for (const [id, deadline] of [...waiting]) {
            const row = (payload?.entries ?? []).find((candidate) => candidate.id === id)
            if (row === undefined) { results[id] = 'missing'; waiting.delete(id); continue }
            if (row.phase === 'ready') { results[id] = 'ready'; waiting.delete(id); continue }
            if (row.status === 'exited') { results[id] = `failed:${String(row.tail ?? '')}`; waiting.delete(id); continue }
            if (Date.now() > deadline) { results[id] = 'timeout'; waiting.delete(id) }
          }
          publish('running', 0)
        }
        const allReady = Object.values(results).every((value) => value === 'ready')
        publish(allReady ? 'done' : 'failed', 0)
      }

      /**
       * Start the picked entries one at a time, each after the previous one is up.
       * @param {Array<object>} queue the entries, in list order.
       * @param {object} results per-entry outcomes, mutated in place.
       * @param {(phase: string, index: number) => void} publish push the dialog's state.
       * @returns {Promise<void>} settles when the run stops, finishes, or fails.
       */
      async function runBatchSerial(queue, results, publish) {
        for (let index = 0; index < queue.length; index += 1) {
          const entry = queue[index]
          if (batchCancel.current) { publish('cancelled', index); return }
          results[entry.id] = 'starting'
          publish('running', index)
          if (!await startForBatch(entry, results)) { publish('failed', index); return }
          const waited = await waitForReady(entry.id, readyBudgetOf(entry))
          if (waited === 'ready') {
            results[entry.id] = 'ready'
            publish('running', index + 1)
            continue
          }
          results[entry.id] = waited
          publish(waited === 'cancelled' ? 'cancelled' : 'failed', index)
          return
        }
        publish('done', queue.length)
      }

      /**
       * Run the batch in the mode the dialog is set to.
       * @returns {Promise<void>} settles when the run stops or every entry is accounted for.
       */
      async function runBatch() {
        const queue = orderedEntries().filter((entry) => entry.batchEnabled !== false && entry.status !== 'running')
        if (queue.length === 0) {
          setBatchRun({ phase: 'failed', index: 0, results: {}, message: t('batchNothing') })
          return
        }
        batchCancel.current = false
        const results = {}
        const publish = (phase, index) => { setBatchRun({ phase, index, results: { ...results } }) }
        if (batchMode === 'serial') await runBatchSerial(queue, results, publish)
        else await runBatchParallel(queue, results, publish)
      }

      /**
       * The batch-start dialog: pick entries, then start them in order.
       * @returns {object} the overlay element.
       */
      function batchModal() {
        const running = batchRun !== null && batchRun.phase === 'running'
        const results = batchRun?.results ?? {}
        const rows = orderedEntries()
        const idle = rows.filter((entry) => entry.status !== 'running')
        const selected = idle.filter((entry) => entry.batchEnabled !== false).length
        const statusOfRow = (entry) => {
          const result = results[entry.id]
          if (result === 'starting') return { text: t('batchStartingNow'), kind: 'running' }
          if (result === 'ready') return { text: t('batchReady'), kind: 'ok' }
          if (result === 'timeout') return { text: t('batchTimeout'), kind: 'error' }
          if (result === 'cancelled') return { text: t('batchCancelled'), kind: 'muted' }
          if (typeof result === 'string' && result.startsWith('failed:')) {
            return { text: `${t('batchFailed')} ${result.slice('failed:'.length).trim()}`.trim(), kind: 'error' }
          }
          if (entry.status === 'running') return { text: t('batchRunningTag'), kind: 'ok' }
          return { text: t('batchWaiting'), kind: 'muted' }
        }
        const footer = []
        if (!running) {
          footer.push(h('button', {
            key: 'none',
            type: 'button',
            className: 'ndv-button',
            onClick: () => { setEntryBatchAll(idle, false).catch(() => {}) },
          }, t('batchSelectNone')))
          footer.push(h('button', {
            key: 'all',
            type: 'button',
            className: 'ndv-button',
            onClick: () => { setEntryBatchAll(idle, true).catch(() => {}) },
          }, t('batchSelectAll')))
        }
        footer.push(h('span', { key: 'spacer', className: 'lch-spacer' }))
        footer.push(h('button', {
          key: 'cancel',
          type: 'button',
          className: 'ndv-button',
          onClick: () => {
            if (running) {
              batchCancel.current = true
              return
            }
            setBatchOpen(false)
            setBatchRun(null)
          },
        }, running ? t('batchStop') : t('launchCancel')))
        footer.push(h('button', {
          key: 'start',
          type: 'button',
          className: 'ndv-button lch-primary',
          disabled: running || selected === 0,
          onClick: () => { runBatch().catch(() => {}) },
        }, running ? t('batchStarting') : `${t('batchStart')} (${selected})`))
        return h('div', {
          className: 'lch-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !running) {
              setBatchOpen(false)
              setBatchRun(null)
            }
          },
        },
          h('div', {
            className: 'lch-modal lch-modal--wide',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('batchTitle'),
          },
            h('div', { className: 'lch-modal-head' },
              h('h3', { className: 'lch-modal-title' }, t('batchTitle')),
              h('button', {
                type: 'button',
                className: 'lch-modal-close',
                'aria-label': t('launchCancel'),
                disabled: running,
                onClick: () => { setBatchOpen(false); setBatchRun(null) },
              }, '\u2715'),
            ),
            h('div', { className: 'lch-field' },
              h('span', null, t('batchMode')),
              h('div', { className: 'lch-seg', role: 'group', 'aria-label': t('batchMode') },
                ['parallel', 'serial'].map((mode) => h('button', {
                  key: mode,
                  type: 'button',
                  'data-on': batchMode === mode ? 'true' : 'false',
                  'aria-pressed': batchMode === mode,
                  disabled: running,
                  onClick: () => { setBatchMode(mode) },
                }, mode === 'parallel' ? t('batchModeParallel') : t('batchModeSerial')))),
            ),
            h('p', { className: 'lch-hint' },
              batchMode === 'parallel' ? t('batchParallelHint') : t('batchSerialHint')),
            h('ul', { className: 'lch-batch-list' }, rows.map((entry, index) => {
              const state = statusOfRow(entry)
              const alreadyRunning = entry.status === 'running'
              return h('li', { key: entry.id, className: 'lch-batch-row' },
                h('span', { className: 'lch-batch-order' }, String(index + 1)),
                h('label', { className: 'lch-batch-label' },
                  h('input', {
                    type: 'checkbox',
                    checked: alreadyRunning || entry.batchEnabled !== false,
                    disabled: running || alreadyRunning,
                    onChange: (event) => { setEntryBatch(entry, event.target.checked).catch(() => {}) },
                  }),
                  h('span', { className: 'lch-batch-name' }, entry.name),
                ),
                h('span', { className: 'lch-batch-state', 'data-kind': state.kind }, state.text),
              )
            })),
            batchRun === null || batchRun.phase === 'running' ? null : h('p', {
              className: 'lch-hint',
              'data-kind': batchRun.phase === 'done' ? 'ok' : 'error',
            }, batchRun.phase === 'done'
              ? t('batchDone')
              : batchRun.phase === 'cancelled'
                ? t('batchCancelledHint')
                : batchMode === 'serial' ? t('batchStoppedHint') : t('batchFailedSome')),
            h('div', { className: 'lch-form-actions' }, footer),
          ),
        )
      }

      /**
       * One run's output, in a dialog over the pane.
       *
       * The row only ever shows the last line, because a table cell is one line high;
       * this is where the buffered output becomes readable. Nothing is stored: a run
       * that this process never started simply has no log to show.
       * @returns {object} the overlay element.
       */
      function logModal() {
        const entry = logTarget
        const view = logView
        const body = view === null || view.status === 'loading'
          ? h('p', { className: 'lch-hint' }, t('launchLoading'))
          : view.status === 'norun'
            ? h('p', { className: 'lch-hint' }, t('launchLogNoRun'))
            : view.status === 'error'
              ? h('p', { className: 'lch-hint', 'data-kind': 'error' }, view.error)
              : h('pre', { className: 'lch-log' }, view.text === '' ? t('launchLogEmpty') : view.text)
        return h('div', {
          className: 'lch-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) setLogTarget(null)
          },
        },
          h('div', {
            className: 'lch-modal lch-modal--wide',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': fill(t('launchLogTitle'), { name: entry.name }),
          },
            h('div', { className: 'lch-modal-head' },
              h('h3', { className: 'lch-modal-title' }, fill(t('launchLogTitle'), { name: entry.name })),
              h('button', {
                type: 'button',
                className: 'lch-modal-close',
                'aria-label': t('launchCancel'),
                title: t('launchCancel'),
                onClick: () => { setLogTarget(null) },
              }, '\u2715'),
            ),
            body,
            h('p', { className: 'lch-hint' },
              t('launchLogHint'),
              view !== null && view.truncated === true
                ? ' ' + fill(t('launchLogTruncated'), { count: String(LOG_VIEW_LINES) })
                : null),
            h('div', { className: 'lch-form-actions' },
              h('button', {
                type: 'button',
                className: 'ndv-button lch-primary',
                onClick: () => { setLogTarget(null) },
              }, t('launchCancel')),
            ),
          ),
        )
      }

      /**
       * The delete confirmation dialog.
       *
       * A second click on the row button was too easy to miss and too easy to hit
       * again by accident; a dialog says what is about to go, including the process.
       * @returns {object} the overlay element.
       */
      function removeModal() {
        const entry = removeTarget
        const working = pending !== null && pending.id === entry.id && pending.kind === 'remove'
        return h('div', {
          className: 'lch-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) setRemoveTarget(null)
          },
        },
          h('div', {
            className: 'lch-modal',
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-label': t('removeTitle'),
          },
            h('div', { className: 'lch-modal-head' },
              h('h3', { className: 'lch-modal-title' }, t('removeTitle')),
              h('button', {
                type: 'button',
                className: 'lch-modal-close',
                'aria-label': t('launchCancel'),
                onClick: () => { setRemoveTarget(null) },
              }, '\u2715'),
            ),
            h('p', { className: 'lch-confirm-text' }, fill(t('removeConfirm'), { name: entry.name })),
            h('p', { className: 'lch-confirm-path', title: entry.projectPath }, entry.projectPath),
            h('p', { className: 'lch-hint' }, entry.status === 'running' ? t('removeConfirmRunning') : t('removeConfirmHint')),
            h('div', { className: 'lch-form-actions' },
              h('button', {
                type: 'button',
                className: 'ndv-button',
                ref: confirmCancelRef,
                disabled: working,
                onClick: () => { setRemoveTarget(null) },
              }, t('launchCancel')),
              h('button', {
                type: 'button',
                className: 'ndv-button lch-danger-solid',
                disabled: working,
                onClick: () => { act('remove', entry).catch(() => {}) },
              }, working ? t('removing') : t('launchRemove')),
            ),
          ),
        )
      }

      /**
       * The scrolling region: the table, or the state that replaces it.
       * @returns {object} the content.
       */
      function scroller() {
        if (data.status === 'error') {
          return h('div', { className: 'ndv-warn' },
            h('p', { className: 'ndv-warn-title' }, t('launchLoadFailed')),
            h('p', { className: 'ndv-note ndv-note--muted ndv-mono' }, String(data.error ?? '')),
            h('div', null,
              h('button', {
                type: 'button',
                className: 'ndv-button',
                onClick: () => { setToken((value) => value + 1) },
              }, t('retry'))),
          )
        }
        if (data.status !== 'ready') {
          return h('p', { className: 'ndv-note ndv-note--muted' }, t('launchLoading'))
        }
        const parts = []
        if (entries.length === 0) {
          parts.push(h('div', { className: 'ndv-empty', key: 'empty' },
            h('p', { className: 'ndv-empty-text' },
              stack === 'backend' ? t('launchBackendEmpty') : t('launchFrontendEmpty')),
            h('button', {
              type: 'button',
              className: 'ndv-button lch-primary',
              disabled: locked,
              onClick: () => { setForm(emptyForm(data.payload)) },
            }, t('launchAdd')),
          ))
        } else {
          parts.push(h('table', { className: 'ndv-table lch-table', key: 'table' },
            h('thead', null,
              h('tr', null,
                h('th', null, t('launchColProject')),
                h('th', null, t('launchColPath')),
                h('th', null, t('launchColState')),
                h('th', null, t('launchColBranch')),
                h('th', null, t('launchColScript')),
                h('th', null, stack === 'backend' ? t('launchColProfile') : t('launchColNode')),
                h('th', null, t('launchColPort')),
                h('th', { className: 'ndv-col-actions' }, t('launchColActions')),
              ),
            ),
            h('tbody', null, entries.map((entry) => entryRows(entry))),
          ))
        }
        if (nvmInfo !== null && nvmInfo.available === false && entries.length > 0) {
          parts.unshift(h('p', { className: 'lch-hint', key: 'nvm-absent', 'data-kind': 'notice' }, t('launchNvmAbsentNote')))
        }
        return h(React.Fragment, null, parts)
      }

      return h('div', { className: 'ndv-body' },
        h('style', null, SYSTEM_STYLES),
        h('style', null, LAUNCH_STYLES),
        h('div', { className: 'ndv-pinned' },
          h('div', { className: 'lch-head' },
            h('div', { className: 'ndv-head' },
              h('h2', { className: 'ndv-head-title' }, stack === 'backend' ? t('backendTitle') : t('launchTitle')),
              h('p', { className: 'ndv-head-sub' }, stack === 'backend' ? t('backendSubtitle') : t('launchSubtitle')),
            ),
            h('div', { className: 'lch-headactions' },
              form === null && batchOpen === false
                ? h('button', {
                  type: 'button',
                  className: 'ndv-button',
                  disabled: locked || entries.length === 0,
                  onClick: () => { openBatch() },
                }, t('launchBatch'))
                : null,
              h('button', {
                type: 'button',
                className: 'ndv-button lch-refresh-all',
                // The hint explains what a refresh does; while one runs it says what is
                // being re-read, which is the more useful of the two at that moment.
                title: refreshAll ? t('refreshAllBusy') : t('refreshAllHint'),
                disabled: refreshAll || busy || data.status !== 'ready',
                'aria-busy': refreshAll ? 'true' : undefined,
                onClick: () => { refreshEverything().catch(() => {}) },
              },
                refreshAll ? h('span', { key: 'spin', className: 'ndv-spin', 'aria-hidden': 'true' }) : null,
                h('span', { key: 'label' }, refreshAll ? t('refreshing') : t('refresh'))),
              form === null
                ? h('button', {
                  type: 'button',
                  className: 'ndv-button lch-primary',
                  disabled: locked,
                  onClick: () => { setForm(emptyForm(data.payload)) },
                }, t('launchAdd'))
                : null,
            ),
          ),
          notice === null ? null : h('p', {
            className: 'ndv-notice',
            'data-kind': notice.kind,
            role: notice.kind === 'error' ? 'alert' : 'status',
          }, notice.text),
        ),
        h('div', { className: 'ndv-scroll', 'data-busy': refreshAll ? 'true' : undefined }, scroller()),
        form === null ? null : formModal(),
        batchOpen ? batchModal() : null,
        removeTarget === null ? null : removeModal(),
        logTarget === null ? null : logModal(),
        menu === null ? null : moreMenu(),
        h('p', { className: 'ndv-footnote lch-footer' },
          h('span', null, t('launchNote')),
          typeof data.payload?.dataFile === 'string' && data.payload.dataFile !== ''
            ? h('span', { className: 'lch-footer-path', title: data.payload.dataFile },
              fill(t('launchStored'), { path: data.payload.dataFile }))
            : null,
        ),
      )
    }

    /**
     * The systems this workbench hosts. Adding one is one entry: a stable id, its
     * copy keys, and the component that renders the pane (head included).
     */
    /** A launcher pane for one stack: the same engine, filtered to that stack. */
    const FrontendSystem = (props) => h(LauncherSystem, { ...props, stack: 'frontend' })
    const BackendSystem = (props) => h(LauncherSystem, { ...props, stack: 'backend' })

    const SYSTEMS = [
      { id: 'node', titleKey: 'title', component: NodeSystem },
      { id: 'frontend', titleKey: 'launchTitle', component: FrontendSystem },
      { id: 'backend', titleKey: 'backendTitle', component: BackendSystem },
    ]

    /**
     * The Workbench page: every system beside the one selected.
     * @param {object} props the main panel's props, carrying the locale translator.
     * @returns {object} the page element.
     */
    function WorkbenchPanel(props) {
      const t = translator(props)
      const [activeId, setActiveId] = React.useState(SYSTEMS[0].id)
      const active = SYSTEMS.find((system) => system.id === activeId) ?? SYSTEMS[0]
      const System = active.component
      return h('div', { className: 'wbm' },
        h('style', null, WBM_STYLES),
        h('header', { className: 'wbm-head' },
          h('h1', { className: 'wbm-title' }, t('workbench')),
          h('p', { className: 'wbm-sub' }, t('workbenchSubtitle')),
        ),
        h('div', { className: 'wbm-body' },
          h('nav', { className: 'wbm-nav', 'aria-label': t('workbench') },
            h('p', { className: 'wbm-nav-head' }, t('systems')),
            SYSTEMS.map((system) => h('button', {
              key: system.id,
              type: 'button',
              className: 'wbm-nav-item',
              'data-active': system.id === active.id ? 'true' : 'false',
              'aria-current': system.id === active.id ? 'true' : undefined,
              onClick: () => { setActiveId(system.id) },
            }, t(system.titleKey))),
          ),
          h('section', { className: 'wbm-pane', 'aria-label': t(active.titleKey) },
            h(System, props),
          ),
        ),
      )
    }

    /**
     * The sidebar's Workbench glyph: the four systems of a launcher grid.
     * @param {object} props the sidebar icon share (`size`, `active`).
     * @returns {object} the glyph element.
     */
    function WorkbenchIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        viewBox: '0 0 36 36',
        width: size,
        height: size,
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      h('g', { fill: 'currentColor' },
        h('rect', { x: 6.5, y: 6.5, width: 9.5, height: 9.5, rx: 2.4 }),
        h('rect', { x: 20, y: 6.5, width: 9.5, height: 9.5, rx: 2.4 }),
        h('rect', { x: 6.5, y: 20, width: 9.5, height: 9.5, rx: 2.4 }),
        h('rect', { x: 20, y: 20, width: 9.5, height: 9.5, rx: 2.4 }),
      ))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginCtx = ctx
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'slim-workbench: dictionaries')
        const t = ctx.locale.bind(NS)
        // The sidebar owns the button and its label; this entry supplies the glyph.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: WORKBENCH_ID,
          order: 20,
          label: () => t('workbench'),
          locale: NS,
        }, WorkbenchIcon))
        // A non-conversation main panel: no Session binding, so it works before any Session exists.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: WORKBENCH_ID,
          locale: NS,
          inject: () => ({ t }),
        }, WorkbenchPanel))
      },
    }
  },
})
