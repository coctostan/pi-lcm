#!/usr/bin/env bash
set -euo pipefail

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
CMUX_EXTENSION_ROOT="${PI_CMUX_ROOT:-/Users/maxwellnewman/pi/workspace/pi-cmux}"
WITH_PI_CMUX="${LCM_WITH_CMUX:-0}"
QUIET=0
RESUME_ONLY=0

EXTRA_PI_ARGS=()
PROMPTS=()

usage() {
  cat <<'EOF'
pi-lcm harness

Runs reproducible long-session prompts against pi-lcm in an isolated session dir.
The harness always starts pi with --no-extensions and explicitly loads pi-lcm.

Default mode is "batch" (single pi process) because it better reflects real
interactive sessions for async extension work (like compaction).

Usage:
  bash scripts/lcm-harness.sh [options]

Options:
  -s, --session-dir <path>   Session directory (default: /tmp/pi-lcm-harness/session-1)
  -t, --turns <n>            Number of generated follow-up turns (default: 50)
      --start <text>         Initial prompt text (default: "start")
      --turn-prefix <text>   Generated follow-up prefix -> "<prefix> <i>" (default: "turn")
      --prompts-file <path>  Use explicit prompts from file (one prompt per line, # comments allowed)
  -e, --extension <path>     Extension entry file (default: <repo>/src/index.ts)
      --pi-bin <command>     pi executable/command name (default: "pi")
      --pi-arg <arg>         Extra pi arg (repeatable), e.g. --pi-arg "--model" --pi-arg "sonnet"
      --debug <0|1>          Value for PI_LCM_DEBUG (default: 1)
      --mode <batch|loop>    batch = one pi process (default), loop = one process per prompt
      --legacy-loop          Alias for --mode loop
      --resume               Skip initial start call for generated prompts, or continue an existing session for file prompts
      --log-file <path>      Log file path (default: <session-dir>/lcm-harness.<timestamp>.log)
      --quiet                Suppress live command output (still writes log)
      --with-cmux            Load pi-cmux orchestrator+browser extensions in target pi process
      --cmux-extension-root <path>
                             Path to pi-cmux repo root (default: /Users/maxwellnewman/pi/workspace/pi-cmux)
  -h, --help                 Show this help

Examples:
  bash scripts/lcm-harness.sh
  bash scripts/lcm-harness.sh -s /tmp/pi-lcm-test-2 -t 120
  bash scripts/lcm-harness.sh --prompts-file scripts/prompts/lcm-real-use.txt
  bash scripts/lcm-harness.sh --resume -s /tmp/pi-lcm-test-2 -t 20
  bash scripts/lcm-harness.sh --mode loop -s /tmp/pi-lcm-test-2 -t 20
  bash scripts/lcm-harness.sh --pi-arg "--model" --pi-arg "anthropic/claude-haiku-4-5"
  bash scripts/lcm-harness.sh --with-cmux --prompts-file scripts/prompts/lcm-tool-smoke-summary.txt
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session-dir)
      SESSION_DIR="$2"
      shift 2
      ;;
    -t|--turns)
      TURNS="$2"
      shift 2
      ;;
    --start)
      START_PROMPT="$2"
      shift 2
      ;;
    --turn-prefix)
      TURN_PREFIX="$2"
      shift 2
      ;;
    --prompts-file)
      PROMPTS_FILE="$2"
      shift 2
      ;;
    -e|--extension)
      EXTENSION_PATH="$2"
      shift 2
      ;;
    --pi-bin)
      PI_BIN="$2"
      shift 2
      ;;
    --pi-arg)
      EXTRA_PI_ARGS+=("$2")
      shift 2
      ;;
    --debug)
      DEBUG_FLAG="$2"
      shift 2
      ;;
    --with-cmux)
      WITH_PI_CMUX=1
      shift
      ;;
    --cmux-extension-root)
      CMUX_EXTENSION_ROOT="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --legacy-loop)
      MODE="loop"
      shift
      ;;
    --resume)
      RESUME_ONLY=1
      shift
      ;;
    --log-file)
      LOG_FILE="$2"
      shift 2
      ;;
    --quiet)
      QUIET=1
      shift
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

if ! [[ "${TURNS}" =~ ^[0-9]+$ ]]; then
  echo "--turns must be an integer >= 0 (got: ${TURNS})" >&2
  exit 1
fi

if [[ "${DEBUG_FLAG}" != "0" && "${DEBUG_FLAG}" != "1" ]]; then
  echo "--debug must be 0 or 1 (got: ${DEBUG_FLAG})" >&2
  exit 1
fi

if [[ "${WITH_PI_CMUX}" != "0" && "${WITH_PI_CMUX}" != "1" ]]; then
  echo "LCM_WITH_CMUX must be 0 or 1 (got: ${WITH_PI_CMUX})" >&2
  exit 1
fi

if [[ "${MODE}" != "batch" && "${MODE}" != "loop" ]]; then
  echo "--mode must be 'batch' or 'loop' (got: ${MODE})" >&2
  exit 1
fi

if ! command -v "${PI_BIN}" >/dev/null 2>&1; then
  echo "Could not find pi executable: ${PI_BIN}" >&2
  exit 1
fi

if [[ ! -f "${EXTENSION_PATH}" ]]; then
  echo "Extension file not found: ${EXTENSION_PATH}" >&2
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

if [[ -n "${PROMPTS_FILE}" && ! -f "${PROMPTS_FILE}" ]]; then
  echo "Prompts file not found: ${PROMPTS_FILE}" >&2
  exit 1
fi

mkdir -p "${SESSION_DIR}"

if [[ -z "${LOG_FILE}" ]]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  LOG_FILE="${SESSION_DIR}/lcm-harness.${ts}.log"
fi

touch "${LOG_FILE}"

COMMON_ARGS=(
  --no-extensions
  -e "${EXTENSION_PATH}"
)
if [[ "${WITH_PI_CMUX}" -eq 1 ]]; then
  COMMON_ARGS+=(-e "${CMUX_EXTENSION_ROOT}/extensions/orchestrator.ts")
  COMMON_ARGS+=(-e "${CMUX_EXTENSION_ROOT}/extensions/browser.ts")
fi
COMMON_ARGS+=(--session-dir "${SESSION_DIR}")

run_cmd() {
  local -a cmd=("$@")

  {
    printf '\n[%s] ' "$(date '+%Y-%m-%d %H:%M:%S')"
    printf 'PI_LCM_DEBUG=%s ' "${DEBUG_FLAG}"
    printf '%q ' "${cmd[@]}"
    printf '\n'
  } >> "${LOG_FILE}"

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
    if [[ ${#EXTRA_PI_ARGS[@]} -gt 0 ]]; then
      cmd+=("${EXTRA_PI_ARGS[@]}")
    fi
    cmd+=("${COMMON_ARGS[@]}")

    # In loop mode, every prompt after the first one must continue the existing session.
    # If --resume is set, all prompts continue from an already-existing session.
    if [[ "${RESUME_ONLY}" -eq 1 || "${idx}" -gt 0 ]]; then
      cmd+=(--continue)
    fi

    cmd+=(-p "${prompt}")

    if [[ "${QUIET}" -eq 0 ]]; then
      echo
      echo "→ ${prompt}"
    fi

    run_cmd "${cmd[@]}"
    idx=$((idx + 1))
  done
}

run_batch_mode() {
  local -a cmd=("${PI_BIN}")
  if [[ ${#EXTRA_PI_ARGS[@]} -gt 0 ]]; then
    cmd+=("${EXTRA_PI_ARGS[@]}")
  fi
  cmd+=("${COMMON_ARGS[@]}")
  if [[ "${RESUME_ONLY}" -eq 1 ]]; then
    cmd+=(--continue)
  fi
  cmd+=(-p "${PROMPTS[@]}")

  if [[ "${QUIET}" -eq 0 ]]; then
    echo
    echo "→ batch run (${#PROMPTS[@]} prompts in one pi process)"
  fi

  run_cmd "${cmd[@]}"
}

build_prompt_list

if [[ ${#PROMPTS[@]} -eq 0 ]]; then
  echo "Nothing to run: prompt list is empty." >&2
  exit 1
fi

echo "pi-lcm harness"
echo "  pi bin       : ${PI_BIN}"
echo "  extension    : ${EXTENSION_PATH}"
echo "  session dir  : ${SESSION_DIR}"
echo "  mode         : ${MODE}"
echo "  prompts      : ${#PROMPTS[@]}"
if [[ -n "${PROMPTS_FILE}" ]]; then
  echo "  prompts file : ${PROMPTS_FILE}"
else
  echo "  generated    : start='${START_PROMPT}', turns=${TURNS}, prefix='${TURN_PREFIX}'"
  echo "  resume       : ${RESUME_ONLY}"
fi
echo "  debug        : PI_LCM_DEBUG=${DEBUG_FLAG}"
echo "  log          : ${LOG_FILE}"
if [[ "${WITH_PI_CMUX}" -eq 1 ]]; then
  echo "  with cmux     : yes (${CMUX_EXTENSION_ROOT})"
else
  echo "  with cmux     : no"
fi

if [[ "${MODE}" == "loop" ]]; then
  run_loop_mode
else
  run_batch_mode
fi

echo
echo "Done."
echo "Session dir: ${SESSION_DIR}"
echo "Log file:   ${LOG_FILE}"
