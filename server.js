const express = require("express");
const chokidar = require("chokidar");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, "data");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const CODEX_MONITOR_STATE_FILE = path.join(DATA_DIR, "codex-monitor-state.json");
const PORT = Number(process.env.PORT || 4321);
const DEFAULT_MONITOR_ROOT = resolveDefaultMonitorRoot();
const MONITOR_ROOT = path.resolve(process.env.MONITOR_ROOT || DEFAULT_MONITOR_ROOT);
const WATCH_PATHS = resolveWatchPaths(process.env.WATCH_PATHS, process.env.MONITOR_ROOT);
const WINDOW_SAMPLER_INTERVAL_MS = Number(
  process.env.WINDOW_SAMPLER_INTERVAL_MS || 8000
);
const CODEX_POLL_INTERVAL_MS = Number(process.env.CODEX_POLL_INTERVAL_MS || 5000);
const CODEX_TASK_SETTLE_MS = Number(process.env.CODEX_TASK_SETTLE_MS || 8000);
const CODEX_LOGS_DB = expandUserHome(
  process.env.CODEX_LOGS_DB || "~/.codex/logs_2.sqlite"
);
const CODEX_STATE_DB = expandUserHome(
  process.env.CODEX_STATE_DB || "~/.codex/state_5.sqlite"
);
const CODEX_HISTORY_FILE = expandUserHome(
  process.env.CODEX_HISTORY_FILE || "~/.codex/history.jsonl"
);
const CODEX_GLOBAL_STATE_FILE = expandUserHome(
  process.env.CODEX_GLOBAL_STATE_FILE || "~/.codex/.codex-global-state.json"
);
const TERMINAL_HOOK_SOURCE = path.join(APP_DIR, "scripts", "zsh-activity-hook.zsh");
const RECENT_ACTIVITY_WINDOW_MS = Number(
  process.env.RECENT_ACTIVITY_WINDOW_MS || 1000 * 60 * 30
);

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EVENTS_FILE)) {
  fs.writeFileSync(EVENTS_FILE, "", "utf8");
}

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

let watcher = null;
let lastFocusFingerprint = "";
let lastFocusAt = 0;
let codexPollTimer = null;
let codexPollInFlight = false;
let codexMonitorState = loadCodexMonitorState();
let lastCpuSnapshot = readCpuSnapshot();
let topProcessesCache = {
  capturedAt: 0,
  value: {
    cpuTop: [],
    memoryTop: []
  }
};
let topDiskEntriesCache = {
  capturedAt: 0,
  value: []
};

function expandUserHome(targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return "";
  }

  if (targetPath === "~") {
    return os.homedir();
  }

  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

function resolveDefaultMonitorRoot() {
  const desktopDir = path.join(os.homedir(), "Desktop");
  if (fs.existsSync(desktopDir)) {
    return desktopDir;
  }

  return path.dirname(APP_DIR);
}

function readSeedEventsForWatchPaths() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) {
      return [];
    }

    return fs
      .readFileSync(EVENTS_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-400);
  } catch {
    return [];
  }
}

function collapseToDesktopProjectPath(targetPath, desktopDir) {
  const resolved = normalizePath(targetPath);
  if (!resolved) {
    return "";
  }

  if (resolved === desktopDir) {
    return desktopDir;
  }

  const relative = path.relative(desktopDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return resolved;
  }

  const [firstSegment] = relative.split(path.sep).filter(Boolean);
  if (!firstSegment) {
    return desktopDir;
  }

  return path.join(desktopDir, firstSegment);
}

function resolveWatchPaths(rawWatchPaths, rawMonitorRoot) {
  if (rawWatchPaths) {
    return rawWatchPaths
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item));
  }

  if (rawMonitorRoot) {
    return [path.resolve(rawMonitorRoot)];
  }

  const desktopDir = DEFAULT_MONITOR_ROOT;
  const seeds = new Set([path.dirname(APP_DIR)]);
  const recentEvents = readSeedEventsForWatchPaths()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  for (const event of recentEvents) {
    const filePath = event.payload?.path;
    const cwdPath = event.payload?.cwd;
    const seedPath = cwdPath || (filePath ? path.dirname(filePath) : "");

    if (!seedPath) {
      continue;
    }

    seeds.add(collapseToDesktopProjectPath(seedPath, desktopDir));
    if (seeds.size >= 8) {
      break;
    }
  }

  return [...seeds]
    .map((item) => path.resolve(item))
    .filter((item) => fs.existsSync(item))
    .filter((item) => item !== normalizePath(os.homedir()));
}

function safeWriteJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function loadCodexMonitorState() {
  try {
    if (fs.existsSync(CODEX_MONITOR_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CODEX_MONITOR_STATE_FILE, "utf8"));
    }
  } catch {
    // Ignore invalid persisted state and rebuild below.
  }

  return {
    initialized: false,
    lastSeenLogId: 0,
    lastSeenTurnCompletedLogId: 0,
    lastPollAt: null,
    lastTaskAt: null,
    lastTaskTitle: "",
    lastTaskThreadId: "",
    promptInitialized: false,
    lastPromptTs: 0,
    recentPromptKeys: []
  };
}

function persistCodexMonitorState() {
  safeWriteJson(CODEX_MONITOR_STATE_FILE, codexMonitorState);
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve(String(stdout || ""));
    });
  });
}

function sqliteQuote(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function splitCommand(command) {
  return command.split(/\s+/).filter(Boolean);
}

function maybeExtractFileTargets(command) {
  const tokens = splitCommand(command);
  const candidates = [];
  const shellMetaPrefixes = [">", "<", "|", "&"];

  for (const token of tokens) {
    if (
      token.startsWith("-") ||
      shellMetaPrefixes.some((prefix) => token.startsWith(prefix)) ||
      token.startsWith("http://") ||
      token.startsWith("https://")
    ) {
      continue;
    }

    if (/[./\\]/.test(token) || /\.[a-zA-Z0-9]{1,8}$/.test(token)) {
      candidates.push(token);
    }
  }

  return [...new Set(candidates)].slice(0, 8);
}

function normalizePath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return "";
  }

  try {
    return path.resolve(targetPath);
  } catch {
    return targetPath;
  }
}

function shouldIgnore(targetPath) {
  const resolved = normalizePath(targetPath);
  const relativeToApp = path.relative(APP_DIR, resolved);

  if (!relativeToApp.startsWith("..") && !path.isAbsolute(relativeToApp)) {
    return true;
  }

  const ignoredFragments = [
    `${path.sep}.git${path.sep}`,
    `${path.sep}node_modules${path.sep}`,
    `${path.sep}.next${path.sep}`,
    `${path.sep}dist${path.sep}`,
    `${path.sep}build${path.sep}`,
    `${path.sep}.cache${path.sep}`,
    `${path.sep}Library${path.sep}Caches${path.sep}`
  ];

  if (ignoredFragments.some((fragment) => resolved.includes(fragment))) {
    return true;
  }

  return /\.(zip|tar|gz|mp4|mov|avi|mkv|iso|dmg|sqlite|db)$/i.test(resolved);
}

function readCpuSnapshot() {
  const cpus = os.cpus() || [];
  const seed = {
    idle: 0,
    total: 0,
    cores: Math.max(1, cpus.length),
    sampledAt: Date.now()
  };

  return cpus.reduce((snapshot, cpu) => {
    const times = cpu?.times || {};
    const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);

    snapshot.idle += Number(times.idle || 0);
    snapshot.total += total;
    return snapshot;
  }, seed);
}

function getCpuUsagePercent() {
  const currentSnapshot = readCpuSnapshot();
  const previousSnapshot = lastCpuSnapshot;
  lastCpuSnapshot = currentSnapshot;

  if (!previousSnapshot) {
    return null;
  }

  const idleDelta = currentSnapshot.idle - previousSnapshot.idle;
  const totalDelta = currentSnapshot.total - previousSnapshot.total;

  if (totalDelta <= 0) {
    return null;
  }

  const usagePercent = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Number(Math.max(0, Math.min(100, usagePercent)).toFixed(1));
}

function formatProcessLabel(command, args) {
  const primary = String(command || "").trim();
  const full = String(args || "").trim();

  if (full) {
    return full.length > 140 ? `${full.slice(0, 140)}...` : full;
  }

  if (!primary) {
    return "未知进程";
  }

  return primary.length > 140 ? `${primary.slice(0, 140)}...` : primary;
}

async function getTopProcesses() {
  const now = Date.now();
  if (now - Number(topProcessesCache.capturedAt || 0) < 8000) {
    return topProcessesCache.value;
  }

  const output = await execFileText("ps", ["-Ao", "pid,pcpu,pmem,comm,args", "-r"]);
  const lines = String(output || "")
    .trim()
    .split("\n")
    .slice(1);

  const rows = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(
        /^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s*(.*)$/
      );

      if (!match) {
        return null;
      }

      const [, pid, cpuPercent, memoryPercent, command, args] = match;
      return {
        pid: Number(pid),
        cpuPercent: Number(cpuPercent),
        memoryPercent: Number(memoryPercent),
        command,
        args,
        label: formatProcessLabel(command, args)
      };
    })
    .filter(Boolean);

  const value = {
    cpuTop: [...rows]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 5),
    memoryTop: [...rows]
      .sort((a, b) => b.memoryPercent - a.memoryPercent)
      .slice(0, 5)
  };

  topProcessesCache = {
    capturedAt: now,
    value
  };

  return value;
}

async function getDiskUsage(targetPath = MONITOR_ROOT) {
  const output = await execFileText("df", ["-kP", targetPath]);
  const line = String(output || "")
    .trim()
    .split("\n")
    .slice(1)
    .pop();

  if (!line) {
    return null;
  }

  const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
  if (!match) {
    return null;
  }

  const [, filesystem, totalKb, usedKb, availableKb, capacity, mountPoint] = match;
  return {
    filesystem,
    path: targetPath,
    mountPoint,
    totalBytes: Number(totalKb) * 1024,
    usedBytes: Number(usedKb) * 1024,
    freeBytes: Number(availableKb) * 1024,
    usagePercent: Number(capacity)
  };
}

async function getPathDiskUsage(targetPath) {
  const output = await execFileText("du", ["-sk", targetPath]);
  const line = String(output || "")
    .trim()
    .split("\n")[0];

  if (!line) {
    return null;
  }

  const match = line.match(/^(\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }

  const [, sizeKb, resolvedPath] = match;
  return {
    path: resolvedPath,
    sizeBytes: Number(sizeKb) * 1024
  };
}

function getDiskScanTargets() {
  const targets = [];

  for (const watchPath of WATCH_PATHS) {
    targets.push(watchPath);

    try {
      const children = fs
        .readdirSync(watchPath, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .slice(0, 40)
        .map((entry) => path.join(watchPath, entry.name));

      targets.push(...children);
    } catch {
      // Ignore directories that cannot be listed.
    }
  }

  return [...new Set(targets)].filter((targetPath) => {
    if (!targetPath || !fs.existsSync(targetPath)) {
      return false;
    }

    return !shouldIgnore(targetPath);
  });
}

async function getTopDiskEntries() {
  const now = Date.now();
  if (now - Number(topDiskEntriesCache.capturedAt || 0) < 60000) {
    return topDiskEntriesCache.value;
  }

  const scanTargets = getDiskScanTargets().slice(0, 80);
  const results = [];

  for (const targetPath of scanTargets) {
    try {
      const usage = await getPathDiskUsage(targetPath);
      if (!usage) {
        continue;
      }

      const stats = fs.statSync(targetPath);
      results.push({
        path: usage.path,
        sizeBytes: usage.sizeBytes,
        name: path.basename(targetPath),
        kind: stats.isDirectory() ? "directory" : "file",
        parent: path.dirname(targetPath)
      });
    } catch {
      // Ignore entries that fail du/stat.
    }
  }

  const value = results
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 5);

  topDiskEntriesCache = {
    capturedAt: now,
    value
  };

  return value;
}

function appendEvent(event) {
  fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8");
}

function logEvent(type, payload, source = "system", occurredAt) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    source,
    occurredAt: occurredAt || new Date().toISOString(),
    payload
  };

  appendEvent(event);
  return event;
}

function safeReadEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getLatestEvent(events, matcher) {
  return [...events]
    .filter(matcher)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0] || null;
}

function readIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch {
    // Ignore shell config read failures.
  }

  return "";
}

function getShellHookStatus() {
  const candidateFiles = [
    path.join(os.homedir(), ".zshrc"),
    path.join(os.homedir(), ".zprofile"),
    path.join(os.homedir(), ".zshenv")
  ];
  const installedFiles = candidateFiles.filter((filePath) => {
    const content = readIfExists(filePath);
    return content.includes(TERMINAL_HOOK_SOURCE);
  });

  return {
    installed: installedFiles.length > 0,
    installedFiles,
    sourceCommand: `source ${TERMINAL_HOOK_SOURCE}`
  };
}

function summarizeCollectorStatus(date) {
  const allEvents = safeReadEvents();
  const dayEvents = filterEventsByDate(allEvents, date);
  const latestFileEvent = getLatestEvent(dayEvents, (event) => event.type.startsWith("file."));
  const latestCommandEvent = getLatestEvent(
    allEvents,
    (event) => event.type === "terminal.command"
  );
  const recentThreshold = Date.now() - RECENT_ACTIVITY_WINDOW_MS;
  const lastCommandAtMs = latestCommandEvent?.occurredAt
    ? new Date(latestCommandEvent.occurredAt).getTime()
    : 0;
  const shellHook = getShellHookStatus();

  return {
    date,
    monitorRoot: MONITOR_ROOT,
    defaultMonitorRoot: DEFAULT_MONITOR_ROOT,
    watchPaths: WATCH_PATHS,
    todayFileEvents: dayEvents.filter((event) => event.type.startsWith("file.")).length,
    lastFileEventAt: latestFileEvent?.occurredAt || null,
    lastFilePath: latestFileEvent?.payload?.path || "",
    todayCommandEvents: dayEvents.filter((event) => event.type === "terminal.command").length,
    lastCommandAt: latestCommandEvent?.occurredAt || null,
    lastCommand: latestCommandEvent?.payload?.command || "",
    terminalHookInstalled: shellHook.installed,
    terminalHookInstalledFiles: shellHook.installedFiles,
    terminalHookSourceCommand: shellHook.sourceCommand,
    terminalHookActive: Boolean(lastCommandAtMs && lastCommandAtMs >= recentThreshold),
    recentActivityWindowMs: RECENT_ACTIVITY_WINDOW_MS
  };
}

async function getSystemMetrics(date) {
  const cpuUsagePercent = getCpuUsagePercent();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const [disk, topProcesses, topDiskEntries] = await Promise.all([
    getDiskUsage(WATCH_PATHS[0] || MONITOR_ROOT).catch(() => null),
    getTopProcesses().catch(() => ({
      cpuTop: [],
      memoryTop: []
    })),
    getTopDiskEntries().catch(() => [])
  ]);

  return {
    capturedAt: new Date().toISOString(),
    cpu: {
      usagePercent: cpuUsagePercent,
      loadAverage1m: Number(os.loadavg()[0].toFixed(2)),
      cores: os.cpus()?.length || 1,
      top: topProcesses.cpuTop
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: usedMemory,
      usagePercent: Number(((usedMemory / totalMemory) * 100).toFixed(1)),
      top: topProcesses.memoryTop
    },
    disk: {
      ...(disk || {}),
      top: topDiskEntries
    },
    collectors: summarizeCollectorStatus(date)
  };
}

function getRecentCodexTaskEvents(limit = 20) {
  return safeReadEvents()
    .filter(isVisibleCodexTaskEvent)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit);
}

function isVisibleCodexTaskEvent(event) {
  if (!event || event.type !== "codex.task.completed") {
    return false;
  }

  if (event.source === "manual") {
    return true;
  }

  return (
    event.payload?.completionSource === "turn-completed" &&
    event.payload?.completionScope === "thread-turn" &&
    String(event.payload?.threadTitle || "").trim()
  );
}

function getExistingPromptKeys() {
  return new Set(
    safeReadEvents()
      .filter((event) => event.type === "prompt.entry" && event.source === "codex-history")
      .map((event) => event.payload?.historyKey)
      .filter(Boolean)
  );
}

function rememberPromptKey(historyKey) {
  const recent = Array.isArray(codexMonitorState.recentPromptKeys)
    ? codexMonitorState.recentPromptKeys
    : [];
  recent.push(historyKey);
  codexMonitorState.recentPromptKeys = recent.slice(-400);
}

function hasSeenPromptKey(historyKey) {
  const recent = Array.isArray(codexMonitorState.recentPromptKeys)
    ? codexMonitorState.recentPromptKeys
    : [];
  return recent.includes(historyKey);
}

function targetDateFromQuery(input) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (input && iso.test(input)) {
    return input;
  }

  return new Date().toISOString().slice(0, 10);
}

function filterEventsByDate(events, date) {
  return events.filter((event) => event.occurredAt.slice(0, 10) === date);
}

function normalizeFilterInput(input) {
  return String(input || "").trim();
}

function resolveCommandTarget(targetPath, cwd) {
  if (!targetPath) {
    return "";
  }

  if (path.isAbsolute(targetPath)) {
    return normalizePath(targetPath);
  }

  if (cwd) {
    return normalizePath(path.join(cwd, targetPath));
  }

  return normalizePath(targetPath);
}

function resolveWatchPathForTarget(targetPath) {
  const resolved = normalizePath(targetPath);
  const sortedWatchPaths = [...WATCH_PATHS].sort((a, b) => b.length - a.length);

  for (const watchPath of sortedWatchPaths) {
    if (resolved === watchPath || resolved.startsWith(`${watchPath}${path.sep}`)) {
      return watchPath;
    }
  }

  return "";
}

function getEventProjectInfo(event) {
  const payload = event?.payload || {};
  const cwd = payload.cwd || "";
  const candidates = [
    payload.path,
    cwd,
    ...(Array.isArray(payload.fileTargets) ? payload.fileTargets.map((item) => resolveCommandTarget(item, cwd)) : [])
  ].filter(Boolean);

  for (const candidate of candidates) {
    const watchPath = resolveWatchPathForTarget(candidate);
    if (!watchPath) {
      continue;
    }

    return {
      key: watchPath,
      label: path.basename(watchPath),
      root: watchPath
    };
  }

  return null;
}

function buildProjectCounts(events) {
  const counter = new Map();

  for (const event of events) {
    const project = getEventProjectInfo(event);
    if (!project?.key) {
      continue;
    }

    const current = counter.get(project.key) || {
      key: project.key,
      label: project.label,
      root: project.root,
      count: 0
    };
    current.count += 1;
    counter.set(project.key, current);
  }

  return [...counter.values()].sort((a, b) => b.count - a.count);
}

function buildEventSearchText(event) {
  const payload = event?.payload || {};
  const segments = [
    event?.type,
    event?.source,
    payload.command,
    payload.cwd,
    payload.path,
    payload.baseName,
    payload.candidateFileName,
    payload.text,
    payload.title,
    payload.promptText,
    payload.threadTitle,
    payload.appName,
    payload.windowTitle,
    ...(Array.isArray(payload.fileTargets) ? payload.fileTargets : [])
  ];

  return segments
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function applyEventFilters(events, filters = {}) {
  const project = normalizeFilterInput(filters.project);
  const keyword = normalizeFilterInput(filters.keyword).toLowerCase();
  const eventType = normalizeFilterInput(filters.eventType);

  return events.filter((event) => {
    if (eventType && event.type !== eventType) {
      return false;
    }

    if (project) {
      const projectInfo = getEventProjectInfo(event);
      if (!projectInfo || projectInfo.key !== project) {
        return false;
      }
    }

    if (keyword && !buildEventSearchText(event).includes(keyword)) {
      return false;
    }

  return true;
  });
}

function friendlyEventTypeLabel(type) {
  const dictionary = {
    "app.focus": "前台窗口",
    "prompt.entry": "提示词",
    "terminal.command": "终端命令",
    "file.changed": "文件修改",
    "file.created": "文件创建",
    "file.deleted": "文件删除",
    "directory.created": "目录创建",
    "directory.deleted": "目录删除",
    "codex.task.completed": "Codex 完成任务"
  };

  return dictionary[type] || type;
}

function buildEventTypeCounts(events) {
  const counter = new Map();

  for (const event of events) {
    counter.set(event.type, (counter.get(event.type) || 0) + 1);
  }

  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({
      type,
      label: friendlyEventTypeLabel(type),
      count
    }));
}

function trimPromptText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function isShortPrompt(text) {
  return trimPromptText(text).length > 0 && trimPromptText(text).length <= 8;
}

function isFillerPrompt(text) {
  const normalized = trimPromptText(text);
  return /^(继续|可以|行|好的|好|收到|不对|不行|改一下|看一下|看看|先这样|继续吧|1|1\.)$/i.test(
    normalized
  );
}

function hasExplicitTarget(text) {
  return /(\/|https?:\/\/|\.json|\.jsonl|\.csv|\.xlsx|\.docx|\.js|\.ts|\.md|接口|日志|报错|字段|文件|目录|表|线程|任务|ip|端口|sql|json|csv|excel|word)/i.test(
    text
  );
}

function hasAmbiguousReference(text) {
  return /(这个|那个|这里|这样|那样|上面|下面|上一版|还是那个|它|这条|这一块|这部分)/.test(text);
}

function hasOutputExpectation(text) {
  return /(输出|给我|整理|列出|返回|生成|写成|总结|分析|排查|对比|修复|修改|改成|做成|说明|告诉我|表格|清单|步骤|结论)/.test(
    text
  );
}

function hasConstraintOrFormat(text) {
  return /(不要|只要|先|直接|按照|格式|表格|json|markdown|分点|步骤|今天|这个目录|这个文件|路径|接口|字段|状态|工作区|优先|先别|最后)/i.test(
    text
  );
}

function containsSensitiveDetails(text) {
  return /(密码|账号密码|password|token|apikey|api key|secret|密钥)/i.test(text);
}

function maskSensitiveSegments(text) {
  return String(text || "")
    .replace(
      /((?:账号密码|密码|password|token|apikey|api key|secret|密钥)\s*(?:是|为|:|：|=)?\s*)([^，。；,;\n]+)/gi,
      "$1******"
    )
    .replace(/\/Users\/[^/]+/g, "/Users/<user>")
    .replace(/\/home\/[^/]+/g, "/home/<user>")
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/g, "$1<user>");
}

function buildPromptIssues(promptText) {
  const text = trimPromptText(promptText);
  const issues = [];

  if (!text) {
    return issues;
  }

  if (isFillerPrompt(text) || isShortPrompt(text)) {
    issues.push({
      key: "too_short",
      label: "过短",
      reason: "这类短句没有说明对象、动作和目标，模型只能猜你想继续哪件事。"
    });
  }

  if (hasAmbiguousReference(text) && !hasExplicitTarget(text)) {
    issues.push({
      key: "ambiguous_target",
      label: "对象不明确",
      reason: "你提到了“这个 / 那个 / 上一版”，但没有补文件、接口、文档或任务名。"
    });
  }

  if (!hasOutputExpectation(text)) {
    issues.push({
      key: "missing_output",
      label: "缺少结果预期",
      reason: "没有告诉我最后要输出成什么样，容易导致结果方向对了但形式不对。"
    });
  }

  if (!hasExplicitTarget(text) && !hasConstraintOrFormat(text) && text.length < 36) {
    issues.push({
      key: "missing_context",
      label: "上下文不足",
      reason: "提示词里缺少路径、接口、报错、字段或格式要求，信息量不够支撑准确执行。"
    });
  }

  if (containsSensitiveDetails(text)) {
    issues.push({
      key: "sensitive_info",
      label: "敏感信息直写",
      reason: "账号密码、密钥这类内容不适合直接写进提示词历史，最好改成“我稍后本地填写凭据”。"
    });
  }

  return [...new Map(issues.map((item) => [item.key, item])).values()];
}

function getPromptEvents(events) {
  return events
    .filter((event) => event.type === "prompt.entry" && trimPromptText(event.payload?.text))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

function findPreviousMeaningfulPrompt(promptEvents, currentIndex) {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = trimPromptText(promptEvents[index]?.payload?.text);
    if (candidate && !isFillerPrompt(candidate) && candidate.length >= 10) {
      return candidate;
    }
  }

  return "";
}

function findRecentContextBefore(events, currentEvent) {
  const earlierEvents = events
    .filter((event) => event.occurredAt <= currentEvent.occurredAt)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const recentTask = earlierEvents.find(isVisibleCodexTaskEvent);
  const recentFile = earlierEvents.find(
    (event) =>
      event.type.startsWith("file.") ||
      (event.type === "app.focus" && event.payload?.candidateFileName)
  );

  return {
    recentTaskTitle:
      recentTask?.payload?.promptText || recentTask?.payload?.threadTitle || recentTask?.payload?.title || "",
    recentFile:
      recentFile?.payload?.path || recentFile?.payload?.candidateFileName || recentFile?.payload?.baseName || ""
  };
}

function normalizeContextAnchor(text) {
  return maskSensitiveSegments(trimPromptText(text).replace(/\s+/g, " ")).slice(0, 120);
}

function inferOutputTemplate(contextAnchor, recentFile) {
  const anchor = `${contextAnchor} ${recentFile}`.toLowerCase();

  if (anchor.includes("接口") || anchor.includes("api") || anchor.includes("响应")) {
    return "1. 字段级问题 2. 原因判断 3. 修复建议";
  }

  if (anchor.includes(".docx") || anchor.includes("文档") || anchor.includes("方案")) {
    return "1. 修改点 2. 修改后的正文 3. 需要你确认的地方";
  }

  if (anchor.includes(".xlsx") || anchor.includes(".csv") || anchor.includes("表")) {
    return "1. 关键信息摘要 2. 差异/异常 3. 下一步建议";
  }

  return "1. 你会做什么 2. 处理结果 3. 风险或下一步";
}

function buildBetterPrompt(promptText, issues, context) {
  const normalized = trimPromptText(promptText);
  const anchor = normalizeContextAnchor(
    context.previousMeaningfulPrompt || context.recentTaskTitle || normalized || "当前任务"
  );
  const targetHint = context.recentFile ? `，重点对象是 ${context.recentFile}` : "";
  const outputTemplate = inferOutputTemplate(anchor, context.recentFile);

  if (/^继续$/i.test(normalized) || normalized.startsWith("继续")) {
    return `继续处理「${anchor}」${targetHint}。请直接开始，并按这个格式给我结果：${outputTemplate}。`;
  }

  if (/^(可以|好|好的|行)$/i.test(normalized)) {
    return `按上一条关于「${anchor}」的需求继续执行${targetHint}。请直接动手处理，完成后告诉我：${outputTemplate}。`;
  }

  if (normalized.includes("不对")) {
    return `上一版关于「${anchor}」的结果还有问题${targetHint}。请先指出具体哪里不对，再给出修正后的版本。输出：1. 错误点 2. 修正思路 3. 最终结果。`;
  }

  if (issues.some((item) => item.key === "ambiguous_target")) {
    return `围绕「${anchor}」继续处理${targetHint}。这次请明确说明你要处理的对象，并告诉我最后要输出成什么格式。建议输出：${outputTemplate}。`;
  }

  if (issues.some((item) => item.key === "missing_output")) {
    return `${normalized}。请最后按这个格式输出给我：${outputTemplate}。`;
  }

  return `围绕「${anchor}」继续处理${targetHint}。请补充：要处理的对象、希望我执行的动作、以及最终输出格式。`;
}

function buildPromptHabits(promptEvents) {
  const counters = {
    tooShort: 0,
    ambiguous: 0,
    missingOutput: 0
  };

  for (const event of promptEvents) {
    const issues = buildPromptIssues(event.payload?.text);
    if (issues.some((item) => item.key === "too_short")) {
      counters.tooShort += 1;
    }
    if (issues.some((item) => item.key === "ambiguous_target")) {
      counters.ambiguous += 1;
    }
    if (issues.some((item) => item.key === "missing_output")) {
      counters.missingOutput += 1;
    }
  }

  const habits = [];

  if (counters.tooShort > 0) {
    habits.push({
      title: `有 ${counters.tooShort} 条提示词过短`,
      detail: "像“继续”“可以”“不对”这类短句最好补上任务名、对象和你要的输出。"
    });
  }

  if (counters.ambiguous > 0) {
    habits.push({
      title: `有 ${counters.ambiguous} 条提示词对象不够明确`,
      detail: "当你写“这个 / 那个 / 上一版”时，最好顺手补上文件名、接口名、路径或文档名。"
    });
  }

  if (counters.missingOutput > 0) {
    habits.push({
      title: `有 ${counters.missingOutput} 条提示词没写结果格式`,
      detail: "多写一句“最后按什么格式给我”，能明显减少来回返工。"
    });
  }

  if (!habits.length) {
    habits.push({
      title: "你最近的提示词已经比较完整",
      detail: "继续保持“对象 + 动作 + 输出格式”这三个元素，稳定性会更高。"
    });
  }

  return habits.slice(0, 3);
}

function summarizePromptInsights(events, date) {
  const promptEvents = getPromptEvents(events);
  const habits = buildPromptHabits(promptEvents);
  const flagged = [];

  for (let index = 0; index < promptEvents.length; index += 1) {
    const event = promptEvents[index];
    const promptText = trimPromptText(event.payload?.text);
    const issues = buildPromptIssues(promptText);

    if (!issues.length) {
      continue;
    }

    const contextAround = findRecentContextBefore(events, event);
    const previousMeaningfulPrompt = findPreviousMeaningfulPrompt(promptEvents, index);
    flagged.push({
      id: event.id,
      occurredAt: event.occurredAt,
      promptText: maskSensitiveSegments(promptText),
      issues,
      contextHint:
        maskSensitiveSegments(
          previousMeaningfulPrompt ||
            contextAround.recentTaskTitle ||
            contextAround.recentFile ||
            "未识别到更具体的前文"
        ),
      betterPrompt: buildBetterPrompt(promptText, issues, {
        previousMeaningfulPrompt,
        recentTaskTitle: contextAround.recentTaskTitle,
        recentFile: contextAround.recentFile
      })
    });
  }

  return {
    date,
    totals: {
      promptCount: promptEvents.length,
      flaggedCount: flagged.length
    },
    habits,
    examples: flagged
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 4)
  };
}

function buildDailyDigest(events, date, totals, projectBreakdown, filters = {}) {
  const sorted = [...events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const latestTask = sorted.find(isVisibleCodexTaskEvent);
  const latestCommand = sorted.find((event) => event.type === "terminal.command");
  const latestPrompt = sorted.find((event) => event.type === "prompt.entry");
  const latestFile = sorted.find((event) => event.type.startsWith("file."));

  if (!events.length) {
    return {
      headline: `${date} 暂时没有符合当前筛选条件的记录。`,
      bullets: ["你可以切换日期，或者清空项目和关键词筛选再看看。"],
      projects: []
    };
  }

  const scopeLabel = filters.projectLabel
    ? `项目「${filters.projectLabel}」`
    : projectBreakdown[0]?.label
      ? `今天主要在「${projectBreakdown[0].label}」`
      : "今天";
  const keywordLabel = filters.keyword ? `，关键词“${filters.keyword}”` : "";
  const bullets = [];

  if (totals.completedTasks > 0) {
    bullets.push(
      `完成了 ${totals.completedTasks} 个 Codex 线程任务${
        latestTask?.payload?.promptText ? `，最近一项是「${trimPromptText(latestTask.payload.promptText).slice(0, 36)}」` : ""
      }。`
    );
  }

  if (totals.fileActivity > 0) {
    bullets.push(
      `采到了 ${totals.fileActivity} 条文件变更${
        latestFile?.payload?.baseName ? `，最近涉及 ${latestFile.payload.baseName}` : ""
      }。`
    );
  }

  if (totals.commands > 0) {
    bullets.push(
      `执行了 ${totals.commands} 条终端命令${
        latestCommand?.payload?.command ? `，最近一条是 ${latestCommand.payload.command.slice(0, 48)}` : ""
      }。`
    );
  }

  if (totals.prompts > 0) {
    bullets.push(
      `记录了 ${totals.prompts} 条提示词${
        latestPrompt?.payload?.text ? `，最近一条是「${trimPromptText(latestPrompt.payload.text).slice(0, 36)}」` : ""
      }。`
    );
  }

  if (!bullets.length) {
    bullets.push("今天有活动记录，但当前筛选下暂时没有形成更明显的行为特征。");
  }

  return {
    headline: `${scopeLabel}${keywordLabel}，共匹配到 ${events.length} 条活动记录。`,
    bullets: bullets.slice(0, 4),
    projects: projectBreakdown.slice(0, 5)
  };
}

function buildWorkInsights(visibleEvents, totals, topActions, projectBreakdown) {
  if (!visibleEvents.length) {
    return [];
  }

  const hourCounter = new Map();
  const appCounter = new Map();

  for (const event of visibleEvents) {
    const hour = new Date(event.occurredAt).getHours();
    if (!Number.isNaN(hour)) {
      hourCounter.set(hour, (hourCounter.get(hour) || 0) + 1);
    }

    if (event.type === "app.focus" && event.payload?.appName) {
      appCounter.set(
        event.payload.appName,
        (appCounter.get(event.payload.appName) || 0) + 1
      );
    }
  }

  const busiestHour = [...hourCounter.entries()].sort((a, b) => b[1] - a[1])[0];
  const topApp = [...appCounter.entries()].sort((a, b) => b[1] - a[1])[0];
  const topProject = projectBreakdown[0];
  const topAction = topActions[0];

  return [
    {
      title: "最忙时段",
      value: busiestHour ? `${String(busiestHour[0]).padStart(2, "0")}:00` : "-",
      detail: busiestHour ? `这一小时内共有 ${busiestHour[1]} 条记录` : "当前筛选下暂无足够数据"
    },
    {
      title: "最高频动作",
      value: topAction ? friendlyEventTypeLabel(topAction.type) : "-",
      detail: topAction ? `共出现 ${topAction.count} 次` : "当前筛选下暂无明显动作"
    },
    {
      title: "最活跃项目",
      value: topProject?.label || "-",
      detail: topProject ? `共命中 ${topProject.count} 条记录` : "当前筛选下暂无项目归属"
    },
    {
      title: "最常驻应用",
      value: topApp?.[0] || "-",
      detail: topApp ? `前台出现 ${topApp[1]} 次` : "当前筛选下暂无前台窗口数据"
    },
    {
      title: "任务完成率",
      value: `${totals.completedTasks}`,
      detail: totals.completedTasks
        ? `今天已识别 ${totals.completedTasks} 个线程任务完成`
        : "当前筛选下还没有识别到完成任务"
    },
    {
      title: "提示词密度",
      value: `${totals.prompts}`,
      detail: totals.prompts
        ? `当前范围内记录了 ${totals.prompts} 条提示词`
        : "当前筛选下没有提示词记录"
    }
  ];
}

function summarizeEvents(events, date, options = {}) {
  const sourceEvents = Array.isArray(options.sourceEvents) ? options.sourceEvents : events;
  const projectBreakdown = buildProjectCounts(events);
  const availableProjects = buildProjectCounts(sourceEvents);
  const availableEventTypes = buildEventTypeCounts(sourceEvents);
  const activeProject = availableProjects.find(
    (item) => item.key === normalizeFilterInput(options.project)
  );
  const activeEventType = availableEventTypes.find(
    (item) => item.type === normalizeFilterInput(options.eventType)
  );
  const visibleEvents = events.filter(
    (event) => event.type !== "codex.task.completed" || isVisibleCodexTaskEvent(event)
  );
  const sorted = [...visibleEvents].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt)
  );

  const totals = {
    all: events.length,
    fileActivity: 0,
    commands: 0,
    prompts: 0,
    focusChanges: 0,
    completedTasks: 0
  };

  const fileCounter = new Map();
  const actionCounter = new Map();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: 0
  }));

  for (const event of visibleEvents) {
    const hour = new Date(event.occurredAt).getHours();
    if (!Number.isNaN(hour) && hourly[hour]) {
      hourly[hour].count += 1;
    }

    actionCounter.set(event.type, (actionCounter.get(event.type) || 0) + 1);

    if (event.type.startsWith("file.")) {
      totals.fileActivity += 1;
      const filePath = event.payload?.path;
      if (filePath) {
        fileCounter.set(filePath, (fileCounter.get(filePath) || 0) + 1);
      }
    } else if (event.type === "terminal.command") {
      totals.commands += 1;
      const targets = event.payload?.fileTargets || [];
      for (const fileTarget of targets) {
        fileCounter.set(fileTarget, (fileCounter.get(fileTarget) || 0) + 1);
      }
    } else if (event.type === "prompt.entry") {
      totals.prompts += 1;
    } else if (event.type === "app.focus") {
      totals.focusChanges += 1;
      const candidate = event.payload?.candidateFileName;
      if (candidate) {
        fileCounter.set(candidate, (fileCounter.get(candidate) || 0) + 1);
      }
    } else if (isVisibleCodexTaskEvent(event)) {
      totals.completedTasks += 1;
    }
  }

  const topFiles = [...fileCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([target, count]) => ({ target, count }));

  const topActions = [...actionCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([type, count]) => ({ type, count }));

  return {
    date,
    totals,
    topFiles,
    topActions,
    availableProjects,
    availableEventTypes,
    activeFilters: {
      project: normalizeFilterInput(options.project),
      projectLabel: activeProject?.label || "",
      keyword: normalizeFilterInput(options.keyword),
      eventType: normalizeFilterInput(options.eventType),
      eventTypeLabel: activeEventType?.label || ""
    },
    digest: buildDailyDigest(visibleEvents, date, totals, projectBreakdown, {
      projectLabel: activeProject?.label || "",
      keyword: normalizeFilterInput(options.keyword)
    }),
    insights: buildWorkInsights(visibleEvents, totals, topActions, projectBreakdown),
    projectBreakdown,
    hourly,
    timeline: sorted.slice(0, 80),
    commands: sorted.filter((event) => event.type === "terminal.command").slice(0, 20),
    prompts: sorted.filter((event) => event.type === "prompt.entry").slice(0, 20),
    focus: sorted.filter((event) => event.type === "app.focus").slice(0, 20),
    files: sorted.filter((event) => event.type.startsWith("file.")).slice(0, 30),
    tasks: sorted.filter(isVisibleCodexTaskEvent).slice(0, 20)
  };
}

function inferCandidateFileName(windowTitle) {
  if (!windowTitle) {
    return "";
  }

  const match = windowTitle.match(
    /([^\s/\\]+\.(js|ts|tsx|jsx|json|md|txt|py|go|java|html|css|csv|xlsx|docx|pptx))/i
  );

  return match ? match[1] : "";
}

function sampleFrontmostWindow() {
  if (process.platform !== "darwin") {
    return;
  }

  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set windowTitle to ""
  try
    tell process frontApp
      if exists (front window) then
        set windowTitle to name of front window
      end if
    end tell
  end try
end tell
return frontApp & "||" & windowTitle
`;

  execFile("osascript", ["-e", script], (error, stdout) => {
    if (error) {
      return;
    }

    const output = String(stdout || "").trim();
    if (!output) {
      return;
    }

    const [appName = "", windowTitle = ""] = output.split("||");
    const fingerprint = `${appName}::${windowTitle}`;
    const now = Date.now();

    if (fingerprint === lastFocusFingerprint && now - lastFocusAt < WINDOW_SAMPLER_INTERVAL_MS) {
      return;
    }

    lastFocusFingerprint = fingerprint;
    lastFocusAt = now;

    logEvent("app.focus", {
      appName,
      windowTitle,
      candidateFileName: inferCandidateFileName(windowTitle)
    });
  });
}

function startWindowSampler() {
  if (process.platform !== "darwin") {
    return;
  }

  sampleFrontmostWindow();
  setInterval(sampleFrontmostWindow, WINDOW_SAMPLER_INTERVAL_MS);
}

function startFileWatcher() {
  watcher = chokidar.watch(WATCH_PATHS, {
    ignored: shouldIgnore,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  watcher.on("error", (error) => {
    console.error("File watcher error:", error.message || error);
  });

  watcher.on("all", (eventName, targetPath) => {
    if (shouldIgnore(targetPath)) {
      return;
    }

    const eventTypeMap = {
      add: "file.created",
      change: "file.changed",
      unlink: "file.deleted",
      addDir: "directory.created",
      unlinkDir: "directory.deleted"
    };

    const type = eventTypeMap[eventName];
    if (!type) {
      return;
    }

    logEvent(type, {
      action: eventName,
      path: targetPath,
      ext: path.extname(targetPath),
      baseName: path.basename(targetPath)
    });
  });
}

function sanitizeNotificationText(input, fallback = "") {
  return maskSensitiveSegments(String(input || fallback || ""))
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function sendMacNotification({ title, subtitle, body }) {
  if (process.platform !== "darwin") {
    return;
  }

  const script = `
display notification "${sanitizeNotificationText(body)}" with title "${sanitizeNotificationText(
    title
  )}" subtitle "${sanitizeNotificationText(subtitle)}"
`;

  execFile("osascript", ["-e", script], () => {
    // Ignore notification failures so monitoring keeps running.
  });
}

function emitCodexCompletion(notification) {
  const existing = safeReadEvents().some(
    (event) =>
      event.type === "codex.task.completed" &&
      event.payload?.completionLogId === notification.completionLogId
  );

  if (existing) {
    return null;
  }

  const event = logEvent(
    "codex.task.completed",
    {
      completionLogId: notification.completionLogId,
      completionSource: "turn-completed",
      completionScope: "thread-turn",
      processUuid: notification.processUuid,
      threadId: notification.threadId,
      title: notification.promptText,
      promptText: notification.promptText,
      threadTitle: notification.threadTitle,
      cwd: notification.cwd,
      status: notification.status || "completed"
    },
    "codex",
    notification.completedAt
  );

  codexMonitorState.lastTaskAt = event.occurredAt;
  codexMonitorState.lastTaskTitle = notification.promptText || notification.threadTitle;
  codexMonitorState.lastTaskThreadId = notification.threadId;
  persistCodexMonitorState();

  sendMacNotification({
    title: "任务完成",
    subtitle: "Codex",
    body: `提示词：${notification.promptText || notification.threadTitle || "未识别到提示词"}${
      notification.cwd ? `\n工作区：${notification.cwd}` : ""
    }`
  });

  return event;
}

async function sqliteSingleLine(databasePath, query) {
  const output = await execFileText("sqlite3", ["-json", databasePath, query]);
  const rows = JSON.parse(output || "[]");
  return rows[0] || null;
}

async function lookupThreadIdByProcessUuidAtLog(processUuid, maxLogId) {
  const row = await sqliteSingleLine(
    CODEX_LOGS_DB,
    `
      SELECT thread_id
      FROM logs
      WHERE process_uuid = ${sqliteQuote(processUuid)}
        AND thread_id IS NOT NULL
        AND id <= ${Number(maxLogId || 0)}
      ORDER BY id DESC
      LIMIT 1;
    `
  );

  return row?.thread_id || "";
}

async function lookupThreadMeta(threadId) {
  if (!threadId) {
    return null;
  }

  return sqliteSingleLine(
    CODEX_STATE_DB,
    `
      SELECT id, title, first_user_message, cwd, updated_at
      FROM threads
      WHERE id = ${sqliteQuote(threadId)}
      LIMIT 1;
    `
  );
}

async function initializeCodexMonitor() {
  if (!fs.existsSync(CODEX_LOGS_DB)) {
    codexMonitorState.initialized = true;
    codexMonitorState.lastSeenLogId = 0;
    codexMonitorState.lastSeenTurnCompletedLogId = 0;
    codexMonitorState.lastPollAt = new Date().toISOString();
    persistCodexMonitorState();
    return;
  }

  try {
    const responseRow = await sqliteSingleLine(
      CODEX_LOGS_DB,
      `
        SELECT COALESCE(MAX(id), 0) AS max_id
        FROM logs
        WHERE target = 'codex_api::sse::responses';
      `
    );
    const turnCompletedRow = await sqliteSingleLine(
      CODEX_LOGS_DB,
      `
        SELECT COALESCE(MAX(id), 0) AS max_id
        FROM logs
        WHERE target = 'codex_app_server::outgoing_message'
          AND feedback_log_body LIKE '%turn/completed%';
      `
    );

    if (!codexMonitorState.initialized) {
      codexMonitorState.lastSeenLogId = Number(responseRow?.max_id || 0);
      codexMonitorState.lastSeenTurnCompletedLogId = Number(turnCompletedRow?.max_id || 0);
    } else if (
      !Number.isFinite(Number(codexMonitorState.lastSeenTurnCompletedLogId)) ||
      Number(codexMonitorState.lastSeenTurnCompletedLogId) <= 0
    ) {
      codexMonitorState.lastSeenTurnCompletedLogId = Number(turnCompletedRow?.max_id || 0);
    }
  } catch {
    codexMonitorState.lastSeenLogId = 0;
    codexMonitorState.lastSeenTurnCompletedLogId = 0;
  }

  codexMonitorState.initialized = true;
  codexMonitorState.lastPollAt = new Date().toISOString();
  persistCodexMonitorState();
}

async function lookupPromptTextForTurn(processUuid, threadId, maxLogId) {
  const threadFilter = threadId ? `AND thread_id = ${sqliteQuote(threadId)}` : "";
  const row = await sqliteSingleLine(
    CODEX_LOGS_DB,
    `
      SELECT feedback_log_body
      FROM logs
      WHERE process_uuid = ${sqliteQuote(processUuid)}
        AND target = 'codex_core::codex'
        ${threadFilter}
        AND id <= ${Number(maxLogId || 0)}
        AND feedback_log_body LIKE '%op: UserInput%'
      ORDER BY id DESC
      LIMIT 1;
    `
  );

  const body = String(row?.feedback_log_body || "");
  const match = body.match(/text: "((?:\\.|[^"])*)"/);

  if (!match?.[1]) {
    return "";
  }

  try {
    return JSON.parse(`"${match[1]}"`).trim();
  } catch {
    return match[1].replaceAll("\\n", "\n").trim();
  }
}

async function isInterruptedTurnCompletion(processUuid, threadId, completionLogId, completionTs) {
  const filters = [
    `process_uuid = ${sqliteQuote(processUuid)}`,
    `id BETWEEN ${Math.max(0, Number(completionLogId || 0) - 50)} AND ${Number(completionLogId || 0) + 5}`,
    `ts BETWEEN ${Math.max(0, Number(completionTs || 0) - 2)} AND ${Number(completionTs || 0) + 2}`,
    `(feedback_log_body LIKE '%op.dispatch.interrupt%' OR feedback_log_body LIKE '%aborting running task%')`
  ];

  if (threadId) {
    filters.push(`thread_id = ${sqliteQuote(threadId)}`);
  }

  const row = await sqliteSingleLine(
    CODEX_LOGS_DB,
    `
      SELECT id
      FROM logs
      WHERE ${filters.join("\n        AND ")}
      ORDER BY id DESC
      LIMIT 1;
    `
  );

  return Boolean(row?.id);
}

function readCodexHistoryEntries() {
  if (!fs.existsSync(CODEX_HISTORY_FILE)) {
    return [];
  }

  try {
    return fs
      .readFileSync(CODEX_HISTORY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && typeof entry.text === "string" && entry.text.trim());
  } catch {
    return [];
  }
}

function historyEntryKey(entry) {
  return `${entry.session_id || "unknown"}:${entry.ts || 0}:${entry.text || ""}`;
}

function shouldImportHistoryEntry(entry) {
  const text = String(entry.text || "").trim();

  if (!text) {
    return false;
  }

  if (text.startsWith("• Ran ") || text.startsWith("• Explored")) {
    return false;
  }

  if (text.includes("ctrl + t to view transcript")) {
    return false;
  }

  return true;
}

function importPromptEntry(entry, source = "codex-history") {
  const historyKey = historyEntryKey(entry);

  return logEvent(
    "prompt.entry",
    {
      text: String(entry.text || "").trim(),
      tool: "Codex",
      tags: ["codex-auto"],
      sessionId: entry.session_id || "",
      historyKey
    },
    source,
    entry.ts ? new Date(Number(entry.ts) * 1000).toISOString() : new Date().toISOString()
  );
}

function initializePromptHistoryBackfill() {
  if (codexMonitorState.promptInitialized) {
    return;
  }

  const existingPromptKeys = getExistingPromptKeys();
  const entries = readCodexHistoryEntries()
    .filter(shouldImportHistoryEntry)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-80);

  for (const entry of entries) {
    const historyKey = historyEntryKey(entry);

    if (existingPromptKeys.has(historyKey)) {
      rememberPromptKey(historyKey);
      continue;
    }

    importPromptEntry(entry);
    rememberPromptKey(historyKey);
    codexMonitorState.lastPromptTs = Math.max(
      Number(codexMonitorState.lastPromptTs || 0),
      Number(entry.ts || 0)
    );
  }

  codexMonitorState.promptInitialized = true;
  persistCodexMonitorState();
}

function readCodexGlobalPromptHistory() {
  if (!fs.existsSync(CODEX_GLOBAL_STATE_FILE)) {
    return [];
  }

  try {
    const payload = JSON.parse(fs.readFileSync(CODEX_GLOBAL_STATE_FILE, "utf8"));
    const history = payload?.["electron-persisted-atom-state"]?.["prompt-history"];
    return Array.isArray(history) ? history.filter((item) => typeof item === "string" && item.trim()) : [];
  } catch {
    return [];
  }
}

function pollCodexGlobalPromptHistory() {
  const prompts = readCodexGlobalPromptHistory().slice(-60);
  const existingPromptKeys = getExistingPromptKeys();
  const occurredAt = new Date().toISOString();

  for (const text of prompts) {
    const entry = {
      session_id: "global-state",
      ts: Math.floor(Date.now() / 1000),
      text
    };
    const historyKey = `global:${text}`;

    if (existingPromptKeys.has(historyKey) || hasSeenPromptKey(historyKey)) {
      continue;
    }

    logEvent(
      "prompt.entry",
      {
        text: String(text).trim(),
        tool: "Codex",
        tags: ["codex-auto", "global-state"],
        sessionId: "global-state",
        historyKey
      },
      "codex-history",
      occurredAt
    );
    rememberPromptKey(historyKey);
  }

  persistCodexMonitorState();
}

function pollCodexPromptHistory() {
  if (!fs.existsSync(CODEX_HISTORY_FILE)) {
    pollCodexGlobalPromptHistory();
    return;
  }

  initializePromptHistoryBackfill();

  const existingPromptKeys = getExistingPromptKeys();
  const entries = readCodexHistoryEntries()
    .filter(shouldImportHistoryEntry)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  for (const entry of entries) {
    const entryTs = Number(entry.ts || 0);
    const historyKey = historyEntryKey(entry);

    if (entryTs < Number(codexMonitorState.lastPromptTs || 0)) {
      continue;
    }

    if (existingPromptKeys.has(historyKey) || hasSeenPromptKey(historyKey)) {
      codexMonitorState.lastPromptTs = Math.max(
        Number(codexMonitorState.lastPromptTs || 0),
        entryTs
      );
      continue;
    }

    importPromptEntry(entry);
    rememberPromptKey(historyKey);
    codexMonitorState.lastPromptTs = Math.max(
      Number(codexMonitorState.lastPromptTs || 0),
      entryTs
    );
  }

  persistCodexMonitorState();
  pollCodexGlobalPromptHistory();
}

async function pollCodexTaskCompletions() {
  if (codexPollInFlight) {
    return;
  }

  if (!fs.existsSync(CODEX_LOGS_DB) || !fs.existsSync(CODEX_STATE_DB)) {
    return;
  }

  codexPollInFlight = true;

  try {
    await initializeCodexMonitor();

    const query = `
      SELECT id, ts, process_uuid, feedback_log_body
      FROM logs
      WHERE target = 'codex_app_server::outgoing_message'
        AND id > ${Number(codexMonitorState.lastSeenTurnCompletedLogId || 0)}
        AND feedback_log_body LIKE '%turn/completed%'
      ORDER BY id ASC
      LIMIT 100;
    `;

    const rows = JSON.parse(await execFileText("sqlite3", ["-json", CODEX_LOGS_DB, query]) || "[]");
    let maxSeenLogId = Number(codexMonitorState.lastSeenTurnCompletedLogId || 0);

    for (const row of rows) {
      const rowId = Number(row.id || 0);
      if (rowId > maxSeenLogId) {
        maxSeenLogId = rowId;
      }

      const threadId = await lookupThreadIdByProcessUuidAtLog(row.process_uuid, rowId);
      if (!threadId) {
        continue;
      }

      if (await isInterruptedTurnCompletion(row.process_uuid, threadId, rowId, row.ts)) {
        continue;
      }

      const threadMeta = await lookupThreadMeta(threadId);
      if (!threadMeta?.id || !String(threadMeta.title || "").trim()) {
        continue;
      }

      const promptText =
        (await lookupPromptTextForTurn(row.process_uuid, threadId, rowId)) ||
        String(threadMeta?.title || threadMeta?.first_user_message || "Codex 任务").trim();

      emitCodexCompletion({
        completionLogId: rowId,
        processUuid: row.process_uuid || "",
        threadId,
        promptText,
        threadTitle: threadMeta?.title || "",
        cwd: threadMeta?.cwd || "",
        status: "completed",
        completedAt: new Date(Number(row.ts || Date.now() / 1000) * 1000).toISOString()
      });
    }

    codexMonitorState.lastSeenTurnCompletedLogId = maxSeenLogId;
    codexMonitorState.lastPollAt = new Date().toISOString();
    persistCodexMonitorState();
  } catch (error) {
    codexMonitorState.lastPollAt = new Date().toISOString();
    persistCodexMonitorState();
    console.error("Codex task monitor poll failed:", error.message || error);
  } finally {
    codexPollInFlight = false;
  }
}

function startCodexTaskMonitor() {
  initializePromptHistoryBackfill();
  pollCodexPromptHistory();
  pollCodexTaskCompletions();
  codexPollTimer = setInterval(() => {
    pollCodexPromptHistory();
    pollCodexTaskCompletions();
  }, CODEX_POLL_INTERVAL_MS);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    monitorRoot: MONITOR_ROOT,
    defaultMonitorRoot: DEFAULT_MONITOR_ROOT,
    watchPaths: WATCH_PATHS,
    windowSamplerEnabled: process.platform === "darwin",
    codexMonitorEnabled: fs.existsSync(CODEX_LOGS_DB) && fs.existsSync(CODEX_STATE_DB),
    codexPollIntervalMs: CODEX_POLL_INTERVAL_MS,
    codexHistoryEnabled: fs.existsSync(CODEX_HISTORY_FILE),
    terminalHookSource: TERMINAL_HOOK_SOURCE
  });
});

app.get("/api/system-metrics", async (req, res) => {
  const date = targetDateFromQuery(req.query.date);

  try {
    res.json(await getSystemMetrics(date));
  } catch (error) {
    res.status(500).json({
      error: "system metrics unavailable",
      detail: error.message || String(error)
    });
  }
});

app.get("/api/dashboard", (req, res) => {
  const date = targetDateFromQuery(req.query.date);
  const project = normalizeFilterInput(req.query.project);
  const keyword = normalizeFilterInput(req.query.keyword);
  const eventType = normalizeFilterInput(req.query.eventType);
  const sourceEvents = filterEventsByDate(safeReadEvents(), date);
  const events = applyEventFilters(sourceEvents, { project, keyword, eventType });
  res.json(
    summarizeEvents(events, date, {
      sourceEvents,
      project,
      keyword,
      eventType
    })
  );
});

app.get("/api/prompt-insights", (req, res) => {
  const date = targetDateFromQuery(req.query.date);
  const project = normalizeFilterInput(req.query.project);
  const keyword = normalizeFilterInput(req.query.keyword);
  const eventType = normalizeFilterInput(req.query.eventType);
  const events = applyEventFilters(filterEventsByDate(safeReadEvents(), date), {
    project,
    keyword,
    eventType
  });
  res.json(summarizePromptInsights(events, date));
});

app.get("/api/events", (req, res) => {
  const date = targetDateFromQuery(req.query.date);
  const type = req.query.type;
  const project = normalizeFilterInput(req.query.project);
  const keyword = normalizeFilterInput(req.query.keyword);
  const eventType = normalizeFilterInput(req.query.eventType);
  const limit = Math.min(Number(req.query.limit || 200), 500);
  let events = applyEventFilters(filterEventsByDate(safeReadEvents(), date), {
    project,
    keyword,
    eventType
  });

  if (type) {
    events = events.filter((event) => event.type === type);
  }

  if (type === "codex.task.completed") {
    events = events.filter(isVisibleCodexTaskEvent);
  }

  res.json(
    events
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit)
  );
});

app.get("/api/export", (req, res) => {
  const date = targetDateFromQuery(req.query.date);
  const project = normalizeFilterInput(req.query.project);
  const keyword = normalizeFilterInput(req.query.keyword);
  const eventType = normalizeFilterInput(req.query.eventType);
  const sourceEvents = filterEventsByDate(safeReadEvents(), date);
  const events = applyEventFilters(sourceEvents, { project, keyword, eventType }).sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt)
  );
  const summary = summarizeEvents(events, date, {
    sourceEvents,
    project,
    keyword,
    eventType
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="activity-export-${date}.json"`
  );
  res.send(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        filters: {
          date,
          project,
          keyword,
          eventType
        },
        summary,
        events
      },
      null,
      2
    )
  );
});

app.get("/api/codex/status", (_req, res) => {
  const recentTasks = getRecentCodexTaskEvents(10);
  const latestTask = recentTasks[0] || null;

  res.json({
    enabled: fs.existsSync(CODEX_LOGS_DB) && fs.existsSync(CODEX_STATE_DB),
    logsDb: CODEX_LOGS_DB,
    stateDb: CODEX_STATE_DB,
    historyFile: CODEX_HISTORY_FILE,
    pollIntervalMs: CODEX_POLL_INTERVAL_MS,
    settleMs: CODEX_TASK_SETTLE_MS,
    lastPollAt: codexMonitorState.lastPollAt || null,
    lastTaskAt: latestTask?.occurredAt || null,
    lastTaskTitle: latestTask?.payload?.promptText || latestTask?.payload?.title || "",
    tasks: recentTasks
  });
});

app.post("/api/events", (req, res) => {
  const { type, payload, source, occurredAt } = req.body || {};

  if (!type || typeof type !== "string") {
    return res.status(400).json({ error: "type is required" });
  }

  const finalPayload =
    type === "terminal.command"
      ? {
          ...payload,
          fileTargets: maybeExtractFileTargets(payload?.command || "")
        }
      : payload || {};

  const event = logEvent(type, finalPayload, source || "manual", occurredAt);
  return res.status(201).json(event);
});

app.post("/api/prompts", (req, res) => {
  const { text, tool, tags } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text is required" });
  }

  const event = logEvent("prompt.entry", {
    text,
    tool: tool || "manual",
    tags: Array.isArray(tags) ? tags : []
  });

  return res.status(201).json(event);
});

app.post("/api/codex/test-notification", (_req, res) => {
  const event = logEvent("codex.task.completed", {
    completionLogId: `manual-test-${Date.now()}`,
    completionSource: "turn-completed",
    completionScope: "thread-turn",
    processUuid: "manual-test",
    threadId: "manual-test",
    title: "测试任务：Codex 通知链路",
    promptText: "测试任务：Codex 通知链路",
    threadTitle: "测试任务：Codex 通知链路",
    cwd: APP_DIR,
    status: "completed"
  }, "manual");

  codexMonitorState.lastTaskAt = event.occurredAt;
  codexMonitorState.lastTaskTitle = event.payload.title;
  codexMonitorState.lastTaskThreadId = event.payload.threadId;
  persistCodexMonitorState();

  sendMacNotification({
    title: "任务完成",
    subtitle: "Codex",
    body: `提示词：测试任务：Codex 通知链路\n工作区：${APP_DIR}`
  });

  res.status(201).json(event);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

startFileWatcher();
startWindowSampler();
startCodexTaskMonitor();

app.listen(PORT, () => {
  console.log(`Activity monitor running at http://127.0.0.1:${PORT}`);
  console.log(`Watching: ${WATCH_PATHS.join(", ")}`);
});
