# Ttokttok Pet

A small animated companion that floats above your windows and keeps track of what's waiting for
you: your Claude desktop **Code** sessions, **Codex** threads, chats on claude.ai, ChatGPT and
Gemini, SNU eTL deadlines, your presentation turns in a Slack canvas, and today's schedule in
TodoMate. It works like the Pets feature in the ChatGPT/Codex desktop app and
uses the same pet format, so ChatGPT/Codex pets work here too. It can also sit as a sidebar that
lists every session by machine and folder ([Folder mode](#folder-mode)). From your phone, it can
show the same list and notify you when a chat finishes ([Phone](#phone)).

![Clay, the default pet](tools/clay-preview.png)

## Install

The pet is built and tested on Windows. There are two ways to get it:

- **Download it.** This needs no Node.js or npm. On the
  [releases page](https://github.com/hyukjunlim/ttokttok-pet/releases/latest), take
  `Ttokttok-Pet-Setup-<version>.exe` or `Ttokttok-Pet-<version>-win.zip`. The installer puts the
  pet in your user folder (no admin rights needed) and starts it; the zip you unzip anywhere and
  start with `Ttokttok Pet.exe`. The app isn't code-signed, so Windows SmartScreen may warn the
  first time: choose *More info* → *Run anyway*.
- **Run it from the source**, as below. That's also the copy that updates itself with one click,
  and the one to hack on.

Both need something to watch:

- **The Claude desktop app** (with Code sessions), **Codex** ([Codex](#codex)), or both. That's
  what the pet watches. With only one of them, the tray menu leaves out the other's items, and
  clicking the pet opens the one you have. Claude Code and Codex in VS Code or in a terminal
  count too, here, in WSL and over SSH ([How it knows](#how-it-knows-what-claude-is-doing)).

To run it from the source you also need **Git** and **Node.js 22.12 or newer** (the current LTS is
fine; `npm install` downloads Electron itself), and optionally Python, only to rebuild the
built-in pet.

```bash
git clone https://github.com/hyukjunlim/ttokttok-pet.git
cd ttokttok-pet
npm install
npm start
```

On its first start, the pet opens **Getting started**, which sets it up a step at a time: the mode
(a floating pet or a sidebar), the small mod for Claude Code that Claude's weekly limit comes from
([Live Claude usage](#live-claude-usage)), SNU eTL, TodoMate ([TodoMate schedule](#todomate-schedule)),
Slack ([Slack presentation reminders](#slack-presentation-reminders)), the browser extension for
chats on claude.ai, ChatGPT and Gemini ([Web chats](#web-chats-claudeai-chatgpt-gemini)), and the phone
([Phone](#phone)). Each step can be skipped. Then you try the pet out on practice items (a bubble next to the floating pet, or two
sessions at the top of the sidebar): click, mark done, hide and show with `Ctrl+Alt+P`, step
through with `Ctrl+Tab`, right-click. Tray menu → *Getting started…* (or `--getting-started`)
opens it again.

To update, use **Check for updates…** in the tray menu ([Updating](#updating)).

> **Installed it before the tray had *Check for updates…*?** That version can't update itself, so
> do it by hand once: quit the pet from the tray menu, run `git pull` and then `npm install` in
> its folder, and start it again (`npm start`, or double-click `Ttokttok Pet.lnk`). Your settings
> and pets are kept. If `git pull` complains about files you changed, undo those changes first.
> After this, updates are one click.

## Run it

```bash
npm start          # the pet appears in the bottom-right corner, plus a tray icon
npm run demo       # cycles through every status with fake sessions
npm test           # unit tests for the status logic
npm run shortcut   # creates "Ttokttok Pet.lnk" in this folder (Windows)
node src/sessions.js   # print what the pet currently sees, then exit
npm run dist       # builds the installer and the zip into dist/ (Windows)
```

From its first run on, the pet starts at login; untick *Start at login* in the tray menu to stop
that. To start it yourself without a console window, double-click **Ttokttok Pet.lnk** in this
folder. The flags `--start-at-login` and `--no-start-at-login` set the same option from the
command line. `Ctrl+Alt+P` shows or hides the pet. Right-click the pet
(or click the tray icon) for the menu, which also has *Restart Ttokttok Pet* (after you edit its
code, say). Its settings are in two submenus: *Appearance* (pet, size, theme, weekly limits,
animation) and *Sources* (Codex, Live Claude usage, Web chats, eTL, Slack 발표, 투두메이트 일정).

The pet logs what goes wrong (a crash, a link that wouldn't open) to `ttokttok-pet.log` in
`%APPDATA%\ttokttok-pet\logs` (`~/Library/Logs/ttokttok-pet` on macOS). Past 1 MB it starts over and
keeps the previous log as `ttokttok-pet.old.log`.

## Updating

**A downloaded copy** (installer or zip) can't update itself. Tray menu → **Check for updates…**
asks GitHub whether a newer release exists, shows what changed, and opens the download page. Quit
the pet, run the new installer (or replace the unzipped folder), and that's it: settings, pets and
the log live outside the app's folder, so nothing is lost. A copy from the source and a downloaded
one share those files too, so you can switch between the two.

**A copy from the source** updates itself. Tray menu → **Check for updates…** looks at the latest `main` on GitHub. If there's something new,
a dialog lists what changed; **Update and restart** closes the pet, updates the files, runs
`npm install` if `package.json` or the lockfile changed, and starts the pet again. A dialog then
says it worked, or why it didn't (the old version is kept, and the log has the details). It only
checks when you ask.

- **Your things are kept.** Settings, your pets and the log live outside this folder
  (`%APPDATA%\ttokttok-pet` and `~/.ttokttok-pet/pets`), so an update never touches them. Keep a
  customized pet in `~/.ttokttok-pet/pets`, not in this folder's `pets/`.
- **It needs git** (the pet is a clone of this repo) and Node on your PATH, which the source
  install already asked for. It says why when it can't update: the folder isn't a git clone, isn't on
  `main`, has commits that aren't on GitHub's `main`, or has edited files that an update would
  overwrite. A lockfile that npm rewrote doesn't count.
- **Installed before this existed?** That version has no such menu item. Update it by hand once,
  as described under [Install](#install).

### Upgrading from an older install

An install from before 0.5 kept its things under the name `claude-pet`. The first start moves them
over: settings and the eTL token (`%APPDATA%\claude-pet`), your pets and the live-usage mod
(`~/.claude-pet`, also in WSL and on SSH hosts), Start at login and the web chats host. Two things
are yours to do:

- **The browser extension:** on the extensions page, click its reload button. If you moved the
  pet's folder, remove it and load it again from there.
- **An installed copy:** the installer puts the pet beside the old one, not over it. Uninstall the
  old one ("Claude Pet") in Windows Settings → Apps.

## Building the installer

`npm run dist` builds `Ttokttok-Pet-Setup-<version>.exe` (a per-user installer) and
`Ttokttok-Pet-<version>-win.zip` (unzip and run) into `dist/`, with
[electron-builder](https://www.electron.build/); the settings are under `build` in
[package.json](package.json). The first build downloads a few tools and takes a while. The app is
packed as plain files, not an `app.asar`: the pet copies its Claude Code mod and the eTL workspace
template out of its folder, and serves its pet sheets over `file://`, which an archive would get
in the way of. Nothing is signed, hence the SmartScreen notice on first start. The version in
`package.json` is the one the installer carries and the one **Check for updates…** compares with
the releases on GitHub, so bump it before building a release.

**Releasing** is a tag push. Set `version` in [package.json](package.json), commit, tag that
commit `v<version>` (`git tag v0.2.0`), and push the tag (`git push origin v0.2.0`).
[release.yml](.github/workflows/release.yml) then builds the installer and the zip on GitHub,
runs the tests first, and publishes a release for the tag with both files attached and notes made
from the commits since the last one; it refuses a tag that doesn't match `version`. To write the
notes yourself, create the release for the tag by hand before pushing it, or edit it afterwards.
The pet's update dialog lists the notes' bullet points (lines starting with `- ` or `* `).

## What the pet tells you

| Pet animation | Bubble         | Meaning |
| ------------- | -------------- | ------- |
| waiting       | **Needs you**  | Claude asked a question, has a plan waiting for approval, wants permission to use a tool, ended its turn on a question in the app's next-step box, or ended it waiting on a decision from you (the app's yellow marker). Opening the session doesn't clear it: it stays until you answer, or click its × |
| failed        | **Error**      | The turn ended with an API error |
| review        | **Ready**      | A turn finished. It stays until you mark it done or send the session a message; opening it doesn't count |
| running       | **Running**    | Claude is working |
| idle          | **Background** | Claude isn't working, but a command, agent or monitor it sent to the background is still going |
| idle          | none           | Nothing to report |

Every active session gets its own bubble, most urgent first: Needs you, then Error, then Ready,
then Running (the same order as ChatGPT's pet), and Background last. The pet's animation follows
the top one. There's no limit: the stack grows as sessions come in, and scrolls (mouse wheel over
a bubble) once it reaches the edge of the screen. The **×** on a bubble marks it done.

A bubble shows the status and the session's title, and under them the app, the project and how
long it has been in that state, e.g. "Claude · tokenizer · 5m". The project is the session's folder name; it's
left out for sessions started without a folder. Every bubble is the same width (`--pill-width` in
[src/renderer/pet.css](src/renderer/pet.css)), and a long title ends in "…".

- **Click the pet** to bring the Claude window to the front, the way ChatGPT's pet opens its app
  (or the Codex window, if you don't have Claude).
- **Click a bubble** to open that exact session in Claude, SSH sessions included.

How the clicks open Claude:
- **Opening a session** uses `claude://resume?session=<id>`, where `<id>` is the desktop
  session's ID without the `local_` prefix. For a session the app already has, that link simply
  opens it. The pet only builds the link for sessions that are still in the desktop index, so it
  never makes Claude import a copy.
- **Why not `claude://code/continue`:** that's the app's own session link, but it sits behind a
  server-side flag and silently does nothing on some accounts.
- **Opening the window** uses `claude://hotkey`, which does nothing except make the running app
  restore and focus its window. The pet's own window never takes focus, so on Windows it briefly
  focuses itself right after your click. That lets Windows hand focus on to Claude. For Codex,
  `codex://launch` does the same.

Other things it does:
- **Bubbles stay on the pet's monitor.** Near an edge the pet can go right up to it, while
  the bubbles slide inward and keep a 12 px margin.
- **Hover:** the pet jumps.
- **Drag:** it runs in the direction you move it.
- **Throw:** it slides and bounces off the screen edges.
- **Stays still while you work:** a status's animation plays twice and then comes to rest on
  its first frame. With nothing going on, the pet idles slowly.
- **Reduced motion:** the pet animates even when the Windows *Animation effects* setting is off.
  Untick *Animate even with Windows animation effects off* in tray menu → *Appearance* to get
  still frames then instead.

## Folder mode

Tray menu → *Mode* → *Folder sidebar* (or `--mode=folder` on the command line) turns the pet into
a sidebar. It docks to an edge of a monitor as a Windows app bar (the left one, unless you pick
another), so other windows make room for it, and lists every Claude Code session and Codex
thread, quiet ones too, by machine and folder. The pet and the weekly limits sit at its foot, with
eTL's, Slack's and TodoMate's notices just above them when those are on. Each time it docks, the
Claude and Codex windows are
maximized beside it, so the conversation you open fills the rest of the screen.

- **Machines and folders:** *Local*, *WSL* and each SSH host, each with its folders. The two apps'
  names for one server meet under one heading, and a session started in a parent folder stays at
  the parent. Web chats come first, under *Chat*, with a dot in each site's color, once you've
  turned them on and loaded the browser extension ([Web chats](#web-chats-claudeai-chatgpt-gemini)).
  Claude Code sessions and Codex chats run in VS Code or a terminal have a hollow dot in their
  app's color.
- **Order:** the sessions in a folder are newest first, and a fork sits right under the session it
  came from, marked └: a Claude Code session you forked, a side chat or a btw question, or a Codex
  thread you forked. A session and its forks move together, placed by the newest of them. A fork
  whose original is in another folder, archived or hidden stays on its own, and a search lists its
  matches flat. Machines and folders keep the order they first showed in, so a folder doesn't
  jump when a session in it gets busy. Drag a machine's
  heading or a folder's row to move it among its neighbors (Escape cancels); a folder that turns
  up later goes on top.
- **Status:** each session shows what its bubble would (*Needs you*, *Error*, *Ready*, *Running*,
  *Background*), or when it was last worked on. A folded folder shows a dot when something in it
  needs you or is working.
- **Clicks and keys:** click a session to open it in its app, and a folder or a machine to fold it.
  The button beside the search box folds every folder but those on the way to the session you
  opened last, or opens them all. **Ctrl+Tab** and **Ctrl+Shift+Tab** step through the list while
  Claude, Codex or the sidebar is in front.
- **New chat:** a folder's **+** (or right-click it) → *New Claude Code session here* or *New Codex
  chat here*. The app opens its new-chat page in that folder (`claude://code/new?folder=…`, or
  `ssh_host`/`ssh_port`/`ssh_folder` on an SSH host; `codex://threads/new?path=…`, or
  `?projectId=…` for a WSL folder that is one of Codex's projects), and the chat shows in the
  sidebar once you send its first message. Claude can on this PC and on an SSH host it has
  connected to before; Codex can on this PC, adding the folder to its projects, and in WSL folders
  that are already Codex projects. Codex's link can't name an SSH host, and Claude's can't name WSL.
- **Mark as done, Mark as Ready:** opening a session leaves its *Ready*, *Error* or *Needs you*.
  Right-click it → *Mark as done* settles it, as a bubble's × does. *Mark as Ready* undoes that, so a
  question still in the next-step box is *Needs you* again; on a quiet session it puts it in Ready to
  come back to, until you mark it done or send it a message. *Mark all as done* settles every one at
  once: right-click a folder or a machine for what's in it, or anywhere else in the sidebar for all
  of them.
- **Hide:** right-click a session → *Hide from the sidebar*, or a folder or a machine to hide
  everything in it (its menu also has *Collapse* or *Expand*). Only the sidebar leaves it out, and
  it stays out whatever happens in it, until you bring it back from the tray menu's *Hidden from
  the sidebar*.
- **Delete:** right-click a chat run in VS Code or a terminal → *Delete…*, and confirm. A Claude
  Code session's transcript and its folder go: to the Recycle Bin on this PC; for good in WSL and
  on an SSH host (one SSH command removes them). A Codex chat is archived by Codex itself (its
  app-server's `thread/archive`), so you can bring it back from Codex's archived chats. Not while
  the chat is working, or in the two minutes after it was last written, when it may still be open.
- **Where:** tray menu → *Appearance* → *Sidebar position* picks the monitor (named by where it
  sits, with its size, the main one marked) and its left or right edge. The sidebar stays there; if
  that monitor is unplugged, it goes to the one the floating pet was on.
- **Width and text size:** drag the sidebar's inner edge (the one facing the screen); double-click
  it for the default width. **Ctrl+=** and **Ctrl+-** size the text, **Ctrl+0** resets it.
- **Look:** Inter where it's installed, otherwise Segoe UI. The page, the text and the selected row
  take the colors of the Claude app's sidebar. Tray menu → *Appearance* → *Theme* picks light, dark
  or the Windows app mode for all of the pet's windows.
- **Saved:** the order, folding, text size, hidden sessions and marks are in
  `%APPDATA%\ttokttok-pet\settings.json`.

## How it knows what Claude is doing

The pet only reads files. It changes no Claude settings and needs no hooks.

- **Session index:** `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_*.json`. The
  desktop app writes one file per Code session, with its title, when you last looked at it, and an
  end-of-turn summary (`postTurnSummary.status_category` such as `completed`, or `blocked` and
  `need_input` when Claude ended the turn waiting on you).
- **Transcripts:** `~/.claude/projects/<project>/<cliSessionId>.jsonl`. For local sessions
  these are live.
- **SSH sessions:** the desktop app copies the server's transcript to `ssh-<id>/`, but only when a
  turn ends or you open the session. While a turn runs, the pet goes by the app's log
  (`%LOCALAPPDATA%\Claude\logs\main.log`), which gets a line when a prompt is sent and when a turn
  ends. It also uses the session index, which the app saves now and then during a turn.
- **Questions and permission prompts:** the app's log also gets a line when Claude stops to ask
  you something or to ask permission for a tool, and another when you answer or the question is
  withdrawn. That's how the pet shows "Needs you" right away for SSH sessions and for permission
  prompts. The app asks some questions of its own the same way, such as whether to load the mods
  Claude wrote. Those can stay up after the turn ends, and so does the bubble. Until the
  transcript has the question, the bubble says "Has a question for you" rather than the question
  itself.
- **Server clock:** SSH transcripts carry the server's timestamps. The pet measures how far
  that clock is off from the copies and corrects for it, so a turn's end and the moment you marked
  it done compare on one clock.
- **Ready until done:** a turn's Ready (and Error) stays until you mark it done (a bubble's × or the
  sidebar's *Mark as done*) or start another turn. Opening the session, or
  looking at it in the app, leaves it, and the pet follows a session's transcript for as long as
  that holds. Turns that ended before you first ran a version with this rule cleared once you looked
  at them; settings.json keeps when that was (`readyFrom`).
- **Background tasks:** when Claude sends a command, an agent or a monitor to the background, its
  turn ends at once and the task's notice starts the next one when it finishes. To keep the bubble
  from going Ready, gone, Running again, the pet follows each task from the transcript entry that
  launched it to the notice that ends it, and shows "Background" until they're all done. Stopping a
  task yourself writes no notice, so a stop counts as its end, and so does the one notice the app
  writes for every task that was still going when a session was closed and reopened. A question,
  an error or a turn that needs you still shows over it. A monitor that watches for the whole
  session isn't counted, since it never finishes. A task that never reports back (its session was
  closed) stops counting after 4 hours, and a dev server left running in the background keeps the
  bubble on "Background" for those 4 hours too.
- **VS Code and terminal sessions:** Claude Code run in VS Code, or `claude` in a terminal, on this
  PC, in WSL or on an SSH host the pet reads, gets a bubble and a sidebar row like the app's,
  marked "VS Code" or "Terminal". The sidebar lists every one Claude Code still keeps: the last
  week's are followed as they're written, older ones are listed quiet. WSL is read only while the
  distro runs, so the pet never starts it. Clicking a VS Code session brings the VS Code window
  for its machine to the front (by the `[WSL: …]` or `[SSH: …]` in its title) and opens the
  session there; VS Code asks once whether to let the extension open it. With no window for that
  machine open, the session's folder opens there first, and a second click opens the session. A
  terminal session has nothing to open. A turn's Ready stays until you mark it done, as the
  app's does. Sessions you deleted in the app, the desktop app's own (a scheduled task's earlier
  runs included) and programs' (Agent SDK) runs are skipped.
- **Timing:** the pet reacts as soon as Windows reports that one of these files changed, and
  re-checks on a timer as a backup. What's left is Claude's own timing. It saves the session
  index 1–3 s after a change, and writes a turn's summary a few seconds after the turn ends.
  That summary says whether Claude ended the turn waiting on you, so the pet waits for it (up to
  10 s; it usually takes 3–4 s), much as the app does before it notifies you. Meanwhile the
  bubble says "Running · Wrapping up", then goes straight to "Needs you" or "Ready".

The logic that turns transcript entries into a status is in [src/transcript.js](src/transcript.js),
and [test/transcript.test.js](test/transcript.test.js) covers it. How the index, the log and SSH
copies are combined is in [src/sessions.js](src/sessions.js), covered by
[test/sessions.test.js](test/sessions.test.js).

**Limitations:**
- **SSH turns.** If the app has to start the session's CLI first, the bubble appears when the
  first reply arrives.
- **Mark as read / unread isn't followed.** Ready goes by what you mark done in the pet. The
  sidebar's unread dots, including the ones you set by hand, live only in the localStorage of the
  app's window (item `epitaxy-unread-v1`, with `unreadIds` and `explicitUnreadIds`, in a LevelDB
  database under `%APPDATA%\Claude\Local Storage\leveldb`). The app's browser engine writes that
  to disk in rate-limited batches, only about once a minute while claude.ai is busy, so following
  it would lag your marks by up to a minute.
- **Undocumented files.** The session index, the log and the transcript format belong to the
  Claude app and Claude Code, and can change in an update. If the pet stops reacting after an update,
  `node src/sessions.js` shows what it can still read.

## Codex

If Codex is installed, its threads get bubbles next to Claude's, marked "Codex" and the thread's
project folder (e.g. "Codex · tokenizer · 2m"). Tray menu → *Sources* →
*Show Codex threads* turns them off. Clicking one opens that thread in Codex
(`codex://threads/<id>?hostId=<host>`), and tray menu → *Open Codex* opens the app. Codex works
without Claude too: then clicking the pet opens Codex, and the menu has no Claude items.

- **Ready:** a thread that finished, until you mark it done or send it a message, read in Codex or
  not. Once its history isn't followed any more (an hour on), the time Codex's thread list last
  changed stands in for when it finished. For threads on hosts the pet doesn't watch, it goes by
  Codex's own unread list (`~/.codex/.codex-global-state.json`) and goes away once you open the
  thread in Codex.
- **Running, Needs you, Error:** read from each thread's history (its rollout file), the way
  Codex writes it. For threads on this PC (Codex's local host and the Codex CLI) that's
  `~/.codex/sessions`.
- **Questions:** when Codex asks you something (the app's "Needs input"), the bubble says "Needs
  you" with the question. That covers Plan mode's questions, which hold the turn up, and the ones
  Codex asks while it keeps working, which stay up until you answer them or the turn ends, the
  way the app counts them.
- **SSH hosts:** a thread on an SSH host keeps its history on that host. For each host Codex
  works on, the pet keeps one SSH connection open, using your `~/.ssh/config`, and runs a
  small read-only Python watcher there. The watcher sends the new lines of rollouts written in
  the last hour (a VS Code or terminal chat's, in the last week), the list of those chats with
  their names, plus the host's clock so the times line up, and once, when it starts, the
  newest reply's rate limits (for the [weekly limits](#weekly-limits)). It checks every second,
  but only the rollouts it follows and the folders of the last two days; it looks through all of
  them every 30 s, so a resumed old thread can take that long to show. It exits as soon as the
  pet quits, even if the pet crashes. Tray menu → *Sources* → *Follow Codex on SSH hosts* turns
  this off. The host needs `python3` and a key that works without a prompt (`ssh <host>` must just work).
- **dot:** the app's *dots* (the assistant you message, named dot) run in the cloud and leave no
  history file to follow, so there's no step to show. The pet goes by what the app keeps in its
  state file: a dot is *working* from a message the app stamps to the millisecond until the
  server's whole-second stamp for the reply (or 45 seconds after the last stamp, if none comes),
  and *Ready* while the app lists it as unread. The app also flags a dot as unread at times when
  the chat has nothing new (a server stamp on its own, or the flag raised again right after you
  read it), so only a flag that follows a turn's stamps since you last read counts. The threads a
  dot starts, and the one its upkeep runs in on a timer (*Heartbeat Dreamer*), don't make it Ready
  either; only its own replies do. Clicking opens the dot's conversation (`codex://threads/<id>` on the
  dot's host; `codex://dots` would only open the app's dots home).
- **Titles and host names** come from the app's thread list (`~/.codex/sqlite/codex.db`, or
  `codex-dev.db` from the app's other builds; the pet reads whichever the app wrote last) and the
  names you gave your connections.
- **VS Code and terminal chats:** chats in the Codex VS Code extension, or `codex` in a terminal,
  on this PC, in WSL or on a host Codex works on, get a bubble and a sidebar row, marked
  "Codex · VS Code" or "Codex · Terminal". The sidebar lists every one Codex hasn't archived: the
  last week's are followed as they're written, older ones are listed quiet. WSL is read only while
  the distro runs. Clicking a VS Code chat opens it in VS Code
  (`vscode://openai.chatgpt/local/<id>`), in the window for its machine, as for Claude Code's; a
  terminal chat has nothing to open. A turn's Ready
  stays until you mark it done. Their names come from each machine's
  `~/.codex/session_index.jsonl`.
- **Not shown:** ChatGPT chats in the app (those on chatgpt.com can be, see
  [Web chats](#web-chats-claudeai-chatgpt-gemini)), and Codex's own helper threads such as its auto-reviewer.

## Web chats (claude.ai, ChatGPT, Gemini)

Chats on claude.ai, chatgpt.com and gemini.google.com can get bubbles too, from a small browser
extension in [browser-extension/](browser-extension/) for Chrome, Edge and other Chromium browsers.
It's **off** until you turn it on: tray menu → *Sources* → *Web chats* → *Show claude.ai, ChatGPT
and Gemini chats*. Their bubbles are marked "Claude Chat", "ChatGPT" or "Gemini Chat" (e.g. "ChatGPT · 2m").

- **Setting up:** turning it on writes a native messaging host (a manifest and a small launcher) to
  `%APPDATA%\ttokttok-pet\webchats` and registers it for Chrome and Edge under
  `HKCU\Software\…\NativeMessagingHosts\com.hyukjunlim.ttokttok_pet`, which needs no admin rights;
  other Chromium browsers, such as Aside, read Chrome's. Then load the extension once: open the
  browser's extensions page (`chrome://extensions`, `edge://extensions`), turn on *Developer mode*,
  choose *Load unpacked* and pick the folder that *Open the extension folder* shows. The key in the
  extension's manifest fixes its ID, so the host answers only this extension, wherever its folder
  is. Turning web chats off removes the registration.

  Without the tray menu (say, an assistant setting the pet up for you): quit the pet, set
  `"webChats": true` in `%APPDATA%\ttokttok-pet\settings.json`, and start it again; it registers the
  host as it starts. The extension's folder is `browser-extension` in the source folder, or
  `resources\app\browser-extension` next to `Ttokttok Pet.exe` in a downloaded copy. Loading it
  (*Developer mode* → *Load unpacked*) is the one step you do yourself in the browser.
- **Running** while a reply is being written, **Ready** once it's done. Ready stays until you close
  it with × (or the sidebar's *Mark as done*), send another message, or close its tab, looked at or
  not. A conversation open in several tabs gets one bubble, which goes once none of them shows it:
  closed, moved on to another conversation, or gone with the browser.
- **Clicking** brings the chat's tab and its browser window to the front.
- **What it sends:** for each chat tab, its title, its address without query or fragment, whether a
  reply is being written and whether you're looking at it. Never the messages. The extension only
  reads the page and makes no requests of its own; the host hands the tabs' reports to the pet over
  a local named pipe (`\\.\pipe\ttokttok-pet-webchats-<user>`), not the network.
- **How it knows a reply is being written:** by the site's stop control. On claude.ai the message
  being written carries `data-is-streaming="true"`. ChatGPT serves two different pages: on one, the
  send button carries `data-stop-generating` and the message `data-message-streaming`; on the other,
  which signed-in accounts may get, the only sign is a stop button shown in the message box,
  labelled in the page's language (a hidden twin of it is always there). On Gemini, the send button
  turns into a stop button while it writes (`.send-button.stop`, labelled in the page's language).
  All of this is in `WRITING` at the top of [browser-extension/content.js](browser-extension/content.js).
- **When bubbles don't come:** tray menu → *Sources* → *Web chats* says *Extension connected* once
  a browser has the extension running, and *Waiting for the extension* until then. If it's
  connected and a site's replies still don't show, the site has changed its page, and `WRITING` is
  what to fix.
  After changing the extension, reload it on the extensions page; the chat tabs already open get
  the new copy without a reload.
- **Not shown:** chats in the Claude or ChatGPT desktop apps, chats on other devices, and replies
  that finish after you closed their tab (ChatGPT's deep research keeps going on the server then,
  out of the pet's sight).

## Weekly limits

Below the lowest bubble, just above the pet, sits one more bubble with a row per app. Each row
shows how much of that plan's weekly limit you've used against how far into the week you are:

- **Used:** the row fills up from the left, with the percentage on the right. Claude's fills in
  Claude's orange, with white text over it; Codex's in gray.
- **Week gone by:** a thin line across the row.
- **Reading it:** a fill that reaches past the line means you're using the limit faster than
  the week goes by.

Hovering the sidebar's meter (in folder mode), or the tray menu (as a floating pet), gives the same
figures in words, with how far into the week you are, the time until each reset, and how old the
figures are once they're over an hour old. Tray menu → *Appearance* → *Show weekly limits* turns
the meter off. The pet reads the figures from files; it contacts no server itself
(apart from the SSH hosts above, and below, SNU eTL once you turn [that](#etl-snu) on, Slack's Web
API once you turn on [Slack presentation reminders](#slack-presentation-reminders), Kakao PlayMCP
once you turn on [TodoMate schedule](#todomate-schedule), and the phones' push services once you
turn on the phone companion).

- **Claude:** the pet's mod for Claude Code saves the figures after each reply of every session,
  with when the week resets ([Live Claude usage](#live-claude-usage)). The pet shows the newest,
  from this PC, WSL or an SSH host. Without the mod, there's no Claude row. (The desktop app keeps
  a usage history of its own, but samples it only while you're at the PC, so the pet doesn't use
  it.)
- **Codex:** each reply in a rollout records the account's rate limits and when they reset. The
  pet uses the newest reply it can see, on this PC or on an SSH host. After the reset time
  passes, the meter shows 0% until the next reply.

## Phone

The phone companion puts what the sidebar shows on your phone (Android, or an iPhone with iOS
16.4 or later) and sends a notification when a chat finishes. It's **off** until you turn it on:
tray menu → *Phone* → *Show the sidebar on my phone, with notifications*. The PC does all the
watching and the phone only shows what the pet sends it, so the PC has to be on and awake.

- **Before you start:**
  - a pet with the phone companion: a copy run from the source gets it with *Check for
    updates…*; a downloaded copy gets it from the first release after 0.9.0;
  - Tailscale on the PC and on the phone, signed in with the same account. The first time the pet
    sets up Tailscale Serve, Tailscale may ask you to turn on HTTPS certificates for your tailnet
    in its admin console; turn them on, then choose *Pair a phone…* again;
  - for taps to land: the Claude app signed in to the same Claude account, on a plan that includes
    Remote Control; the ChatGPT app, with this PC paired in the ChatGPT desktop app (Settings →
    Connections → *Control this Mac or PC*); and LearningX Student 2.0 for eTL on Android.
- **Setting up:** install [Tailscale](https://tailscale.com/download) on the PC and on the phone,
  and sign in to both with the same account. Turning the companion on (or tray menu → *Phone* →
  *Pair a phone…*) offers to run `tailscale serve --bg http://127.0.0.1:47823` once, which puts the
  pet at `https://<this PC>.<tailnet>.ts.net/` for your own devices only, and then shows a six-digit
  pairing code that works once, for 10 minutes. On the phone, with Tailscale on, open that address
  and enter the code. Add the page to the Home Screen (an iPhone needs that for notifications:
  Share → *Add to Home Screen*, then open it from there) and tap *Turn on notifications*. Tray
  menu → *Phone* → *Send a test notification* checks that they arrive. *Send a sample eTL notice*
  puts a 테스트 notice on the phone for 10 minutes, to try the way into LearningX. Getting
  started's *Phone* step does the same a part at a time, and says which part is missing.
- **What it shows:** the sidebar's machine › folder tree with each session's status, eTL's,
  Slack's and TodoMate's notices and the weekly limits. Machines and folders fold as they do in the sidebar. While the page is
  open it asks the PC every 4 seconds; when the PC is asleep or the phone is off the tailnet, it
  keeps the last list and says *PC out of reach*.
- **Tapping** opens the app. A Claude Code session with Remote Control on opens at itself in the
  Claude app, ready for a reply (the desktop app's *Connect new sessions to Remote Control* setting
  does that for new sessions; in VS Code or a terminal, `/remote-control` does it); one without
  opens the Code tab (`https://claude.ai/code`). A Codex thread opens the ChatGPT app's Codex
  screen (`https://chatgpt.com/codex`), where you pick the PC and the thread, as Codex has no link
  to one thread on a phone. A web chat opens at its own conversation. An eTL notice opens in
  LearningX Student 2.0 on Android; on an iPhone it opens on the web, as eTL's site has no links
  into the app. A Slack reminder opens its canvas in the Slack app. A TodoMate item opens the
  TodoMate app. Where the app isn't installed,
  the page opens on the web. (On Android the link names the app's package, and Android itself
  falls back to the web page.)
- **Notifications:** when a session turns *Ready*, *Needs you* or *Error*, and when a new eTL
  bubble comes: 마감 임박, 마감 변경, 새 과제, 성적, 새 공지 (보강 공지, 휴강 공지) and 토큰 만료;
  and Slack's reminders on D-7, D-3, D-1 and D-Day (not the other days' D-X) and 순서 변경.
  TodoMate's bubbles never notify.
  *Running*, today's classes and sessions hidden from the sidebar don't notify, and neither does
  what's already showing when the companion starts. Tapping one opens a small page about it with
  one button into its app: the session in Claude or ChatGPT, the notice in LearningX. (A phone
  opens an app only from a tap in a page, never straight from a notification.) The phone makes
  that page itself, so it opens with Tailscale off. The Claude and ChatGPT apps may send
  notifications of their own for the same chat; turn those off to get one of each.
- **When it doesn't work:** if the page doesn't load, Tailscale is off on the phone, or another VPN
  (WARP, an ad blocker) is using the phone's one VPN slot. *PC out of reach* means the PC is asleep
  or off. No notifications on an iPhone: open the page from its Home Screen icon, not in Safari. If
  port 47823 is taken, tray menu → *Phone* says so.
- **Privacy:** the pet's server listens on 127.0.0.1 only, so nothing on the LAN or the internet
  reaches it, and Tailscale Serve passes it only devices on your tailnet. The page's data needs the
  cookie a paired phone got; the pet keeps only its hash. Notifications go by Web Push through the
  push service the phone's browser uses (Apple's, Google's or Mozilla's), encrypted so that service
  can't read them. `%APPDATA%\ttokttok-pet\phone.json` keeps the paired phones and the key the pet
  signs notifications with. Tray menu → *Phone* → *Paired phones* → *Forget* drops a phone, and
  `tailscale serve reset` takes the address down.

## Live Claude usage

The pet comes with a small mod for Claude Code ([claude-mod/](claude-mod)). After each reply, Claude
Code knows how much of your plan's limits the account has used, and when they reset; the mod
saves those figures to `~/.ttokttok-pet/usage.json`, and does nothing else. The weekly-limit meter
then follows your usage as it happens, from any session, whether you're at the PC or not.

**Setting it up.** Getting started's *Claude usage* step sets it up on the machines you tick. If it
found Claude Code nowhere, the pet asks once as soon as it finds it in WSL. Later, use tray menu →
*Sources* → *Live Claude usage*, which has a checkbox per machine. The desktop app isn't needed:
Claude Code reads the same settings whether you start it from a terminal or the app does.

- **This PC:** the pet copies the mod to `~/.ttokttok-pet/mod/pet-usage` and adds two entries to
  the `env` of Claude Code's settings (`~/.claude/settings.json`, backed up first to
  `settings.json.ttokttok-pet.bak`):
  - `CLAUDE_CODE_PLUGIN_DIRS`: the mod's folder, after any folders you already list there.
  - `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`: `1`, which mods need. This turns function hooks on for
    every Claude Code session on the machine.
- **WSL:** Claude Code in WSL, from a terminal there or run by the desktop app, uses the distro's
  own settings, so each distro gets the same two entries in its own `~/.claude/settings.json`.
  They point at this PC's copy through `/mnt/c`, so WSL sessions write the same file the pet
  reads here. The menu lists the distros the desktop app has run sessions in, and those where the
  pet found a `~/.claude`: every 5 minutes it asks the distros that are running (never starting
  one), each once a run, so one you start Claude Code in shows up soon after. Docker's own distros
  are left alone. The distro needs `python3`, for the setup and for being asked. Without Claude
  Code on this PC, the PC gets only the copy of the mod, not the settings entries.
- **SSH hosts:** Claude Code on a host runs there (and the desktop app leaves a plugin's hooks out
  when it copies plugins there), so the mod has to be set up on the host itself: the pet copies it
  there over SSH and adds the same entries to the host's settings. The desktop app's saved
  connections are listed on their own. For a host you reach from a terminal, pick it under *More
  SSH hosts (~/.ssh/config)*: the `Host` names in your `~/.ssh/config` (and the files it
  `Include`s), without wildcards and git hosting like github.com. Picking one sets the mod up there;
  unticking it removes the mod and forgets the host. To read the hosts' figures, the pet keeps one
  SSH connection per host with a small read-only Python watcher that sends the file when it
  changes; tray menu → *Sources* → *Live Claude usage* → *Read usage on SSH hosts* turns that off.
  As for Codex, the host needs `python3` and a key that works without a prompt.

Sessions you start after setting it up use it; sessions already open don't. When the pet updates,
it brings the copies of the mod it set up up to date too. Unticking a machine removes the entries
again (function hooks only if the pet turned them on), with the mod and its file.

**How often.** The mod writes the file as each reply ends. The pet checks the file here every 3
seconds, and the watcher on each SSH host checks every 2 seconds and sends it when it changed, so
the meter follows within a few seconds.

Claude Code's mods are an early-access feature and can change between releases. If the mod stops
working, the meter keeps its last figures, and says how old they are (on hover in folder mode, in
the tray menu as a floating pet). The figures are the account's, so the pet assumes every machine
uses the same Claude account.

## eTL (SNU)

For students at Seoul National University, the pet can also watch [eTL](https://myetl.snu.ac.kr)
(SNU's Canvas LMS) and answer questions about it in a chat folder. It's **off** until you turn it
on, and while it's off the pet makes no request to eTL and creates no file for it.

**Turning it on.** In Getting started's *SNU eTL* step, choose *Connect eTL…*, or use tray menu →
*Sources* → *eTL* → *켜기* later. A small window asks for an eTL access token: on eTL, open *계정 → 설정*
(https://myetl.snu.ac.kr/profile/settings) → *새 액세스 토큰*, and paste it there. The pet checks
the token with eTL before saving it. *토큰 등록/변경…* replaces it.

**Bubbles.** The pet checks eTL when it starts, every 30 minutes, when the PC wakes from sleep,
and on *지금 확인*. The first check only notes what's there and says how many assignments are due.
After that, a bubble appears for:

- **마감 임박:** from 24 hours before an assignment is due until the due time, one bubble per
  assignment, made from the last check's list, so a check that fails doesn't lose it. It shows the
  time left, kept current: **마감 임박** in yellow while it isn't handed in (red in its last 3
  hours), **제출함** in green once it is, **오프라인** in gray for work handed in on paper. Its ×
  hides it for an hour.
- **마감 변경**, **새 과제**, **성적** (a new or changed grade) and **새 공지** (announcements of the
  last 14 days; one that mentions a makeup or cancelled class says **보강 공지** or **휴강 공지**).
- **Today's classes:** from 6:00, one bubble per class (start time, course, room and how soon it
  starts, kept current), each until that class ends. With TodoMate's schedule they make one list in
  start order, a class first at the same time, and those under way or next, starting earliest,
  stand out; 보강 and 휴강 get their own badge. Clicking one opens the course; × hides it until the
  pet restarts or the day ends; tray menu → *Sources* → *eTL* → *오늘 수업 알림* turns them off.
- **토큰 만료:** once, when eTL stops accepting the token.

Clicking a bubble opens that eTL page in your browser; × dismisses the others for good. Other
bubbles go away after 3 days, and at most 30 are kept. Changes made while the pet wasn't running
show up at the next check.

**Chat folder.** Turning eTL on also creates a chat folder, `Documents\etl-assistant` by default
(*채팅 폴더 위치 변경…* moves it; your `todos.md` and `timetable.md` are copied and the old folder is left
alone). Open
it in the Claude desktop app's Code tab or in Codex, and ask things like "이번 주 마감 알려줘".
With Codex installed, turning eTL on opens a new chat there in this folder, and *Codex에서 eTL
비서 열기* does it again later. *eTL 비서 말풍선 보이기* (offered when you first save a token) keeps
an **eTL 비서** bubble at the end of the others: clicking it goes back to the newest Codex chat in
the folder, or starts one (without Codex, it opens the folder). The folder holds instructions for Claude and Codex
(`AGENTS.md`, `CLAUDE.md`), a few skills (`/briefing`, `/deadlines`, `/todo`) and `etl.js`, a small
command the AI runs to ask the pet. The AI never sees the token: `etl.js` sends the question to
the running pet over a local named pipe (`~/.ttokttok-pet/etl.sock` on macOS and Linux), the pet
asks eTL, and only the answer goes back. With the pet closed or eTL off, the AI says so. When
the pet updates, the folder's files are updated too, except `todos.md`.

**Anything else on eTL.** Besides its ready-made lookups, `etl.js api "/api/v1/…"` asks the pet for
any Canvas API path with GET, so the chat can answer about modules, pages, discussions, quizzes,
the calendar, the inbox and the rest. The `etl-api` skill lists the paths to try. Signed file links
and calendar-feed addresses are masked in the answer, paths about access tokens are refused, and
opening a conversation doesn't mark it read.

**Timetable.** eTL has no class times, but each syllabus links to the course in SNU's public course
catalog (`sugang.snu.ac.kr`), which has them. The pet looks each of this term's courses up there
(no login, and the eTL token is never sent there), keeps the weekly timetable for a day, and adds
the day's eTL calendar events. Makeup and cancelled classes go in `timetable.md` in the chat folder,
one per line (`- 2026-10-20 보강 18:00~19:15 | 가상현실공학 | 000-101`,
`- 2026-10-21 휴강 | 나노소자개론`); the `/timetable` skill offers to add the ones it finds in
announcements, and the class bubbles pick up changes within a minute. `etl.js timetable`
answers for a date or the whole week.

**Course materials, on request.** Ask the chat to read or summarize a particular lecture file.
The AI lists that course's files with `node etl.js files --course <course ID>`, then requests just
the selected file with `node etl.js download <course ID> <file ID>`. Lists combine the Files tab,
module File items, announcement and assignment attachments and file links, and your own submitted
files. A hidden Files tab does not prevent the other sources from working.

Files are saved under `강의자료/<course name>/` in the chat folder. A saved copy with the same
modification time and size is reused; a changed or deleted file is downloaded again. The pet
downloads nothing during periodic checks or when eTL is turned on. Videos, files over 100MB,
and locked or hidden files are left as eTL links. Materials available only through LearningX's
weekly lessons cannot be retrieved this way.

Default briefings, assignment lists, announcements and grades cover the latest term. The
`courses` command also lists older courses, marked `current: false`; specifying a course ID
lets the chat look up that course, including its materials.

**Security.**

- The token is encrypted with Electron's `safeStorage` (DPAPI on Windows) in the pet's own app
  data folder. If encryption isn't available, the pet refuses to save it. It never appears in
  the log, the bubbles, the chat folder or the answers.
- The pet only reads from eTL (GET requests): it doesn't submit assignments or post anything.
- The pipe takes a fixed list of questions, each checked, and nothing else. One of them, `api`,
  reads any `/api/v1/` path, so the chat can see whatever the token can read (your inbox and
  course rosters included); the AI is told to treat it as data and keep others' details to what
  you asked.
- Text from eTL (titles, announcements, descriptions) is shown as plain text, and every answer
  to the AI is marked as outside data, not instructions.
- Downloads follow HTTPS redirects only to eTL and `kr.object.gov-ncloudstorage.com`, the
  storage host used by SNU eTL. The token goes only to eTL; signed download URLs are not saved
  in the download records or returned to the AI. Filenames are cleaned and saved paths are
  checked to stay inside the chat folder.

eTL's API can change; if checks start failing, tray menu → *Sources* → *eTL* shows the error.

## Slack presentation reminders

If your group keeps its presentation order in a Slack canvas, the pet can remind you of your turns.
It's **off** until you turn it on, and while it's off the pet makes no request to Slack and creates
no file for it.

**Turning it on.** In Getting started's *Slack* step, choose *Set up Slack…*, or use tray menu →
*Sources* → *Slack 발표* → *켜기*. A small window asks for three things:

- a user token: at https://api.slack.com/apps, create an app in your workspace, add
  `canvases:read` under *OAuth & Permissions* → *User Token Scopes*, install it, and copy the
  *User OAuth Token* (`xoxp-…`);
- the canvas link (in Slack, the canvas's *Copy link*: `https://<workspace>.slack.com/docs/T…/F…`);
- your name as the table writes it.

The pet reads the canvas before saving anything and lists the turns it found, so a name that
doesn't match shows at once. *토큰·캔버스·이름 설정…* changes any of them.

**The table.** It needs a 날짜 column (`YYYY-MM-DD`) and a 상태 column. 요일, 시간 and 세션 describe
the slot, and every other column is a presenter column. A turn is a row whose 상태 is 정상 진행 with
your name in a presenter column. A note beside the name, like "(리허설)", is fine. A name struck
through (`~~이름~~`) doesn't count, so a slot that's done or cancelled gets no reminder.

**Bubbles.** The pet reads the canvas when it starts, every 30 minutes, when the PC wakes from
sleep, and on *지금 확인*. For each turn to come:

- **D-X**, every morning from 06:00: `D-7 11/10(화) 짧은 발표 2` counts down a day at a time to
  **D-Day**, which stays until the presentation ends. They're made from the last schedule read, so
  a check that fails doesn't lose one. D-7, D-3, D-1 and D-Day stand out; the other days stay
  quiet.
- **순서 변경** appears when one of your turns to come is added, removed or moved to another column.
  It stays for 3 days.
- **토큰 확인** appears when Slack stops accepting the token. The pet then stops asking until you set
  it up again.
- **표 확인 필요** appears when the table loses its 날짜 or 상태 column. Reminders continue from the
  last schedule read.

Clicking a D-X bubble clears it until the next morning; nothing opens. Clicking 순서 변경, 토큰 확인
or 표 확인 필요 opens the canvas in Slack.

**Security.** The token is encrypted with `safeStorage`, like eTL's, and never appears in the log
or the bubbles. The pet calls one Slack method, `canvases.getContent`, on the one canvas you
registered. It never posts, reacts or edits anything in Slack.

## TodoMate schedule

If you keep your day in [TodoMate](https://www.todomate.net/), the pet can show today's meetings
and count down to your deadlines. It's **off** until you turn it on, and while it's off the pet
makes no request and creates no file for it.

It reads TodoMate through TodoMate's official tools on [Kakao PlayMCP](https://playmcp.kakao.com),
and only the three that read: `loadTodoItems`, `loadTodoItemsByDateRange` and `loadGoals`. It never
adds, checks, edits or deletes a todo.

**Turning it on.**

1. On [playmcp.kakao.com](https://playmcp.kakao.com/toolbox), sign in with Kakao and add
   **투두메이트** to your toolbox (it asks you to link your TodoMate account).
2. In Getting started's *TodoMate* step, choose *Connect TodoMate…*, or use tray menu → *Sources* →
   *투두메이트 일정* → *켜기*. The pet opens your toolbox in the browser.
3. There, click **OpenClaw와 연결**, agree, and click **연결 프롬프트 생성**. Copy the prompt, then click
   *클립보드로 연결* in the pet's dialog. The prompt works for 10 minutes; the pet takes only the
   one-time token in it.

PlayMCP lets only its partners' servers register apps of their own, so the pet connects the way
PlayMCP's [guide for agents you run yourself](https://playmcp.kakao.com/llms/mcp-connection-guide.md)
describes; PlayMCP's *Connected services* lists it as OpenClaw. That way in is a PlayMCP beta
feature, so it may change.

**Bubbles.** The pet reads TodoMate when it starts, every 15 minutes, when the PC wakes from sleep,
and on *지금 확인*.

- **Today's schedule:** items of the *Schedule* category that start with a time, like
  `13:00 팀 미팅` or `11:30-12:30 세미나 (101-201)`, show from 06:00 until each ends (an item with
  only a start time counts as an hour), checked or not. They share one list with today's classes,
  in start order; those under way or next, starting earliest, stand out. A click does nothing; its
  × hides it.
- **D-Day:** items of the *D-Day* category that start with a date, like `11/6 저널클럽 발표`, show
  every morning from 06:00 as `D-3 11/6(금) 저널클럽 발표` until that day ends. The pet looks for
  them on today and the 29 days before, since an item stays on the day it was written. Clicking
  one clears it until the next morning.
- **연결 필요** appears when PlayMCP stops accepting the connection. Clicking it asks for a new
  connection prompt.

*카테고리* and *D-Day 카테고리* in the menu pick other categories. None of these notify the phone.

**Security.** PlayMCP's tokens are encrypted with `safeStorage`, like eTL's, and renewed as they
expire (about every 12 hours; a fresh connection prompt is needed after about three months). The
log records only counts, never your todos. *연결 해제* deletes the tokens; to end the connection on
PlayMCP's side too, remove it under PlayMCP → 프로필 → 설정 → 연결된 서비스.

To try the bubbles at another time of day, start the pet with `--todomate-clock=09:00`; a restart
from the tray menu goes back to the real time.

## Pets

A pet is a folder containing `pet.json` and a sprite sheet, the same format as ChatGPT/Codex pets:

```text
<pets folder>/<pet-id>/
├── pet.json
└── spritesheet.webp   (or .png)
```

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "One short sentence.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

- **Sprite sheet:** a transparent PNG or WebP, 1536×2288, made of 8 columns × 11 rows of 192×208
  cells. Older v1 sheets (1536×1872, 9 rows, no look directions) also work.
- **Rows 0–8** are the animations, with these frame counts: `idle` 6, `running-right` 8,
  `running-left` 8, `waving` 4, `jumping` 5, `failed` 8, `waiting` 6, `running` 6, `review` 6.
- **Rows 9–10** hold 16 clockwise look directions, the first looking straight up. ChatGPT's pet
  uses them to follow the cursor; Ttokttok Pet doesn't.
- **Pixel art:** add `"pixelArt": true` to keep it crisp at every size (this is a Ttokttok Pet
  extension to the format).
- **Tray icon (optional):** put a `tray.png` (16 px) next to the sprite sheet, optionally with
  `tray@1.5x.png` (24 px) and `tray@2x.png` (32 px). The tray icon then switches whenever that
  pet is selected. Clay ships its own; other pets use the default icon.

Pets are loaded from these folders:

1. `pets/` in this project, for the built-in pet, Clay.
2. `~/.ttokttok-pet/pets/` for your own pets. Tray menu → *Appearance* → *Pet* → *Open my pets folder* opens it.
3. `~/.codex/pets/`, where pets you hatch in ChatGPT/Codex with the `hatch-pet` skill show up
   automatically.

Switch between them in tray menu → *Appearance* → *Pet*.

**Clay** is drawn in code by [tools/make_clay.py](tools/make_clay.py) and needs only Python to
rebuild (`npm run sprite:clay`). It has two-tone outlines, bounce-light shading, eyebrows, raised
arms that read as arms, and a trailing spark antenna. It also has a prop for each state: a laptop
while working, a paper while reviewing, a "?" bubble while waiting, and smoke and a tear when
something fails.

## How ChatGPT's pet works (and what this copies)

Everything below comes from reading the installed ChatGPT/Codex desktop app (v26.917).

- **A separate overlay window.** It's frameless, transparent, always on top, off the taskbar,
  shadowless and never takes focus: `frame:false, transparent:true, alwaysOnTop,
  skipTaskbar, focusable:false`, then `setAlwaysOnTop(true,'floating')`. On Windows Ttokttok Pet
  uses `'pop-up-menu'` instead: there `'floating'` also puts the window just behind the taskbar,
  and when the taskbar isn't on top at that moment, the pet isn't either.
- **Clicks pass through.** The window runs `setIgnoreMouseEvents(true,{forward:true})` so it
  still receives mouse movement. The page tests whether the cursor is over the pet and only then
  asks for real clicks. Ttokttok Pet doesn't do that, because it needs two programs to agree on
  whether the window is taking clicks, and they can stop agreeing: on Windows the forwarded mouse
  moves can stop coming, and watching the cursor from the main process instead left the pet deaf
  until the mouse moved, after a virtual-desktop switch. Instead the window is cut to what's
  drawn with `setShape`: the pet's outline (every frame of the row it's showing, so the pixels
  themselves, not its box) and the bubbles. Windows decides what's inside the shape, so there's
  nothing to track, and a click anywhere else goes to the window behind. The cost is that the
  bubbles' shadows, and the weekly-limit bubble, take clicks too.
- **Sprite animation.** The sheet is a CSS `background-image` stepped with timers. A state
  plays three times, then settles into an idle loop running at one-sixth speed. Ttokttok Pet
  instead plays it twice and rests on its first frame. Its reactions to you (the jump on hover,
  the wave on a click) play twice, each frame held 25% longer, so they're easy to see.
- **Look directions.** While calm, the eyes follow the cursor: `atan2(dx, -dy)` is split into
  sixteen 22.5° sectors, which select a cell in rows 9–10. Ttokttok Pet leaves this out.
- **Throw physics.** 16 ms ticks, friction 0.88 per tick, bounce 0.7, and a stop below 65 px/s
  or after 900 ms. Ttokttok Pet uses the same numbers.

## Project layout

```text
src/main.js         Electron main process: window, drag/throw, tray, deep links
src/shape.js        The window's shape: which parts take the mouse (the pet and the bubbles)
src/preload.js      Minimal API exposed to the page (context isolation, sandboxed)
src/renderer/       Pet page (sprite engine, activity bubbles), the sidebar's page and Getting started's page
src/sessions.js     Finds sessions, follows their transcripts and the app's log
src/foreground.js   Which app's window is in front, for Ctrl+Tab (a small PowerShell helper, Windows)
src/raise.js        Brings Codex's window, or a web chat's browser window, to the front (Windows)
src/folder-mode.js  Folder mode's sidebar: its window, docked at a monitor's left or right edge
src/folder-tree.js  Sessions and threads → machine › folder tree, for the sidebar
src/folder-preload.js What the sidebar's page may ask of the main process
src/appbar.js       Docks a window as a Windows app bar (a small PowerShell helper)
src/maximize.js     Maximizes the Claude and Codex windows beside the sidebar (Windows)
src/step-keys.js    Ctrl+Tab through the sidebar while Claude, Codex or the sidebar is in front
src/marks.js        Folder mode's Mark as Ready: which marks your next message takes off
src/migrate.js      Brings over what an older install kept under its previous name
src/onboarding.js   Getting started: the window, the state its steps show, the practice items
src/codex.js        Codex threads: the unread list, the thread list, local histories, dots
src/codex-remote.js Follows Codex histories on SSH hosts (a small Python watcher)
src/ssh-watcher.js  Keeps a watcher running on an SSH host: the connection, retries, its clock
src/claude-usage.js Claude's usage from everywhere: the mod's file here and on SSH hosts, the app
src/claude-remote.js Reads the mod's file on an SSH host (a small Python watcher)
src/claude-mod.js   Sets the mod up on this PC, in WSL and on SSH hosts, and takes it away
src/rollout.js      Codex rollout entries → running / waiting / review / failed
src/transcript.js   Transcript entries → running / background / waiting / review / failed
src/usage.js        Weekly limits: Claude's figures (the mod's, the app's), Codex's rate limits
src/pets.js         Pet discovery and validation (Codex format)
src/demo.js         Fake sessions for `npm run demo`
src/etl/            SNU eTL: API client, notices, timetable, token store, query bridge, chat folder
src/slack/          Slack presentation reminders: canvas client, table rules, tracker, setup window
src/todomate/       TodoMate through Kakao PlayMCP: connecting, the MCP client, schedule and D-Day rules
src/webchats/       Web chats: the extension's native host, its registration, tab reports → bubbles
src/phone/          The phone companion: its web server, Web Push, what the phone shows and what notifies, the page (www/)
tools/make_clay.py  Generates Clay, the built-in pet
claude-mod/         The mod for Claude Code that saves Claude's usage after each reply
etl-workspace/      What the eTL chat folder is made from: instructions, skills, etl.js
browser-extension/  The Chrome/Edge extension that reports claude.ai, ChatGPT and Gemini tabs to the pet
```
