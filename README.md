# Activity Monitor Dashboard

一个本地运行的前后端监控面板，用来按天回看你的工作轨迹，重点覆盖：

- 文件活动：创建、修改、删除
- 终端命令：命令、目录、退出码、耗时
- 提示词记录：手动记录 + Codex 历史自动采集
- Codex 任务完成：线程级完成提醒 + 浏览器弹窗
- 系统资源：CPU、内存、磁盘占用，以及前几名进程/目录
- 工作洞察：今日总结、项目分布、最忙时段、最高频动作

项目是一个本地 `Express + 静态前端` 应用，不依赖云端服务。

## 1. 项目位置

```bash
/path/to/activity-monitor-dashboard
```

## 2. 安装

```bash
cd /path/to/activity-monitor-dashboard
npm install
```

## 3. 启动

```bash
npm run dev
```

启动后访问：

```bash
http://127.0.0.1:4321
```

## 4. 当前功能

### 4.1 每日操作监控面板

首页会展示：

- 今日事件总数
- 文件活动数
- 终端命令数
- Codex 完成任务数
- 提示词记录数

### 4.2 系统资源与采集状态

顶部主面板内会展示：

- CPU / 内存 / 磁盘总占用
- CPU 占用前几项
- 内存占用前几项
- 磁盘占用前几项
- 当前监听目录
- 文件监听状态
- 终端命令 hook 状态

### 4.3 智能筛选

支持：

- 按日期查看
- 按项目筛选
- 按事件类型筛选
- 按关键词搜索

筛选会联动整页，包括：

- 统计卡
- 今日总结
- 工作洞察
- 提示词优化建议
- 时间线 / 文件 / 命令 / 任务列表

### 4.4 今日总结

系统会自动总结：

- 当前筛选范围内的记录总量
- 今日完成了多少任务
- 最近文件变更
- 最近命令
- 最近提示词
- 当前项目分布

### 4.5 工作洞察

系统会给出一些直接可读的洞察，例如：

- 最忙时段
- 最高频动作
- 最活跃项目
- 最常驻应用
- 任务完成数
- 提示词密度

### 4.6 Prompt Coach

会自动分析最近提示词中常见的问题：

- 过短
- 对象不明确
- 缺少结果预期
- 上下文不足
- 敏感信息直写

并根据最近上下文给出更好的写法建议。

### 4.7 Codex 任务完成提醒

面板会自动轮询本机 Codex 状态库：

- `~/.codex/logs_2.sqlite`
- `~/.codex/state_5.sqlite`
- `~/.codex/history.jsonl`
- `~/.codex/.codex-global-state.json`

当 Codex 一个线程中的一轮任务完成时，系统会：

- 在面板里记录 `codex.task.completed`
- 触发浏览器 toast
- 如果浏览器通知已授权，会弹系统级浏览器通知

当前只对“线程级 turn completed”事件提醒，避免把线程中的每个小步骤都误判成完成。

### 4.8 数据导出

可以直接导出当前筛选结果，导出内容包括：

- 当前筛选条件
- 当前汇总 summary
- 当前匹配到的事件列表

导出接口：

```bash
GET /api/export
```

## 5. 终端命令监控接入

终端命令采集依赖 `zsh` hook。

把下面这行加入 `~/.zshrc`：

```bash
source /path/to/activity-monitor-dashboard/scripts/zsh-activity-hook.zsh
```

然后执行：

```bash
source ~/.zshrc
```

之后新的 `zsh` 命令会自动上报到面板。

## 6. 提示词记录方式

### 方式 A：网页手动记录

首页有“记录一条提示词”表单。

### 方式 B：命令行快速记录

```bash
/path/to/activity-monitor-dashboard/scripts/log-prompt.sh "帮我总结一下今天改了哪些接口"
```

### 方式 C：已接入 hook 后直接记录

```bash
track_prompt "帮我把这个页面改得更像数据驾驶舱"
```

### 方式 D：Codex 历史自动回填

系统会自动从本机 Codex 历史中抓取最近提示词，无需手动录入。

## 7. 默认监听范围

默认情况下，系统会优先监听你最近活跃的桌面项目目录，而不是递归扫描整个桌面。

这样做的目的是：

- 覆盖你最近实际在工作的项目
- 避免整个桌面递归监听导致 macOS `EMFILE` 报错

如果你想手动指定：

### 单目录

```bash
MONITOR_ROOT=/你的目录 npm run dev
```

### 多目录

```bash
WATCH_PATHS=/目录A,/目录B npm run dev
```

## 8. 关键接口

### 健康检查

```bash
GET /api/health
```

### 仪表盘汇总

```bash
GET /api/dashboard?date=2026-04-21
GET /api/dashboard?date=2026-04-21&project=/path/to/project
GET /api/dashboard?date=2026-04-21&eventType=file.changed&keyword=python
```

### 提示词优化建议

```bash
GET /api/prompt-insights?date=2026-04-21
```

### 事件流

```bash
GET /api/events?date=2026-04-21
GET /api/events?date=2026-04-21&type=terminal.command
```

### 系统资源

```bash
GET /api/system-metrics?date=2026-04-21
```

### Codex 状态

```bash
GET /api/codex/status
```

### 手动写事件

```bash
POST /api/events
```

### 手动写提示词

```bash
POST /api/prompts
```

### 测试任务完成通知

```bash
POST /api/codex/test-notification
```

### 导出当前筛选结果

```bash
GET /api/export?date=2026-04-21&project=/path/to/project&eventType=file.changed&keyword=py
```

## 9. 数据文件

项目当前主要使用本地 JSONL / JSON 持久化：

- `data/events.jsonl`
- `data/codex-monitor-state.json`

说明：

- `events.jsonl` 是主事件流
- `codex-monitor-state.json` 用来保存 Codex 轮询状态和去重信息

## 10. 前端结构

前端文件：

- `public/index.html`
- `public/app.js`
- `public/styles.css`

后端入口：

- `server.js`

辅助脚本：

- `scripts/zsh-activity-hook.zsh`
- `scripts/log-prompt.sh`

## 11. 已知边界

### 文件“打开了什么”

当前主要通过 macOS 前台窗口标题推断，不是系统级精确审计。

适合：

- VS Code
- 浏览器
- 文档编辑器
- WPS / Word / 表格工具

不保证：

- 每次都能精确到真实文件路径
- 所有应用都能拿到明确窗口标题

### 终端命令

当前默认支持 `zsh`。

如果你用的是 `bash`、`fish` 或其他 shell，需要额外扩展 hook。

### Codex 完成提醒

当前已经只保留线程级的 turn completed 事件，但依赖本机 Codex 日志结构。

如果 Codex 桌面版后续调整日志格式，这部分可能需要跟着微调。

### 磁盘排行

当前磁盘占用前几项是基于监控目录和一层子目录/文件的近似统计，并带缓存，目的是避免高频全盘扫描拖慢机器。

## 12. 建议的下一步

如果继续增强，优先级最高的通常是：

1. SQLite 持久化，替代纯 JSONL
2. 更精准的文件打开 / 编辑采集
3. 每日 / 每周自动总结
4. 更强的隐私脱敏和忽略目录配置
5. 多 shell 支持
6. 趋势图和历史对比

## 13. 本地开发说明

启动命令：

```bash
npm run dev
```

依赖：

- `express`
- `chokidar`

Node 入口：

```bash
server.js
```

---

如果你继续扩展这个项目，建议先保持一个原则：

“采集准确性”和“页面可读性”优先于功能堆叠。

因为这个项目的价值不在于记录得多，而在于你一眼就能看懂今天到底做了什么。
