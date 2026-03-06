#!/usr/bin/env bash
set -euo pipefail
#
# pi-lcm test harness — runs a separate pi process with lcm loaded
#
# Usage:
#   bash scripts/lcm-harness.sh [options]
#
# Examples:
#   bash scripts/lcm-harness.sh
#   bash scripts/lcm-harness.sh -s /tmp/pi-lcm-test-2 -t 50
#   bash scripts/lcm-harness.sh --prompts-file scripts/prompts/lcm-real-use.txt
#   bash scripts/lcm-harness.sh --pi-arg "--model" --pi-arg "anthropic/claude-haiku-4-5"
#   bash scripts/lcm-harness.sh --mode loop -t 20

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

PI_BIN="${PI_BIN:-pi}"
EXTENSION_PATH="${LCM_EXTENSION_PATH:-${REPO_ROOT}/src/index.ts}"
SESSION_DIR="${LCM_SESSION_DIR:-/tmp/pi-lcm-harness/session-1}"
TURNS="${LCM_TURNS:-50}"
START_PROMPT="${LCM_START_PROMPT:-start}"
TURN_PREFIX="${LCM_TURN_PREFIX:-turn}"
PROMPTS_FILE="${LCM_PROMPTS_FILE:-}"
DEBUG_FLAG="${PI_LCM_DEBUG:-1}"
LOG_FILE="${LCM_LOG_FILE:-}"
MODE="${LCM_HARNESS_MODE:-batch}"   # batch | loop
QUIET=0
RESUME_ONLY=0

EXTRA_PI_ARGS=()
PROMPTS=()

usage() {
  cat <<'EOF'
pi-lcm harness — runs reproducible prompts against pi-lcm in an isolated session

Options:
  -s, --session-dir <path>   Session directory (default: /tmp/pi-lcm-harness/session-1)
  -t, --turns <n>            Number of generated turns (default: 50)
      --start <text>         Initial prompt (default: "start")
      --turn-prefix <text>   Follow-up prefix (default: "turn")
      --prompts-file <path>  Use prompts from file (one per line, # comments)
  -e, --extension <path>     Extension entry (default: <repo>/src/index.ts)
      --pi-bin <command>     pi executable (default: "pi")
      --pi-arg <arg>         Extra pi arg (repeatable)
      --debug <0|1>          PI_LCM_DEBUG value (default: 1)
      --mode <batch|loop>    batch = one pi process (default), loop = one per prompt
      --resume               Continue existing session
      --log-file <path>      Log file (default: <session-dir>/lcm-harness.<ts>.log)
      --quiet                Suppress live output (still writes log)
  -h, --help                 Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session-dir) SESSION_DIR="$2"; shift 2 ;;
    -t|--turns) TURNS="$2"; shift 2 ;;
    --start) START_PROMPT="$2"; shift 2 ;;
    --turn-prefix) TURN_PREFIX="$2"; shift 2 ;;
    --prompts-file) PROMPTS_FILE="$2"; shift 2 ;;
    -e|--extension) EXTENSION_PATH="$2"; shift 2 ;;
    --pi-bin) PI_BIN="$2"; shift 2 ;;
    --pi-arg) EXTRA_PI_ARGS+=("$2"); shift 2 ;;
    --debug) DEBUG_FLAG="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --resume) RESUME_ONLY=1; shift ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ "${TURNS}" =~ ^[0-9]+$ ]] || { echo "--turns must be an integer" >&2; exit 1; }
[[ "${MODE}" == "batch" || "${MODE}" == "loop" ]] || { echo "--mode must be batch|loop" >&2; exit 1; }
command -v "${PI_BIN}" >/dev/null 2>&1 || { echo "pi not found: ${PI_BIN}" >&2; exit 1; }
[[ -f "${EXTENSION_PATH}" ]] || { echo "Extension not found: ${EXTENSION_PATH}" >&2; exit 1; }

if [[ -n "${PROMPTS_FILE}" && ! -f "${PROMPTS_FILE}" ]]; then
  echo "Prompts file not found: ${PROMPTS_FILE}" >&2; exit 1
fi

mkdir -p "${SESSION_DIR}"
if [[ -z "${LOG_FILE}" ]]; then
  LOG_FILE="${SESSION_DIR}/lcm-harness.$(date +%Y%m%d-%H%M%S).log"
fi
touch "${LOG_FILE}"

COMMON_ARGS=(--no-extensions -e "${EXTENSION_PATH}" --session-dir "${SESSION_DIR}")

run_cmd() {
  local -a cmd=("$@")
  printf '\n[%s] ' "$(date '+%Y-%m-%d %H:%M:%S')" >> "${LOG_FILE}"
  printf 'PI_LCM_DEBUG=%s ' "${DEBUG_FLAG}" >> "${LOG_FILE}"
  printf '%q ' "${cmd[@]}" >> "${LOG_FILE}"
  printf '\n' >> "${LOG_FILE}"

  if [[ "${QUIET}" -eq 0 ]]; then
    PI_LCM_DEBUG="${DEBUG_FLAG}" "${cmd[@]}" 2>&1 | tee -a "${LOG_FILE}"
  else
    PI_LCM_DEBUG="${DEBUG_FLAG}" "${cmd[@]}" >> "${LOG_FILE}" 2>&1
  fi
}

build_prompt_list() {
  PROMPTS=()
  if [[ -n "${PROMPTS_FILE}" ]]; then
    while IFS= read -r line || [[ -n "${line}" ]]; do
      line="${line%$'\r'}"
      [[ -z "${line//[[:space:]]/}" ]] && continue
      [[ "${line}" =~ ^[[:space:]]*# ]] && continue
      PROMPTS+=("${line}")
    done < "${PROMPTS_FILE}"
    return
  fi
  if [[ "${RESUME_ONLY}" -eq 0 ]]; then
    PROMPTS+=("${START_PROMPT}")
  fi
  for ((i = 1; i <= TURNS; i++)); do
    PROMPTS+=("${TURN_PREFIX} ${i}")
  done
}

run_loop_mode() {
  local idx=0
  for prompt in "${PROMPTS[@]}"; do
    local -a cmd=("${PI_BIN}")
    [[ ${#EXTRA_PI_ARGS[@]} -gt 0 ]] && cmd+=("${EXTRA_PI_ARGS[@]}")
    cmd+=("${COMMON_ARGS[@]}")
    [[ "${RESUME_ONLY}" -eq 1 || "${idx}" -gt 0 ]] && cmd+=(--continue)
    cmd+=(-p "${prompt}")
    [[ "${QUIET}" -eq 0 ]] && echo "→ ${prompt}"
    run_cmd "${cmd[@]}"
    idx=$((idx + 1))
  done
}

run_batch_mode() {
  local -a cmd=("${PI_BIN}")
  [[ ${#EXTRA_PI_ARGS[@]} -gt 0 ]] && cmd+=("${EXTRA_PI_ARGS[@]}")
  cmd+=("${COMMON_ARGS[@]}")
  [[ "${RESUME_ONLY}" -eq 1 ]] && cmd+=(--continue)
  cmd+=(-p "${PROMPTS[@]}")
  [[ "${QUIET}" -eq 0 ]] && echo "→ batch run (${#PROMPTS[@]} prompts)"
  run_cmd "${cmd[@]}"
}

build_prompt_list
if [[ ${#PROMPTS[@]} -eq 0 ]]; then
  echo "No prompts to run." >&2; exit 1
fi

echo "pi-lcm harness"
echo "  extension: ${EXTENSION_PATH}"
echo "  session:   ${SESSION_DIR}"
echo "  mode:      ${MODE}"
echo "  prompts:   ${#PROMPTS[@]}"
echo "  log:       ${LOG_FILE}"

if [[ "${MODE}" == "loop" ]]; then
  run_loop_mode
else
  run_batch_mode
fi

echo "Done. Log: ${LOG_FILE}"
