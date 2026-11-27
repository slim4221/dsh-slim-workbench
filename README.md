# Slim 工作台 · Slim workbench

一个常驻 DeepSeek Harness 侧边栏的本地开发工作台：**Node 管理**、**前端项目管理**、**后端项目管理**。
项目的目录与命令由你自己选，插件只记住这些选择条件 —— **项目目录对本插件只读**。

A persistent local-development workbench panel for DeepSeek Harness: Node version management, a
frontend launcher, and a Spring Boot launcher. It remembers the choices you make (folder, command,
version, profile) and **never writes into a project directory**.

---

## 三个系统 · Three systems

| 系统 | 做什么 |
| --- | --- |
| **Node 管理** | 列出 nvm-windows 管理的版本，切换 / 安装 / 卸载。**卸载有二次确认**（会显示将被删除的目录）；当前使用的版本点「卸载」会直接说明"先切换"，而不是给一个点了没反应的灰按钮。macOS 与 Linux 上列出 nvm·fnm·volta·asdf 检测到的版本（不提供全机器切换）。同时给智能体一个 `node_version` 工具。 |
| **前端项目管理** | 选择文件夹 → 从 `package.json` 的全部 `scripts` 里选一条 + 选包管理器（**都不预选**）→ 可选锁定 Node 版本、填端口 →「保存并启动」。端口就绪后给出局域网链接。每行两个按钮（启动/停止、编辑），输出与删除收进「更多」。表格用固定列宽，**项目与操作两列冻结**、中间横向滚动，「项目地址」单列。顶部的「刷新」一次重读**所有**项目（先查目录还在不在），刷新期间「批量启动」「添加」一起锁住、按钮显示「刷新中…」。**批量启动默认同时启动**；也可以切成「逐个启动，等上一条端口就绪」（按列表顺序）——依赖别的服务的项目用后者。就绪预算跟着栈走：前端 3 分钟、后端 5 分钟。 |
| **后端项目管理** | Spring Boot：选 Maven / Gradle + Profile（从 `application-*.yaml` 读出），端口从 `server.port` 预填，就绪预算 5 分钟（前端 3 分钟）。Profile 通过 `SPRING_PROFILES_ACTIVE` 传给子进程；项目自带完整的 `mvnw` / `gradlew` 时优先用它，否则用全局 `mvn` / `gradle`。 |

左侧「系统」里的每一项都是一个自带整块内容区的模块，加系统是加法，外壳不变。

两个工具给智能体：`node_version`（查/切/装/卸 Node，写操作只在你点名时用）与 `workbench_status`（**只读**：列出条目、运行状态、端口、分支、警告与每个运行的最后几行输出 —— 能回答「我的 dev server 为什么挂了」，但绝不替你启动或停止）。

## 安装 · Install

本机（从 GitHub 安装，pin 到 commit 最稳）：

```bash
dsh plugin --profile desktop add "git+https://github.com/slim4221/dsh-slim-workbench.git"
```

安装器接受任意 Git 主机（`git+https://…`、`git@host:owner/repo`、`https://host/owner/repo(.git)`），
也接受本地目录或 `.tgz`。包内**没有依赖、没有构建步骤、没有 install 脚本**，安装就是一次只读拷贝。

开发时更推荐用 profile 的 `link:` 指向工作区目录，改完代码重启插件条目即可生效。

## 只读承诺 · Read-only guarantee

- 只读 `package.json`、锁文件、`.nvmrc`、`pom.xml` / `build.gradle`、`application-*.yaml`、`git status`
- **不写、不新建、不改名、不删除**项目里的任何文件；不做 `install`，不改锁文件，不动项目配置
- git 只跑两条只读命令：`git --no-optional-locks rev-parse --abbrev-ref HEAD` 与 `git --no-optional-locks status --porcelain`。
  `--no-optional-locks` 不是装饰：没有它，`git status` 在缓存过期时会**改写 `.git/index`**（那是项目里的文件），加上就一条字节都不动
- 只停止它自己启动的进程树；**Windows 上每个运行都在一个 job object 里**（`KILL_ON_JOB_CLOSE`），所以自己 detach 出去的孙进程也跑不掉，宿主崩了整棵树跟着死。job 用不上时退回 `taskkill /T`，POSIX 用进程组信号
- 唯一的写入目标：`$DSH_HOME/slim-workbench/launchers.json`。一个文件三段：`entries` 是你的条目，`nodeCache` 是最后一次 Node 读取的快照（只为实时读取失败时还能显示上次结果），`runs` 是正在跑的进程记录（重启后用来认领它们）

## 数据 · Data

条目保存在 `$DSH_HOME/slim-workbench/launchers.json`（Windows 为 `C:\Users\<你>\.dsh\slim-workbench\launchers.json`）。
同一个文件里的 `nodeCache` 段保存 Node 管理最后一次成功读取的结果，所以实时读取失败时面板还能显示上次的列表（并标出那是哪一刻读的）。
`runs` 段记下每个运行中条目的 pid、启动时间、端口与命令行：宿主被强杀后重启，面板按 **pid 还活着 + 命令行对得上** 两个条件认领它，
显示为运行中并带「接管」角标，一次「停止」照样杀掉整棵树；pid 已被别的进程复用时不会被误认。

- 里面只有：项目**绝对路径**、你选的命令条件、端口、是否参与批量、警告快照 —— 没有项目源码、没有密钥
- 条目里的 `priority` **能填也能存**（只在新增/编辑弹窗里，列表不显示），但**目前没有消费方**：启动顺序不看它（逐个启动按列表顺序，同时启动没有顺序）。以后要接排序规则，已有的值直接可用
- **同一个项目目录可以添加多次**：monorepo 里不同子项目的启动脚本不同，就各自一条；脚本、端口、Node 版本都是按条目记的
- 列表上方的「刷新」先检查每个项目目录还在不在，不在的会直接报出名字与路径
- **新机器装完插件列表是空的**，数据文件不随包分发；想带走就手动拷这一个 JSON
- 卸载插件**不会**删除这个文件

每条条目带一个「快照」：分支、端口、警告。读取项目只发生在**保存条目**、**打开编辑弹窗**（弹窗里会重新读一次脚本与 profile，列表带 loading）或**列表上方的「刷新」**（一次重读全部条目）时；打开面板只读一个
JSON（实测 3 ms），不会遍历项目目录，也不会反复调用 `git`。

## 平台 · Platforms

| | Windows | macOS / Linux |
| --- | --- | --- |
| 面板、表格、编辑、批量启动 | ✅ | ✅ |
| 启动 / 停止（整棵进程树） | job object（`KILL_ON_JOB_CLOSE`），失败退回 `taskkill /PID … /T /F` | 子进程自成进程组，`SIGTERM` → `SIGKILL` |
| 宿主崩溃后 | 进程随 job 一起死；万一没死，重启后按 pid + 命令行认领，可停 | 只记录不认领（无 job object），重启后按 pid + 命令行认领 |
| 按项目锁定 Node | nvm-windows 目录 | nvm / fnm / volta / asdf 的 `bin` 进该子进程 `PATH` |
| 全机器切换 Node | ✅ `nvm use` | ❌ 版本属于 shell（`nvm alias default` / `fnm default`） |
| 后端启动 | 需 JDK + Maven/Gradle | 同左 |

机器上**没有 nvm** 时，前端项目页会明确提示「锁定的版本不生效，会用系统默认 Node」，而不是误报
「版本未安装」。

## 边界 · Limits

- Node 管理在非 Windows 上不做全机器切换（macOS 的 nvm 没有可改写的符号链接）
- 后端只支持 `spring-boot:run` / `bootRun` 这类开发目标，不做「先打包再跑 jar」
- 不管理 Java 版本（只显示 `java.version` / `JAVA_HOME`）
- 启动失败时，行下方显示**最后一行输出**；点「输出」能看这次运行最后 200 行（从内存里 64 KB 的环形缓冲读，已剥离 ANSI 颜色码）。没有实时流式日志，也不落盘
- 日志只属于**本进程**：插件重启前的输出看不到，重启前的进程也不会被接管
- 「可安装」页读取 `https://nodejs.org/dist/index.json`（缓存 10 分钟），安装时经 nvm 下载（每版约 30 MB）

## 开发 · Development

```bash
npm run check   # 仓库自检：清单、patch、locale、字典对照、语法、导入接线、死 CSS、测试是否被点名
npm test        # node --test：行为测试 + 渲染测试（node 18+）
npm run visual  # 真浏览器里渲染面板并量列宽/冻结列（需要 Chrome，dev-only）
```

自检覆盖的是「装得上、点得开」：BOM、行尾、包名与 patch 是否一致、`meta.detail` 是否指向真实文件、
客户端模块 id 是否等于包名、字典两面是否对齐（重复键、缺键、`t('…')` 未定义）、CSS 里声明的类是否有地方在用、
每个 `test/` 文件是否被
`npm test` 点名。测试覆盖的是「算得对、画得出、接得上」：条目迁移、端口与版本归一化、Spring 配置解析、
`validateEntry` 的每条拒绝理由、Maven/Gradle 包装器选择；用一套几十行的假 React（hooks 有状态、effect
不执行）把三个面板真渲染一遍 —— 表格行、操作按钮、输出弹窗都是真渲染出来的；再把 Host 半挂到假上下文上
跑一遍 —— 15 条路由与两个工具都注册了、非本机 Host 被 403、非 JSON 与超长 body 被挡住、存一条能取回来。
还有两条只能靠真进程验的：**job object 杀掉已 detach 的孙进程**、**崩溃后按 pid + 命令行认领运行**（含"pid 被别的程序占用时不认领"）。
`npm run visual` 补的是只能靠真浏览器验的那一半：把 `client.js` 原样在 Chrome 里渲染，量 8 列的实际宽度、行高、
按钮有没有换行、横向滚动 260px 之后项目列与操作列是否仍然贴边 —— 窄窗口和宽窗口各跑一次。

CI 在 **Windows 与 Linux** 两个 runner 上跑同一套（零依赖，所以没有安装步骤）。

改完 `client.js` / `index.js` 后重启插件条目（Plugin Manager 里关掉再打开）即可，页面无需重载；
仅改动 CSS 字符串时刷新页面即可。新加一个 `test/*.test.mjs` 记得同时加进 `package.json` 的 `test`
脚本，自检会提醒你。

## 许可 · License

MIT —— 见 [LICENSE](LICENSE)。
