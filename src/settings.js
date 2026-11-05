'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  petKey: 'built-in:clay',
  scale: 0.75,
  theme: 'system',         // the pet's look: 'system' (Windows' app mode), 'light' or 'dark'
  mode: 'pet',             // 'pet': the floating pet; 'folder': a sidebar of every session, by machine and folder
  folderWidth: 400,        // the sidebar's width in DIPs (drag its inner edge; double-click it for this)
  folderDisplay: null,     // ... the monitor it docks on (an Electron display id); null: the pet's
  folderEdge: 'left',      // ... and that monitor's edge: 'left' or 'right'
  folderFold: {},          // folder mode: folder key -> open, where you changed it
  folderOrder: {},         // ... parent key -> its machines' or folders' keys, in the order you dragged them
  folderZoom: null,        // ... the text size (Ctrl +, Ctrl -), 1 being 100%; null: not set yet
  folderPetScale: 0.5,     // the size of the pet at the sidebar's foot (Small; tray menu → Appearance → Size in folder mode)
  visible: true,
  position: null,          // top-left of the pet sprite, in screen DIPs
  showActivity: true,
  alwaysAnimate: true,     // animate even when Windows' Animation effects are off
  showUsage: true,         // the weekly-limit meter next to the pet
  claudeUsageOverSsh: true,  // read Claude's usage from the mod on SSH hosts
  claudeSshHosts: [],        // the hosts from ~/.ssh/config picked for the mod (the desktop app's come on their own)
  claudeModOffered: false,   // the pet has asked once whether to set up its Claude Code mod
  claudeModWsl: {},          // distro -> whether the mod is set up there, as last seen
  claudeModWslToMove: null,  // distros still loading an older install's copy of the mod (main.js moveWsl); null: none were
  claudeCodeWsl: {},         // distro -> whether Claude Code is there, as last seen
  showCodex: true,         // also show Codex threads, when Codex is installed
  codexOverSsh: true,      // and follow the ones running on Codex's SSH hosts
  etlEnabled: false,       // watch SNU eTL for deadlines and notices (needs a token)
  etlOnboardingOffered: false, // the pet has offered the optional eTL connection once
  etlWorkspace: null,      // the eTL chat folder; null: Documents\etl-assistant
  etlAssistantBubble: false, // keep an "eTL 비서" bubble that opens the eTL chat
  etlAssistantAsked: false,  // asked once, when the first token was saved
  etlTimetableBubble: true,  // a bubble for each of the day's classes (while eTL is on)
  slackEnabled: false,     // remind of your presentation turns from a Slack canvas (needs a token)
  slackCanvasUrl: null,    // ... that canvas's link (https://<workspace>.slack.com/docs/T…/F…)
  slackName: null,         // ... and your name as the canvas's table writes it
  todomateEnabled: false,  // today's timed items of one TodoMate category, through Kakao PlayMCP (needs a sign-in)
  todomateCategory: null,  // ... that category's title; null: Schedule
  todomateDdayCategory: null, // ... and the one whose dated items count down; null: D-Day
  todomateHidden: {},      // ... bubble id -> until when it stays hidden (×, or a click on a countdown)
  webChats: false,         // claude.ai and ChatGPT chats, from the browser extension
  phone: false,            // the sidebar on your phone, with notifications (phone/feature.js)
  phonePort: null,         // ... the local port it serves on; null: 47823
  phoneSessionPush: { review: true, waiting: true, failed: true },  // ... which session statuses notify (Ready, Needs you, Error)
  phoneNoticePush: { etl: true, slack: true, todomate: true },      // ... and which notices (phone/notify.js)
  shortcut: 'CommandOrControl+Alt+P',
  dismissed: {},
  readyFrom: null,         // when opening a session stopped counting as done with it (main.js)
  cliReadyFrom: null,      // ... and when VS Code and terminal sessions' Ready started lasting until done
  marked: {},              // sessions marked as Ready in the sidebar: session id -> when (marks.js)
  hidden: {},              // sessions hidden from the sidebar: session id -> when; hidden until brought back
};

class Settings {
  constructor(file) {
    this.file = file;
    this.firstRun = !fs.existsSync(file);   // nothing saved yet: a new install
    this.data = { ...DEFAULTS };
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // first run or unreadable file: keep defaults
    }
    // Settings an older pet kept but this one doesn't use are dropped, and the file saved without them.
    let retired = false;
    for (const [key, value] of Object.entries(saved ?? {})) {
      if (Object.hasOwn(DEFAULTS, key)) this.data[key] = value;
      else retired = true;
    }
    this.timer = null;
    if (retired) {
      try {
        this.save();
      } catch {
        // saved again with the next change
      }
    }
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 400);
  }

  save() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS };
