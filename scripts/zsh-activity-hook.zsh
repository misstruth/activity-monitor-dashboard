export ACTIVITY_MONITOR_API="${ACTIVITY_MONITOR_API:-http://127.0.0.1:4321/api/events}"

typeset -g _activity_monitor_command=""
typeset -g _activity_monitor_started_at=""

_activity_monitor_json_body() {
  python3 - "$@" <<'PY'
import json
import sys

command = sys.argv[1] if len(sys.argv) > 1 else ""
cwd = sys.argv[2] if len(sys.argv) > 2 else ""
exit_code = int(sys.argv[3]) if len(sys.argv) > 3 else 0
duration_ms = int(sys.argv[4]) if len(sys.argv) > 4 else 0

payload = {
    "type": "terminal.command",
    "source": "zsh",
    "payload": {
        "command": command,
        "cwd": cwd,
        "exitCode": exit_code,
        "durationMs": duration_ms,
    },
}

print(json.dumps(payload, ensure_ascii=False))
PY
}

_activity_monitor_prompt_json() {
  python3 - "$@" <<'PY'
import json
import sys

text = sys.argv[1] if len(sys.argv) > 1 else ""
tool = sys.argv[2] if len(sys.argv) > 2 else "manual"

print(json.dumps({
    "text": text,
    "tool": tool,
}, ensure_ascii=False))
PY
}

_activity_monitor_preexec() {
  _activity_monitor_command="$1"
  _activity_monitor_started_at="$EPOCHREALTIME"
}

_activity_monitor_precmd() {
  local exit_code=$?
  local now="$EPOCHREALTIME"

  if [[ -z "$_activity_monitor_command" ]]; then
    return
  fi

  local duration_ms=0
  if [[ -n "$_activity_monitor_started_at" ]]; then
    duration_ms=$(python3 - "$_activity_monitor_started_at" "$now" <<'PY'
import sys

start = float(sys.argv[1])
end = float(sys.argv[2])
print(max(0, int((end - start) * 1000)))
PY
)
  fi

  local payload
  payload=$(_activity_monitor_json_body "$_activity_monitor_command" "$PWD" "$exit_code" "$duration_ms")

  curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$ACTIVITY_MONITOR_API" >/dev/null 2>&1

  _activity_monitor_command=""
  _activity_monitor_started_at=""
}

track_prompt() {
  local text="$*"
  local tool="${PROMPT_TOOL_NAME:-manual}"

  if [[ -z "$text" ]]; then
    echo "用法: track_prompt 这里写你的提示词"
    return 1
  fi

  local payload
  payload=$(_activity_monitor_prompt_json "$text" "$tool")

  curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "${ACTIVITY_MONITOR_API%/api/events}/api/prompts" >/dev/null 2>&1
}

if [[ -z "${preexec_functions[(r)_activity_monitor_preexec]}" ]]; then
  preexec_functions+=(_activity_monitor_preexec)
fi

if [[ -z "${precmd_functions[(r)_activity_monitor_precmd]}" ]]; then
  precmd_functions+=(_activity_monitor_precmd)
fi
