# Constraints

Hard constraints for Ttokttok Pet. Change them only with the owner's approval.

## Platform and runtime
- The pet runs on Windows 10/11 x64 only. Its phone companion is a web page the pet serves, for
  Android and for iPhone (iOS 16.4 or later, added to the Home Screen).
- Electron 44, plain JavaScript (CommonJS). No runtime npm dependencies: `dependencies`
  stays empty, and Win32 access goes through small PowerShell helpers, not native modules.
- `npm test` (`node --test`) passes on plain Node 22, where the release workflow runs it.

## Claude and Codex
- Read their files only (session index, transcripts, logs, the session files that running Claude
  Code processes keep (`~/.claude/sessions/<pid>.json`), Codex state and thread catalog).
  Never write to them or change their settings. Two exceptions: the opt-in Claude Code mod for
  live usage, installed only when the user turns it on, and the sidebar's Delete for a chat run
  in VS Code or a terminal, only after the user confirms it. A Claude Code session's transcript
  and its folder are deleted (to the Recycle Bin on this PC); a Codex chat is archived through
  Codex's own app-server (`thread/archive`), never by editing its files.
- Open sessions only through the apps' own links: `claude://resume?session=<id>`,
  `codex://threads/<id>?hostId=<host>`, and the VS Code extensions' links:
  Claude Code's `vscode://anthropic.claude-code/open?session=<id>` and Codex's
  `vscode://openai.chatgpt/local/<id>`, sent once the VS Code window for that session's machine
  is in front. With no such window, VS Code's own `vscode://vscode-remote/<wsl+distro or
  ssh-remote+host><folder>` (or `vscode://file/<folder>` on this PC) opens the folder there first.
  New chats likewise: `claude://code/new?folder=<folder>` (or `ssh_host`/`ssh_port`/`ssh_folder`
  for an SSH host) and `codex://threads/new?path=<folder>` (or `?projectId=<id>&prompt=` for a
  WSL folder that is one of Codex's projects).
- On the phone, a tap opens the official app: a Claude Code session with Remote Control on at
  itself (`https://claude.ai/code/<Remote Control session id>`), one without at
  `https://claude.ai/code`; a Codex thread at ChatGPT's `https://chatgpt.com/codex`, as Codex has
  no link to one thread on a phone; a web chat at its own conversation. With the app missing, the
  same page opens on the web.

## Network
- No server contact of its own, except SSH hosts from `~/.ssh/config` with key auth, SNU eTL
  once the user turns it on, and Slack's Web API (`slack.com/api`) once the user turns it on,
  with a user token the user registers (scope `canvases:read` only), reading only the canvas the
  user registers. On SSH hosts the pet runs read-only Python watchers, plus one
  command per Delete the user confirms in the sidebar (remove that Claude Code session's files,
  or archive that Codex chat through Codex's app-server).
- The phone companion, only once the user turns it on: a web server bound to 127.0.0.1, reached
  from the phone only through Tailscale Serve on the user's own tailnet (never the LAN, never
  Tailscale Funnel or any other public route; the pet sets Serve up only when the user asks), and
  Web Push to the push service the phone's browser chose (Apple, Google or Mozilla), its content
  encrypted end to end (RFC 8291). No server of the project's own.

## Floating pet
- The pet's window never takes focus.

## Folder mode
- A second mode, chosen in the tray menu (or with `--mode=folder`): a sidebar docked to the
  left or right edge of a monitor, both chosen in the tray menu, as a Windows app bar, listing
  every Claude session and Codex thread as a host › folder tree. A session opened from a
  parent folder stays at that parent folder.
  The pet and the weekly limits sit at its bottom.
- Clicking a session opens it in the official app, which fills the rest of the screen:
  one conversation at a time.
- A folder's menu can start a new chat there only by handing the app its own new-chat link;
  the app creates the session. The sidebar itself never chats.
- Out of scope: chatting in the sidebar, grouping by topic, sharing context between the two
  apps, embedding into the Claude app.

## Phone companion
- Off until the user turns it on. A phone gets in only after pairing with a code the pet shows.
- Shows what the sidebar shows: the host › folder tree with each session's status, eTL's notices
  and the weekly limits. It never chats.
- Pushes when a session turns Ready, Needs you or Error, and when a new eTL bubble appears
  (마감 임박, 마감 변경, 새 과제, 성적, 새 공지, 토큰 만료), and when a presentation reminder from
  Slack appears (발표 D-7, D-3, D-1, 당일, 순서 변경). Running and today's classes don't push.
- An eTL notice opens in the LearningX Student app where the phone allows it, otherwise on the web.
- Works only while the PC is on and awake; the phone never checks eTL or reads sessions itself.
- Out of scope: replying from the phone, the animated pet on the phone, any server run by the
  project.

## Slack presentation schedule
- Off until the user turns it on and registers a user token, a canvas link and their name.
- Read-only: it never posts, reacts, or edits anything in Slack.
- A turn is a row of the canvas's table whose 상태 is 정상 진행 and that has the user's name, not
  struck through, in a presenter column.
- Reminds at D-7, D-3, D-1 and on the day; works only while the PC is on and awake.

## Release
- A `v<version>` tag matches the version in `package.json`.
