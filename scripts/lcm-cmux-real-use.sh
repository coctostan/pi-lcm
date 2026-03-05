#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

CMUX_BIN="${CMUX_BIN:-cmux}"
PI_BIN="${PI_BIN:-pi}"
EXTENSION_PATH="${LCM_EXTENSION_PATH:-${REPO_ROOT}/src/index.ts}"
MODEL="${LCM_MODEL:-anthropic/claude-haiku-4-5}"
SESSION_DIR="${LCM_SESSION_DIR:-/tmp/pi-lcm-cmux/session-1}"
PROMPTS_FILE="${LCM_PROMPTS_FILE:-${REPO_ROOT}/scripts/prompts/lcm-real-use.txt}"
TURN_WAIT_SEC="${LCM_TURN_WAIT_SEC:-10}"
STARTUP_WAIT_SEC="${LCM_STARTUP_WAIT_SEC:-4}"
CAPTURE_LINES="${LCM_CAPTURE_LINES:-500}"
DEBUG_FLAG="${PI_LCM_DEBUG:-1}"
SPLIT_DIRECTION="${LCM_SPLIT_DIRECTION:-right}"
CMUX_EXTENSION_ROOT="${PI_CMUX_ROOT:-/Users/maxwellnewman/pi/workspace/pi-cmux}"
WITH_PI_CMUX="${LCM_WITH_CMUX:-1}"

WORKSPACE_ID="${LCM_WORKSPACE_ID:-}"
ORIGIN_SURFACE_ID="${LCM_ORIGIN_SURFACE_ID:-}"
TARGET_SURFACE_ID="${LCM_TARGET_SURFACE_ID:-}"

NO_TOOLS=0
KEEP_PI_RUNNING=0
DRY_RUN=0

EXTRA_PI_ARGS=()
PROMPTS=()

LOG_DIR=""

usage() {
  cat <<'EOF'
pi-lcm cmux real-use runner

Runs pi interactively inside cmux, sends a prompt sequence like a human user,
and captures screen snapshots + inspector output for postmortem debugging.

Usage:
  bash scripts/lcm-cmux-real-use.sh [options]

Options:
  -s, --session-dir <path>       Isolated pi session dir (default: /tmp/pi-lcm-cmux/session-1)
  -p, --prompts-file <path>      Prompts file (default: scripts/prompts/lcm-real-use.txt)
      --workspace <id|ref>       cmux workspace id/ref (default: auto from env/focused workspace)
      --origin-surface <id|ref>  surface used to create split (default: auto from env/focus)
      --target-surface <id|ref>  existing surface to use (skip new split)
      --split <left|right|up|down>
                                 split direction when creating a new surface (default: right)
      --turn-wait-sec <n>        sleep between prompts (default: 10)
      --startup-wait-sec <n>     sleep after launching pi (default: 4)
      --capture-lines <n>        read-screen lines to capture each turn (default: 500)
      --model <model-id>         pi model to use (default: anthropic/claude-haiku-4-5)
      --no-tools                 pass --no-tools to pi
      --keep-running             do not send /exit after prompts
      --pi-bin <command>         pi executable (default: pi)
      --pi-arg <arg>             extra pi arg (repeatable)
      --cmux-bin <command>       cmux executable (default: cmux)
      --log-dir <path>           output artifact directory (default: /tmp/pi-lcm-cmux/run-<timestamp>)
      --dry-run                  print planned actions without calling cmux
      --debug <0|1>              PI_LCM_DEBUG value (default: 1)
      --with-cmux               load pi-cmux extensions in target pi session (default: on)
      --without-cmux            do not load pi-cmux extensions in target pi session
      --cmux-extension-root <path>
                                 path to pi-cmux repo root (default: /Users/maxwellnewman/pi/workspace/pi-cmux)
  -h, --help                     show help

Examples:
  bash scripts/lcm-cmux-real-use.sh
  bash scripts/lcm-cmux-real-use.sh --workspace workspace:1 --origin-surface surface:2
  bash scripts/lcm-cmux-real-use.sh -p scripts/prompts/lcm-real-use.txt --turn-wait-sec 15
  bash scripts/lcm-cmux-real-use.sh --dry-run
  bash scripts/lcm-cmux-real-use.sh --without-cmux
  bash scripts/lcm-cmux-real-use.sh --cmux-extension-root ~/pi/workspace/pi-cmux
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session-dir)
      SESSION_DIR="$2"
      shift 2
      ;;
    -p|--prompts-file)
      PROMPTS_FILE="$2"
      shift 2
      ;;
    --workspace)
      WORKSPACE_ID="$2"
      shift 2
      ;;
    --origin-surface)
      ORIGIN_SURFACE_ID="$2"
      shift 2
      ;;
    --target-surface)
      TARGET_SURFACE_ID="$2"
      shift 2
      ;;
    --split)
      SPLIT_DIRECTION="$2"
      shift 2
      ;;
    --turn-wait-sec)
      TURN_WAIT_SEC="$2"
      shift 2
      ;;
    --startup-wait-sec)
      STARTUP_WAIT_SEC="$2"
      shift 2
      ;;
    --capture-lines)
      CAPTURE_LINES="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --no-tools)
      NO_TOOLS=1
      shift
      ;;
    --keep-running)
      KEEP_PI_RUNNING=1
      shift
      ;;
    --pi-bin)
      PI_BIN="$2"
      shift 2
      ;;
    --pi-arg)
      EXTRA_PI_ARGS+=("$2")
      shift 2
      ;;
    --cmux-bin)
      CMUX_BIN="$2"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --debug)
      DEBUG_FLAG="$2"
      shift 2
      ;;
    --with-cmux)
      WITH_PI_CMUX=1
      shift
      ;;
    --without-cmux)
      WITH_PI_CMUX=0
      shift
      ;;
    --cmux-extension-root)
      CMUX_EXTENSION_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "${TURN_WAIT_SEC}" =~ ^[0-9]+$ ]]; then
  echo "--turn-wait-sec must be an integer >= 0" >&2
  exit 1
fi

if ! [[ "${STARTUP_WAIT_SEC}" =~ ^[0-9]+$ ]]; then
  echo "--startup-wait-sec must be an integer >= 0" >&2
  exit 1
fi

if ! [[ "${CAPTURE_LINES}" =~ ^[0-9]+$ ]]; then
  echo "--capture-lines must be an integer >= 0" >&2
  exit 1
fi

if [[ "${DEBUG_FLAG}" != "0" && "${DEBUG_FLAG}" != "1" ]]; then
  echo "--debug must be 0 or 1" >&2
  exit 1
fi

if [[ "${WITH_PI_CMUX}" != "0" && "${WITH_PI_CMUX}" != "1" ]]; then
  echo "LCM_WITH_CMUX must be 0 or 1" >&2
  exit 1
fi

if [[ "${SPLIT_DIRECTION}" != "left" && "${SPLIT_DIRECTION}" != "right" && "${SPLIT_DIRECTION}" != "up" && "${SPLIT_DIRECTION}" != "down" ]]; then
  echo "--split must be one of: left, right, up, down" >&2
  exit 1
fi

if [[ ! -f "${EXTENSION_PATH}" ]]; then
  echo "Extension entry not found: ${EXTENSION_PATH}" >&2
  exit 1
fi

if [[ "${WITH_PI_CMUX}" -eq 1 ]]; then
  if [[ ! -f "${CMUX_EXTENSION_ROOT}/extensions/orchestrator.ts" ]]; then
    echo "pi-cmux orchestrator extension not found: ${CMUX_EXTENSION_ROOT}/extensions/orchestrator.ts" >&2
    exit 1
  fi
  if [[ ! -f "${CMUX_EXTENSION_ROOT}/extensions/browser.ts" ]]; then
    echo "pi-cmux browser extension not found: ${CMUX_EXTENSION_ROOT}/extensions/browser.ts" >&2
    exit 1
  fi
fi

if [[ ! -f "${PROMPTS_FILE}" ]]; then
  echo "Prompts file not found: ${PROMPTS_FILE}" >&2
  exit 1
fi

if ! command -v "${PI_BIN}" >/dev/null 2>&1; then
  echo "Could not find pi executable: ${PI_BIN}" >&2
  exit 1
fi

if ! command -v "${CMUX_BIN}" >/dev/null 2>&1; then
  echo "Could not find cmux executable: ${CMUX_BIN}" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script" >&2
  exit 1
fi

verify_cmux_runtime() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    return
  fi

  local out
  if ! out="$("${CMUX_BIN}" list-workspaces 2>&1)"; then
    if echo "${out}" | grep -qi 'TabManager not available'; then
      cat >&2 <<'EOF'
cmux CLI is reachable, but no active TabManager is available from this process.

This usually means the script is not running in a live cmux GUI context.
Run it from a cmux terminal surface, or use --dry-run / batch harness:
  npm run harness:lcm:real-use
EOF
    else
      echo "cmux list-workspaces failed: ${out}" >&2
    fi
    exit 1
  fi
}

load_prompts() {
  PROMPTS=()
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    PROMPTS+=("${line}")
  done < "${PROMPTS_FILE}"
}

cmux_json() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo '{}'
  else
    "${CMUX_BIN}" --json "$@"
  fi
}

cmux_plain() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] ${CMUX_BIN} $*"
  else
    "${CMUX_BIN}" "$@"
  fi
}

extract_first_nonempty() {
  local json="$1"
  local jq_expr="$2"
  if [[ -z "${json}" ]]; then
    return
  fi

  echo "${json}" | jq -r "${jq_expr} // empty" 2>/dev/null | head -n 1
}

extract_ref_from_text() {
  local text="$1"
  local prefix="$2"
  if [[ -z "${text}" ]]; then
    return
  fi

  printf '%s\n' "${text}" |
    grep -Eo "${prefix}:[^[:space:],\"]+" |
    head -n 1 || true
}
resolve_workspace_and_surface() {
  if [[ -z "${WORKSPACE_ID}" ]]; then
    WORKSPACE_ID="${CMUX_WORKSPACE_ID:-}"
  fi
  if [[ -z "${ORIGIN_SURFACE_ID}" ]]; then
    ORIGIN_SURFACE_ID="${CMUX_SURFACE_ID:-}"
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    WORKSPACE_ID="${WORKSPACE_ID:-workspace:DRY}"
    ORIGIN_SURFACE_ID="${ORIGIN_SURFACE_ID:-surface:DRY}"
    return
  fi

  if [[ -z "${WORKSPACE_ID}" || -z "${ORIGIN_SURFACE_ID}" ]]; then
    local identify_json
    identify_json="$(cmux_json identify --no-caller || true)"
    if [[ -z "${WORKSPACE_ID}" ]]; then
      WORKSPACE_ID="$(extract_first_nonempty "${identify_json}" '.focused.workspace.ref // .focused.workspace.id // .focused.workspace_ref // .focused.workspaceRef // .workspace_ref')"
      if [[ -z "${WORKSPACE_ID}" ]]; then
        WORKSPACE_ID="$(extract_ref_from_text "${identify_json}" "workspace")"
      fi
    fi

    if [[ -z "${ORIGIN_SURFACE_ID}" ]]; then
      ORIGIN_SURFACE_ID="$(extract_first_nonempty "${identify_json}" '.focused.surface.ref // .focused.surface.id // .focused.surface_ref // .focused.surfaceRef // .surface_ref // .surface.id // .surface')"
      if [[ -z "${ORIGIN_SURFACE_ID}" ]]; then
        ORIGIN_SURFACE_ID="$(extract_ref_from_text "${identify_json}" "surface")"
      fi
    fi
  fi

  if [[ -z "${WORKSPACE_ID}" || -z "${ORIGIN_SURFACE_ID}" ]]; then
    cat >&2 <<'EOF'
Could not auto-detect a focused cmux workspace/surface.
  --workspace <id|ref> --origin-surface <id|ref>
Tip:
  cmux identify --no-caller
EOF
    exit 1
  fi
}
ensure_target_surface() {
  if [[ -n "${TARGET_SURFACE_ID}" ]]; then
    return
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    TARGET_SURFACE_ID="surface:DRY_TARGET"
    return
  fi

  local split_out
  split_out="$(cmux_plain new-split "${SPLIT_DIRECTION}" --workspace "${WORKSPACE_ID}" --surface "${ORIGIN_SURFACE_ID}")"

  TARGET_SURFACE_ID="$(extract_ref_from_text "${split_out}" "surface")"

  if [[ -z "${TARGET_SURFACE_ID}" ]]; then
    TARGET_SURFACE_ID="$(extract_first_nonempty "${split_out}" '.surface.ref // .surface.id // .newSurface.ref // .newSurface.id // .targetSurface.ref // .targetSurface.id')"
  fi

  if [[ -z "${TARGET_SURFACE_ID}" ]]; then
    local identify_json
    identify_json="$(cmux_json identify --workspace "${WORKSPACE_ID}" --no-caller || true)"
    TARGET_SURFACE_ID="$(extract_first_nonempty "${identify_json}" '.focused.surface.ref // .focused.surface.id // .focused.surface_ref // .focused.surfaceRef // .surface_ref // .surface.id')"
    if [[ -z "${TARGET_SURFACE_ID}" ]]; then
      TARGET_SURFACE_ID="$(extract_ref_from_text "${identify_json}" "surface")"
    fi
  fi

  if [[ -z "${TARGET_SURFACE_ID}" ]]; then
    echo "Failed to determine target surface after creating split." >&2
    exit 1
  fi
}

send_line() {
  local text="$1"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] send -> ${text}"
    return
  fi

  cmux_plain send --workspace "${WORKSPACE_ID}" --surface "${TARGET_SURFACE_ID}" "${text}"
  cmux_plain send-key --workspace "${WORKSPACE_ID}" --surface "${TARGET_SURFACE_ID}" Enter
}

capture_screen() {
  local out_file="$1"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '[dry-run] capture screen -> %s\n' "${out_file}" > "${out_file}"
    return
  fi

  cmux_plain read-screen --workspace "${WORKSPACE_ID}" --surface "${TARGET_SURFACE_ID}" --scrollback --lines "${CAPTURE_LINES}" > "${out_file}" 2>&1 || true
}

build_pi_launch_command() {
  local cmd
  cmd="cd $(printf '%q' "${REPO_ROOT}") && PI_LCM_DEBUG=${DEBUG_FLAG} $(printf '%q' "${PI_BIN}") --no-extensions -e $(printf '%q' "${EXTENSION_PATH}") --session-dir $(printf '%q' "${SESSION_DIR}") --model $(printf '%q' "${MODEL}")"

  if [[ "${WITH_PI_CMUX}" -eq 1 ]]; then
    cmd+=" -e $(printf '%q' "${CMUX_EXTENSION_ROOT}/extensions/orchestrator.ts")"
    cmd+=" -e $(printf '%q' "${CMUX_EXTENSION_ROOT}/extensions/browser.ts")"
  fi

  if [[ "${NO_TOOLS}" -eq 1 ]]; then
    cmd+=" --no-tools"
  fi

  if [[ ${#EXTRA_PI_ARGS[@]} -gt 0 ]]; then
    for arg in "${EXTRA_PI_ARGS[@]}"; do
      cmd+=" $(printf '%q' "${arg}")"
    done
  fi

  echo "${cmd}"
}

find_session_id_from_artifacts() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    return
  fi
  local found
  found="$(grep -RhoE '/[^ ]*/\.pi/agent/lcm/[0-9a-fA-F-]{36}\.db' "${LOG_DIR}" 2>/dev/null | tail -n 1 | sed -E 's#.*\/([0-9a-fA-F-]{36})\.db#\1#' | tr 'A-F' 'a-f' || true)"
  if [[ -n "${found}" ]]; then
    echo "${found}"
    return
  fi
  # Fallback to newest db in ~/.pi/agent/lcm
  local newest
  newest="$(ls -1t "${HOME}/.pi/agent/lcm"/*.db 2>/dev/null | head -n 1 || true)"
  if [[ -n "${newest}" ]]; then
    basename "${newest}" .db
  fi
}

run_inspector_if_possible() {
  local session_id="$1"
  local inspect_out="${LOG_DIR}/inspect-live-db.txt"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] inspector skipped" > "${inspect_out}"
    return
  fi

  if [[ -z "${session_id}" ]]; then
    echo "No session id found; inspector skipped" > "${inspect_out}"
    return
  fi

  local db_path="${HOME}/.pi/agent/lcm/${session_id}.db"
  if [[ ! -f "${db_path}" ]]; then
    echo "Session DB not found: ${db_path}" > "${inspect_out}"
    return
  fi

  node --experimental-strip-types "${REPO_ROOT}/scripts/inspect-live-db.ts" "${db_path}" > "${inspect_out}" 2>&1 || true
}

load_prompts
if [[ ${#PROMPTS[@]} -eq 0 ]]; then
  echo "No prompts loaded from ${PROMPTS_FILE}" >&2
  exit 1
fi

mkdir -p "${SESSION_DIR}"
if [[ -z "${LOG_DIR}" ]]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  LOG_DIR="/tmp/pi-lcm-cmux/run-${ts}"
fi
mkdir -p "${LOG_DIR}"

verify_cmux_runtime

resolve_workspace_and_surface
ensure_target_surface

cat <<EOF
pi-lcm cmux real-use runner
  cmux bin        : ${CMUX_BIN}
  pi bin          : ${PI_BIN}
  workspace       : ${WORKSPACE_ID}
  origin surface  : ${ORIGIN_SURFACE_ID}
  target surface  : ${TARGET_SURFACE_ID}
  extension       : ${EXTENSION_PATH}
  model           : ${MODEL}
  no tools        : ${NO_TOOLS}
  with pi-cmux    : ${WITH_PI_CMUX}
  cmux ext root   : ${CMUX_EXTENSION_ROOT}
  session dir     : ${SESSION_DIR}
  prompts file    : ${PROMPTS_FILE}
  prompt count    : ${#PROMPTS[@]}
  startup wait    : ${STARTUP_WAIT_SEC}s
  turn wait       : ${TURN_WAIT_SEC}s
  capture lines   : ${CAPTURE_LINES}
  artifacts       : ${LOG_DIR}
  dry run         : ${DRY_RUN}
EOF

pi_launch_cmd="$(build_pi_launch_command)"
echo "${pi_launch_cmd}" > "${LOG_DIR}/pi-launch-command.txt"

send_line "${pi_launch_cmd}"
sleep "${STARTUP_WAIT_SEC}"
capture_screen "${LOG_DIR}/screen-000-startup.txt"

for i in "${!PROMPTS[@]}"; do
  turn=$((i + 1))
  prompt="${PROMPTS[$i]}"
  prompt_file="${LOG_DIR}/prompt-$(printf '%03d' "${turn}").txt"
  screen_file="${LOG_DIR}/screen-$(printf '%03d' "${turn}").txt"

  printf '%s\n' "${prompt}" > "${prompt_file}"
  echo "Sending prompt ${turn}/${#PROMPTS[@]}"
  send_line "${prompt}"
  sleep "${TURN_WAIT_SEC}"
  capture_screen "${screen_file}"
done

if [[ "${KEEP_PI_RUNNING}" -eq 0 ]]; then
  echo "Sending /exit"
  send_line "/exit"
  sleep 2
  capture_screen "${LOG_DIR}/screen-999-exit.txt"
fi

session_id="$(find_session_id_from_artifacts || true)"
printf '%s\n' "${session_id}" > "${LOG_DIR}/session-id.txt"
run_inspector_if_possible "${session_id}"

cat <<EOF
Done.
  artifacts       : ${LOG_DIR}
  guessed session : ${session_id:-<unknown>}
  inspector out   : ${LOG_DIR}/inspect-live-db.txt
EOF
