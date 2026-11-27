# Slim workbench

A persistent panel in the DeepSeek Harness sidebar that holds the local-development systems on one
machine. It exists to remove the small, repeated costs of starting work: opening a terminal, finding
a folder, remembering which Node version an old project needs, or which Spring profile it runs on.

One system is one entry in the panel's left menu and one self-contained pane, so adding a system
leaves the shell alone.

## What each system does

**Node management** lists the versions nvm-windows manages, shows which one the machine is on, and
switches, installs, or removes a version. The machine's symlink is the only thing it changes, and the
version in use can be neither switched away from nor removed. On macOS and Linux the same pane lists
the versions found in nvm, fnm, volta, and asdf and says plainly that a version belongs to a shell
there, so no machine-wide switch exists. This system also exposes the `node_version` tool, so the
model can look a version up or switch it for you. **Refresh** re-reads only what is installed on this
machine and which version is linked; it does not re-fetch the release index. While that read is in
flight the current rows stay on screen, dimmed, with a line above saying what is being refreshed. The
status strip also shows **Updated**, the moment that list was last read — the clock alone, with the
full date and time in its tooltip.

**Frontend projects** does not guess at a command. You pick the folder with the host's native folder
dialog; it reads that folder once and offers every `scripts` entry it found. You then choose the
package manager and the script — neither is preselected, and a lockfile is shown beside the control as
a hint, never applied on your behalf. Optional: pin a Node version for this entry only, and a port.
Start runs the command in that folder; the row reports *starting*, then *ready* when the
port answers, and then shows the LAN address (the local address is implied by the machine you are
on). A row shows two actions — start/stop and edit — and keeps output, refresh, and delete under
**More**. **Output** opens the last 200 lines that run printed, read from the in-memory buffer and
refreshed while the dialog is open. **Batch start** starts the selected entries at the same time by
default; a second mode starts them one by one, each after the previous one answers on its port, in
list order — for projects that must come up in order (an SSO service: add it first). Its readiness
budget follows the stack: three minutes for a dev server, five for a backend.

**Backend projects** covers Spring Boot: choose Maven or Gradle, choose a Spring profile from the
`application-*.yaml` files the project ships, and the port is read from `server.port`. The profile
travels as the `SPRING_PROFILES_ACTIVE` environment variable, so it works for `spring-boot:run`,
`bootRun`, a fat jar, and a hand-written command alike. A build tool owned by the project wins when it
is complete (`mvnw` plus its wrapper properties, or `gradlew`); otherwise the global `mvn` / `gradle`
is used, because a half-copied wrapper fails before it reaches the build. A backend build takes longer
than a dev server, so it gets a five-minute readiness budget instead of three.

## What the model can see

Two tools, and the line between them is deliberate:

- `node_version` reads the versions this machine has and can switch, install, or remove one. Those
  change the machine for everything running on it, so the tool says plainly that a write only follows
  a request the user made by name.
- `workbench_status` is read-only: the configured entries, which of them run, their port and LAN URL,
  branch, the warnings the panel shows, and the last lines of each run's output. It answers "why did
  my dev server stop" without being able to start or stop anything — starting a long-lived process
  stays a user action.

## What it never does

The project directory is read-only for this plugin. It reads `package.json`, lockfiles, `.nvmrc`,
`pom.xml` or `build.gradle`, `application-*.yaml`, and two git commands —
`git --no-optional-locks rev-parse --abbrev-ref HEAD` and `git --no-optional-locks status
--porcelain`. The flag matters: without it, `git status` refreshes its cached stat data and rewrites
`.git/index`, which is a file inside the project. It never writes, creates, renames, or deletes
anything inside a project, never installs dependencies, never edits a lockfile or any project
configuration, never runs a mutating git command, and never kills a process it did not start. It writes
two files, both under `$DSH_HOME/slim-workbench/`: `launchers.json` (your entries) and `node-cache.json`
(the last Node read, kept only so a failed live read still has something to show — delete it any time).

## Data and moving machines

An entry stores the absolute project path, the command conditions you chose, a port, a priority,
whether it takes part in a batch start, and a small inspection snapshot (branch, port, warnings).
The priority is editable and saved like any other field, but **nothing consumes it yet**: the start
order is the list order, and the field's own hint says so. When an ordering rule arrives, the values
are already there.
Nothing else — no sources, no secrets, no environment.

Because the data file lives outside the package, **a fresh install starts with empty lists**. Copying
`launchers.json` to `~/.dsh/slim-workbench/` on another machine brings the entries over; their
absolute paths then have to be pointed at that machine's checkout, and pinned Node versions must
exist there (a machine without nvm says so instead of pretending a version is missing).

Reading a project happens when an entry is saved, when its editor opens (the dialog re-reads the
script list and the profiles, and shows a loading row until the read lands), or from **More →
refresh**. It never happens while the panel is open: opening the panel reads one JSON file, which is
why it opens without a pause and without spawning `git`.

## Limits worth knowing

- Machine-wide Node switching needs nvm-windows; on macOS and Linux the pane lists versions and
  explains where to switch instead.
- The backend pane starts development goals (`spring-boot:run`, `bootRun`). It does not package a
  jar first, and it does not manage Java versions.
- A failed start shows the last line of output in the row, and **Output** shows the run's last 200
  lines from the in-memory buffer, with terminal colour codes stripped. There is no streaming log and
  nothing is written to disk; a run that started before this plugin was loaded is not visible at all.
- The available-release page reads `https://nodejs.org/dist/index.json` and caches it for ten
  minutes; installing downloads through nvm. Nothing else leaves the machine.
