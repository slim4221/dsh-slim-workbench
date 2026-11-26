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
model can look a version up or switch it for you.

**Frontend projects** does not guess at a command. You pick the folder with the host's native folder
dialog; it reads that folder once and offers every `scripts` entry it found. You then choose the
package manager and the script — neither is preselected, and a lockfile is shown beside the control as
a hint, never applied on your behalf. Optional: pin a Node version for this entry only, a port, and a
priority. Start runs the command in that folder; the row reports *starting*, then *ready* when the
port answers, and then shows the LAN address (the local address is implied by the machine you are
on). **Batch start** runs the selected entries one after another, waiting for each one's port before
starting the next, which is what a project depending on an SSO service needs.

**Backend projects** covers Spring Boot: choose Maven or Gradle, choose a Spring profile from the
`application-*.yaml` files the project ships, and the port is read from `server.port`. The profile
travels as the `SPRING_PROFILES_ACTIVE` environment variable, so it works for `spring-boot:run`,
`bootRun`, a fat jar, and a hand-written command alike. A backend build takes longer than a dev
server, so it gets a five-minute readiness budget instead of three.

## What it never does

The project directory is read-only for this plugin. It reads `package.json`, lockfiles, `.nvmrc`,
`pom.xml` or `build.gradle`, `application-*.yaml`, and `git status`. It never writes, creates,
renames, or deletes anything inside a project, never installs dependencies, never edits a lockfile,
never runs a mutating git command, and never kills a process it did not start. Its only write target
is `$DSH_HOME/slim-workbench/launchers.json`.

## Data and moving machines

An entry stores the absolute project path, the command conditions you chose, a port, a priority,
whether it takes part in a batch start, and a small inspection snapshot (branch, port, warnings).
Nothing else — no sources, no secrets, no environment.

Because the data file lives outside the package, **a fresh install starts with empty lists**. Copying
`launchers.json` to `~/.dsh/slim-workbench/` on another machine brings the entries over; their
absolute paths then have to be pointed at that machine's checkout, and pinned Node versions must
exist there (a machine without nvm says so instead of pretending a version is missing).

Reading a project happens when an entry is saved or when you press **Refresh** on its row, never while
the panel is open. Opening the panel reads one JSON file, which is why it opens without a pause and
without spawning `git`.

## Limits worth knowing

- Machine-wide Node switching needs nvm-windows; on macOS and Linux the pane lists versions and
  explains where to switch instead.
- The backend pane starts development goals (`spring-boot:run`, `bootRun`). It does not package a
  jar first, and it does not manage Java versions.
- A failed start shows the last line of output, with terminal colour codes stripped. There is no full
  log view.
- The available-release page reads `https://nodejs.org/dist/index.json` and caches it for ten
  minutes; installing downloads through nvm. Nothing else leaves the machine.
