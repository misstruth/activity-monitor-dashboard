const state = {
  date: new Date().toISOString().slice(0, 10),
  project: "",
  eventType: "",
  keyword: "",
  hasLoadedOnce: false,
  notifiedTaskIds: new Set(),
  expandedSections: {}
};

const dateInput = document.getElementById("dateInput");
const projectFilter = document.getElementById("projectFilter");
const eventTypeFilter = document.getElementById("eventTypeFilter");
const keywordFilter = document.getElementById("keywordFilter");
const exportButton = document.getElementById("exportButton");
const clearFiltersButton = document.getElementById("clearFiltersButton");
const filterHint = document.getElementById("filterHint");
const refreshButton = document.getElementById("refreshButton");
const notificationPermissionButton = document.getElementById("notificationPermissionButton");
const testNotificationButton = document.getElementById("testNotificationButton");
const promptForm = document.getElementById("promptForm");
const promptText = document.getElementById("promptText");
const promptTool = document.getElementById("promptTool");
const codexStatusCard = document.getElementById("codexStatusCard");
const toastStack = document.getElementById("toastStack");
const promptInsightsSummary = document.getElementById("promptInsightsSummary");
const promptInsightsList = document.getElementById("promptInsightsList");
const systemMetricsAt = document.getElementById("systemMetricsAt");
const systemMetricsGrid = document.getElementById("systemMetricsGrid");
const collectorStatusList = document.getElementById("collectorStatusList");
const systemTopLists = document.getElementById("systemTopLists");
const dailyDigest = document.getElementById("dailyDigest");
const insightsGrid = document.getElementById("insightsGrid");
const PREVIEW_LIMITS = {
  topFiles: 4,
  tasksList: 3,
  commandsList: 4,
  promptsList: 4,
  promptInsightsList: 3,
  focusList: 4,
  filesList: 4,
  timelineList: 8
};

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function escapeHtml(input = "") {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = bytes;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  const digits = current >= 100 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

function formatPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return "-";
  }

  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

function formatPaths(paths = []) {
  return paths.length ? paths.join("<br />") : "未配置";
}

function truncateText(input = "", limit = 120) {
  const text = String(input || "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildDashboardQuery() {
  const params = new URLSearchParams({ date: state.date });

  if (state.project) {
    params.set("project", state.project);
  }

  if (state.eventType) {
    params.set("eventType", state.eventType);
  }

  if (state.keyword) {
    params.set("keyword", state.keyword);
  }

  return params.toString();
}

function renderStats(summary) {
  const statsGrid = document.getElementById("statsGrid");
  const cards = [
    { label: "今日事件总数", value: summary.totals.all },
    { label: "文件活动", value: summary.totals.fileActivity },
    { label: "终端命令", value: summary.totals.commands },
    { label: "Codex 完成任务", value: summary.totals.completedTasks },
    { label: "提示词记录", value: summary.totals.prompts }
  ];

  statsGrid.innerHTML = cards
    .map(
      (card) => `
        <article class="stat-card">
          <div class="stat-label">${escapeHtml(card.label)}</div>
          <div class="stat-value">${escapeHtml(card.value)}</div>
        </article>
      `
    )
    .join("");
}

function renderFilters(summary) {
  const projects = summary?.availableProjects || [];
  const eventTypes = summary?.availableEventTypes || [];
  const projectOptions = [
    `<option value="">全部项目</option>`,
    ...projects.map(
      (item) =>
        `<option value="${escapeHtml(item.key)}" ${
          item.key === state.project ? "selected" : ""
        }>${escapeHtml(item.label)} (${escapeHtml(item.count)})</option>`
    )
  ];
  const eventTypeOptions = [
    `<option value="">全部事件类型</option>`,
    ...eventTypes.map(
      (item) =>
        `<option value="${escapeHtml(item.type)}" ${
          item.type === state.eventType ? "selected" : ""
        }>${escapeHtml(item.label)} (${escapeHtml(item.count)})</option>`
    )
  ];

  projectFilter.innerHTML = projectOptions.join("");
  eventTypeFilter.innerHTML = eventTypeOptions.join("");
  keywordFilter.value = state.keyword;

  const scopeParts = [];
  if (summary?.activeFilters?.projectLabel) {
    scopeParts.push(`项目：${summary.activeFilters.projectLabel}`);
  }
  if (summary?.activeFilters?.eventTypeLabel) {
    scopeParts.push(`事件：${summary.activeFilters.eventTypeLabel}`);
  }
  if (summary?.activeFilters?.keyword) {
    scopeParts.push(`关键词：${summary.activeFilters.keyword}`);
  }

  filterHint.textContent = scopeParts.length
    ? `当前筛选：${scopeParts.join(" / ")}`
    : "当前展示全部记录";
}

function renderDailyDigest(summary) {
  const digest = summary?.digest || {};
  const bullets = digest?.bullets || [];
  const projects = digest?.projects || [];

  dailyDigest.innerHTML = `
    <article class="digest-card digest-main">
      <div class="digest-headline">${escapeHtml(digest.headline || "今天还没有可总结的活动。")}</div>
      <div class="digest-bullets">
        ${bullets
          .map((item) => `<div class="digest-bullet">${escapeHtml(item)}</div>`)
          .join("")}
      </div>
    </article>
    <article class="digest-card">
      <div class="digest-card-title">项目分布</div>
      <div class="digest-project-list">
        ${
          projects.length
            ? projects
                .map(
                  (item) => `
                    <div class="digest-project-row">
                      <div class="digest-project-name">${escapeHtml(item.label)}</div>
                      <div class="digest-project-count">${escapeHtml(item.count)}</div>
                    </div>
                  `
                )
                .join("")
            : `<div class="empty-state compact">当前筛选下还没有明确的项目分布。</div>`
        }
      </div>
    </article>
  `;
}

function renderInsights(summary) {
  const insights = summary?.insights || [];

  if (!insights.length) {
    insightsGrid.innerHTML = `<div class="empty-state">当前筛选下还没有足够的数据生成工作洞察。</div>`;
    return;
  }

  insightsGrid.innerHTML = insights
    .map(
      (item) => `
        <article class="insight-card">
          <div class="insight-label">${escapeHtml(item.title || "")}</div>
          <div class="insight-value">${escapeHtml(item.value || "-")}</div>
          <div class="insight-detail">${escapeHtml(item.detail || "")}</div>
        </article>
      `
    )
    .join("");
}

function renderSystemMetrics(metrics) {
  const cpu = metrics?.cpu || {};
  const memory = metrics?.memory || {};
  const disk = metrics?.disk || {};
  const collectors = metrics?.collectors || {};

  systemMetricsAt.textContent = metrics?.capturedAt
    ? `更新时间：${formatDateTime(metrics.capturedAt)}`
    : "";

  const cards = [
    {
      label: "CPU",
      value: formatPercent(cpu.usagePercent),
      detail: `1 分钟负载 ${escapeHtml(cpu.loadAverage1m ?? "-")} / ${escapeHtml(cpu.cores ?? "-")} 核`,
      tone: Number(cpu.usagePercent || 0) >= 80 ? "warn" : ""
    },
    {
      label: "内存",
      value: formatPercent(memory.usagePercent),
      detail: `${escapeHtml(formatBytes(memory.usedBytes || 0))} / ${escapeHtml(
        formatBytes(memory.totalBytes || 0)
      )}`,
      tone: Number(memory.usagePercent || 0) >= 85 ? "warn" : ""
    },
    {
      label: "磁盘",
      value: formatPercent(disk.usagePercent),
      detail: disk?.totalBytes
        ? `${escapeHtml(formatBytes(disk.usedBytes || 0))} / ${escapeHtml(
            formatBytes(disk.totalBytes || 0)
          )}`
        : "暂时无法读取",
      tone: Number(disk.usagePercent || 0) >= 90 ? "warn" : ""
    }
  ];

  systemMetricsGrid.innerHTML = cards
    .map(
      (card) => `
        <article class="resource-card ${card.tone}">
          <div class="resource-label">${escapeHtml(card.label)}</div>
          <div class="resource-value">${escapeHtml(card.value)}</div>
          <div class="resource-detail">${card.detail}</div>
        </article>
      `
    )
    .join("");

  const terminalStatusLabel = collectors.terminalHookActive
    ? "最近有命令写入"
    : collectors.terminalHookInstalled
      ? "已安装，最近未采到命令"
      : "还没接入 shell hook";

  const terminalStatusBody = collectors.terminalHookInstalled
    ? `最近命令：${escapeHtml(collectors.lastCommand || "今天还没有命令")}`
    : `请执行：<code>${escapeHtml(collectors.terminalHookSourceCommand || "")}</code><br />或把它加入 <code>~/.zshrc</code>`;

  collectorStatusList.innerHTML = `
    <article class="status-block">
      <div class="item-head">
        <div class="item-title">文件监听</div>
        <div class="badge">${escapeHtml(String(collectors.todayFileEvents || 0))} 条</div>
      </div>
      <div class="item-body">监听范围：${formatPaths(collectors.watchPaths || [])}</div>
      <div class="item-tags">${
        collectors.lastFileEventAt
          ? `最近文件事件：${escapeHtml(formatDateTime(collectors.lastFileEventAt))}<br />${escapeHtml(
              collectors.lastFilePath || ""
            )}`
          : "今天还没有采到新的文件变更。现在默认会盯住你最近活跃的桌面项目目录，后续新改动会自动进来。"
      }</div>
    </article>
    <article class="status-block">
      <div class="item-head">
        <div class="item-title">终端命令采集</div>
        <div class="badge">${escapeHtml(terminalStatusLabel)}</div>
      </div>
      <div class="item-body">${terminalStatusBody}</div>
      <div class="item-tags">${
        collectors.lastCommandAt
          ? `最后一条：${escapeHtml(formatDateTime(collectors.lastCommandAt))}`
          : "还没有命令事件，接入后这里会显示最近一条命令。"
      }</div>
    </article>
    <article class="status-block">
      <div class="item-head">
        <div class="item-title">磁盘挂载点</div>
        <div class="badge">${escapeHtml(disk.mountPoint || "-")}</div>
      </div>
      <div class="item-body">监控根目录：${escapeHtml(collectors.monitorRoot || "-")}</div>
      <div class="item-tags">${
        disk.filesystem
          ? `设备：${escapeHtml(disk.filesystem)}`
          : "磁盘信息读取失败时，这里会显示为空。"
      }</div>
    </article>
  `;

  const topGroups = [
    {
      title: "CPU 占用前几项",
      items: cpu.top || [],
      emptyText: "暂时没有拿到 CPU 进程排行。",
      badgeKey: "cpuPercent",
      badgeFormatter: (item) => formatPercent(item.cpuPercent),
      detailBuilder: (item) => `PID ${escapeHtml(item.pid ?? "-")}`
    },
    {
      title: "内存占用前几项",
      items: memory.top || [],
      emptyText: "暂时没有拿到内存进程排行。",
      badgeKey: "memoryPercent",
      badgeFormatter: (item) => formatPercent(item.memoryPercent),
      detailBuilder: (item) => `PID ${escapeHtml(item.pid ?? "-")}`
    },
    {
      title: "磁盘占用前几项",
      items: disk.top || [],
      emptyText: "暂时没有拿到磁盘占用排行。",
      badgeKey: "sizeBytes",
      badgeFormatter: (item) => formatBytes(item.sizeBytes || 0),
      detailBuilder: (item) => `${item.kind === "directory" ? "目录" : "文件"} · ${escapeHtml(
        truncateText(item.path || "", 96)
      )}`
    }
  ];

  systemTopLists.innerHTML = topGroups
    .map((group) => {
      const rows = (group.items || []).length
        ? (group.items || [])
            .map((item, index) => {
              const badgeValue = group.badgeFormatter
                ? group.badgeFormatter(item)
                : escapeHtml(String(item[group.badgeKey] || "-"));

              return `
                <div class="top-row">
                  <div class="top-rank">${index + 1}</div>
                  <div class="top-content">
                    <div class="top-title">${escapeHtml(
                      truncateText(item.label || item.name || item.path || "未命名项", 96)
                    )}</div>
                    <div class="top-detail">${group.detailBuilder(item)}</div>
                  </div>
                  <div class="top-badge">${escapeHtml(badgeValue)}</div>
                </div>
              `;
            })
            .join("")
        : `<div class="empty-state compact">${escapeHtml(group.emptyText)}</div>`;

      return `
        <article class="top-card">
          <div class="top-card-title">${escapeHtml(group.title)}</div>
          <div class="top-list">${rows}</div>
        </article>
      `;
    })
    .join("");
}

function renderHourly(summary) {
  const healthLabel = document.getElementById("healthLabel");
  const hourlyChart = document.getElementById("hourlyChart");
  const max = Math.max(...summary.hourly.map((item) => item.count), 1);

  healthLabel.textContent = `监控日期：${summary.date}`;
  hourlyChart.innerHTML = summary.hourly
    .map((item) => {
      const height = Math.max(10, Math.round((item.count / max) * 180));
      return `
        <div class="chart-bar-wrap" title="${item.hour}:00 - ${item.count} 次">
          <div class="chart-bar" style="height:${height}px"></div>
          <div class="chart-hour">${String(item.hour).padStart(2, "0")}</div>
        </div>
      `;
    })
    .join("");
}

function renderEmpty(targetId, text) {
  document.getElementById(targetId).innerHTML = `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function isSectionExpanded(targetId) {
  return Boolean(state.expandedSections[targetId]);
}

function renderExpandableContent(targetId, items, builder, emptyText, previewCount) {
  if (!items.length) {
    return renderEmpty(targetId, emptyText);
  }

  const expanded = isSectionExpanded(targetId);
  const visibleItems = expanded ? items : items.slice(0, previewCount);
  const shouldShowToggle = items.length > previewCount;

  document.getElementById(targetId).innerHTML = `
    <div class="list-preview">
      ${visibleItems.map(builder).join("")}
    </div>
    ${
      shouldShowToggle
        ? `<button class="list-toggle-button" type="button" data-target-id="${escapeHtml(
            targetId
          )}">${expanded ? "收起" : `查看全部 (${items.length})`}</button>`
        : ""
    }
  `;
}

function renderTopFiles(summary) {
  renderExpandableContent(
    "topFiles",
    summary.topFiles || [],
    (item) => `
        <div class="item-card">
          <div class="item-head">
            <div class="item-title">${escapeHtml(item.target)}</div>
            <div class="badge">${item.count} 次</div>
          </div>
        </div>
      `,
    "还没有高频文件数据，等采集器开始记录后这里会自动出现。",
    PREVIEW_LIMITS.topFiles
  );
}

function renderPromptInsights(insights) {
  const habits = insights?.habits || [];
  const examples = insights?.examples || [];

  promptInsightsSummary.innerHTML = habits
    .map(
      (habit) => `
        <div class="coach-card">
          <div class="coach-title">${escapeHtml(habit.title || "")}</div>
          <div class="coach-detail">${escapeHtml(habit.detail || "")}</div>
        </div>
      `
    )
    .join("");

  if (!examples.length) {
    return renderEmpty(
      "promptInsightsList",
      "今天暂时没有明显需要优化的提示词。继续保持“对象 + 动作 + 输出格式”这三个元素就很好。"
    );
  }

  renderExpandableContent(
    "promptInsightsList",
    examples,
    (item) => `
        <div class="item-card">
          <div class="item-head">
            <div class="item-title">${escapeHtml(item.promptText || "")}</div>
            <div class="item-meta">${formatDateTime(item.occurredAt)}</div>
          </div>
          <div class="issue-row">
            ${(item.issues || [])
              .map((issue) => `<span class="issue-chip">${escapeHtml(issue.label || "")}</span>`)
              .join("")}
          </div>
          <div class="coach-block">
            <div class="coach-label">为什么这句不够好</div>
            <div class="coach-value">${escapeHtml(
              (item.issues || []).map((issue) => issue.reason).join("；")
            )}</div>
          </div>
          <div class="coach-block">
            <div class="coach-label">你当时的上下文</div>
            <div class="coach-value">${escapeHtml(item.contextHint || "未识别到前文")}</div>
          </div>
          <div class="coach-block">
            <div class="coach-label">更好的写法</div>
            <div class="coach-value good">${escapeHtml(item.betterPrompt || "")}</div>
          </div>
        </div>
      `,
    "今天暂时没有明显需要优化的提示词。继续保持“对象 + 动作 + 输出格式”这三个元素就很好。",
    PREVIEW_LIMITS.promptInsightsList
  );
}

function renderEventList(targetId, events, builder, emptyText) {
  renderExpandableContent(
    targetId,
    events || [],
    builder,
    emptyText,
    PREVIEW_LIMITS[targetId] || 4
  );
}

function showToast(title, body) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-body">${escapeHtml(body)}</div>
  `;
  toastStack.prepend(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 5000);
}

function buildTaskPopupMessage(task) {
  const prompt =
    task?.payload?.promptText ||
    task?.payload?.title ||
    task?.payload?.threadTitle ||
    "未识别到提示词";
  const cwd = task?.payload?.cwd || "";
  return {
    title: "任务完成",
    body: `提示词：${prompt}${cwd ? `\n工作区：${cwd}` : ""}`
  };
}

function updateNotificationPermissionLabel() {
  if (!("Notification" in window)) {
    notificationPermissionButton.textContent = "当前浏览器不支持";
    notificationPermissionButton.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    notificationPermissionButton.textContent = "浏览器弹窗已开启";
    notificationPermissionButton.disabled = true;
    return;
  }

  notificationPermissionButton.textContent = "开启浏览器弹窗";
  notificationPermissionButton.disabled = false;
}

async function ensureBrowserNotifications() {
  if (!("Notification" in window)) {
    showToast("浏览器通知不可用", "当前浏览器不支持 Notification API。");
    updateNotificationPermissionLabel();
    return;
  }

  const permission = await Notification.requestPermission();
  updateNotificationPermissionLabel();

  if (permission === "granted") {
    showToast("浏览器弹窗已开启", "之后 Codex 任务完成时，这个页面会自动弹出提示。");
  }
}

function maybeNotifyCompletedTasks(summary) {
  const tasks = summary.tasks || [];

  for (const task of tasks) {
    if (!task?.id) {
      continue;
    }

    if (!state.hasLoadedOnce) {
      state.notifiedTaskIds.add(task.id);
      continue;
    }

    if (state.notifiedTaskIds.has(task.id)) {
      continue;
    }

    state.notifiedTaskIds.add(task.id);
    const message = buildTaskPopupMessage(task);
    showToast(message.title, message.body);

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(message.title, {
        body: message.body
      });
    }
  }
}

function renderCodexStatus(status) {
  const enabledLabel = status.enabled ? "已开启" : "未开启";
  const lastTask = status.lastTaskAt
    ? `${status.lastTaskTitle || "最近任务"} · ${formatDateTime(status.lastTaskAt)}`
    : "还没有检测到新的 Codex 完成事件";

  codexStatusCard.innerHTML = `
    <div class="item-head">
      <div class="item-title">Codex 任务完成提醒</div>
      <div class="badge">${escapeHtml(enabledLabel)}</div>
    </div>
    <div class="status-grid">
      <div>
        <div class="status-label">轮询间隔</div>
        <div class="status-value">${escapeHtml(status.pollIntervalMs || "-")} ms</div>
      </div>
      <div>
        <div class="status-label">最近轮询</div>
        <div class="status-value">${escapeHtml(status.lastPollAt ? formatDateTime(status.lastPollAt) : "-")}</div>
      </div>
      <div>
        <div class="status-label">最近完成</div>
        <div class="status-value">${escapeHtml(lastTask)}</div>
      </div>
      <div>
        <div class="status-label">日志来源</div>
        <div class="status-value">${escapeHtml(status.logsDb || "-")}</div>
      </div>
    </div>
  `;
}

function renderTimeline(summary) {
  renderEventList(
    "tasksList",
    summary.tasks,
    (event) => `
      <div class="item-card">
        <div class="item-head">
          <div class="item-title">${escapeHtml(
            event.payload.promptText || event.payload.title || event.payload.threadTitle || "Codex 任务已完成"
          )}</div>
          <div class="item-meta">${formatDateTime(event.occurredAt)}</div>
        </div>
        <div class="item-body">${escapeHtml(event.payload.cwd || "未记录工作区")}</div>
        <div class="item-tags">线程：${escapeHtml(event.payload.threadId || "-")}，状态：${escapeHtml(event.payload.status || "completed")}</div>
      </div>
    `,
    "还没有新的 Codex 任务完成事件。下一次 Codex 回完一轮，这里会自动出现。"
  );

  renderEventList(
    "commandsList",
    summary.commands,
    (event) => `
      <div class="item-card">
        <div class="item-head">
          <div class="item-title">${escapeHtml(event.payload.command || "(空命令)")}</div>
          <div class="item-meta">${formatDateTime(event.occurredAt)}</div>
        </div>
        <div class="item-body">目录：${escapeHtml(event.payload.cwd || "-")}</div>
        <div class="item-tags">退出码：${escapeHtml(event.payload.exitCode ?? "-")}，耗时：${escapeHtml(event.payload.durationMs ?? "-")}ms</div>
      </div>
    `,
    "终端命令还没有接入。把 zsh 钩子脚本 source 进 ~/.zshrc 后，这里会开始出现数据。"
  );

  renderEventList(
    "promptsList",
    summary.prompts,
    (event) => `
      <div class="item-card">
        <div class="item-head">
          <div class="item-title">${escapeHtml(event.payload.tool || "manual")}</div>
          <div class="item-meta">${formatDateTime(event.occurredAt)}</div>
        </div>
        <div class="item-body">${escapeHtml(event.payload.text || "")}</div>
      </div>
    `,
    "这里会显示你手动记录或通过脚本写入的提示词。"
  );

  renderEventList(
    "focusList",
    summary.focus,
    (event) => `
      <div class="item-card">
        <div class="item-head">
          <div class="item-title">${escapeHtml(event.payload.appName || "未知应用")}</div>
          <div class="item-meta">${formatDateTime(event.occurredAt)}</div>
        </div>
        <div class="item-body">${escapeHtml(event.payload.windowTitle || "无窗口标题")}</div>
        ${
          event.payload.candidateFileName
            ? `<div class="item-tags">推测文件：${escapeHtml(event.payload.candidateFileName)}</div>`
            : ""
        }
      </div>
    `,
    "macOS 前台窗口采样还没有采到可展示的数据。"
  );

  renderEventList(
    "filesList",
    summary.files,
    (event) => `
      <div class="item-card">
        <div class="item-head">
          <div class="item-title">${escapeHtml(event.type)}</div>
          <div class="item-meta">${formatDateTime(event.occurredAt)}</div>
        </div>
        <div class="item-body">${escapeHtml(event.payload.path || "-")}</div>
      </div>
    `,
    "还没有目录变更记录。"
  );

  renderEventList(
    "timelineList",
    summary.timeline,
    (event) => `
      <div class="item-card">
        <div class="item-head">
          <div class="item-title">${escapeHtml(event.type)}</div>
          <div class="item-meta">${formatDateTime(event.occurredAt)}</div>
        </div>
        <div class="item-body">${escapeHtml(JSON.stringify(event.payload))}</div>
      </div>
    `,
    "时间线暂时为空。"
  );
}

async function loadSummary() {
  const query = buildDashboardQuery();
  const [summaryResponse, codexStatusResponse, promptInsightsResponse, systemMetricsResponse] = await Promise.all([
    fetch(`/api/dashboard?${query}`),
    fetch("/api/codex/status"),
    fetch(`/api/prompt-insights?${query}`),
    fetch(`/api/system-metrics?date=${encodeURIComponent(state.date)}`)
  ]);
  const summary = await summaryResponse.json();
  const codexStatus = await codexStatusResponse.json();
  const promptInsights = await promptInsightsResponse.json();
  const systemMetrics = await systemMetricsResponse.json();

  renderFilters(summary);
  renderStats(summary);
  renderDailyDigest(summary);
  renderInsights(summary);
  renderSystemMetrics(systemMetrics);
  renderHourly(summary);
  renderTopFiles(summary);
  renderCodexStatus(codexStatus);
  renderPromptInsights(promptInsights);
  renderTimeline(summary);
  maybeNotifyCompletedTasks(summary);
  state.hasLoadedOnce = true;
}

async function savePrompt(event) {
  event.preventDefault();

  const text = promptText.value.trim();
  const tool = promptTool.value.trim();

  if (!text) {
    promptText.focus();
    return;
  }

  await fetch("/api/prompts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text, tool: tool || "manual" })
  });

  promptText.value = "";
  promptTool.value = "";
  await loadSummary();
}

async function testNotification() {
  await fetch("/api/codex/test-notification", {
    method: "POST"
  });

  await loadSummary();
}

function exportCurrentView() {
  window.open(`/api/export?${buildDashboardQuery()}`, "_blank");
}

dateInput.value = state.date;
dateInput.addEventListener("change", async (event) => {
  state.date = event.target.value;
  await loadSummary();
});
projectFilter.addEventListener("change", async (event) => {
  state.project = event.target.value;
  await loadSummary();
});
eventTypeFilter.addEventListener("change", async (event) => {
  state.eventType = event.target.value;
  await loadSummary();
});

let keywordTimer = null;
keywordFilter.addEventListener("input", () => {
  window.clearTimeout(keywordTimer);
  keywordTimer = window.setTimeout(async () => {
    state.keyword = keywordFilter.value.trim();
    await loadSummary();
  }, 250);
});

clearFiltersButton.addEventListener("click", async () => {
  state.project = "";
  state.eventType = "";
  state.keyword = "";
  projectFilter.value = "";
  eventTypeFilter.value = "";
  keywordFilter.value = "";
  await loadSummary();
});
refreshButton.addEventListener("click", loadSummary);
exportButton.addEventListener("click", exportCurrentView);
notificationPermissionButton.addEventListener("click", ensureBrowserNotifications);
testNotificationButton.addEventListener("click", testNotification);
promptForm.addEventListener("submit", savePrompt);
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-target-id]");
  if (!button) {
    return;
  }

  const targetId = button.getAttribute("data-target-id");
  state.expandedSections[targetId] = !isSectionExpanded(targetId);
  await loadSummary();
});

updateNotificationPermissionLabel();
loadSummary();
setInterval(loadSummary, 5000);
