#!/usr/bin/env bash

set -euo pipefail

API_BASE="${ACTIVITY_MONITOR_API_BASE:-http://127.0.0.1:4321}"
TEXT="${*:-}"
TOOL="${PROMPT_TOOL_NAME:-manual}"

if [[ -z "${TEXT}" ]]; then
  echo "Usage: ./scripts/log-prompt.sh <prompt text>"
  exit 1
fi

python3 - "$TEXT" "$TOOL" <<'PY' | curl -s -X POST \
  -H "Content-Type: application/json" \
  -d @- \
  "${API_BASE}/api/prompts" >/dev/null
import json
import sys

print(json.dumps({
    "text": sys.argv[1],
    "tool": sys.argv[2],
}, ensure_ascii=False))
PY
