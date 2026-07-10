# CodeSymphony embedded terminal: preserve ANSI/truecolor for CLIs (claude, etc.)
# User shell rc (oh-my-zsh, Cursor/Zed hooks) often re-exports NO_COLOR=1 when CURSOR_AGENT is set.

codesymphony_terminal_sanitize_env() {
  unset NO_COLOR
  unset FORCE_COLOR CLICOLOR 2>/dev/null
  unset ZED_TERM 2>/dev/null
  export FORCE_COLOR=1
  export COLORTERM=truecolor
  export CLICOLOR_FORCE=1
  export TERM_PROGRAM=CodeSymphony
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    unset ${(m)${(k)parameters[(I)CURSOR_*]}} 2>/dev/null
  fi
}

codesymphony_terminal_sanitize_env

user_home="${HOME:-$(eval echo ~)}"
user_zprofile="${user_home}/.zprofile"
user_zshrc="${user_home}/.zshrc"

if [[ -r "${user_zprofile}" ]]; then
  source "${user_zprofile}"
  codesymphony_terminal_sanitize_env
fi

if [[ -r "${user_zshrc}" ]]; then
  source "${user_zshrc}"
  codesymphony_terminal_sanitize_env
fi

# Cursor/Zed/oh-my-zsh hooks often re-export NO_COLOR on every precmd.
if [[ -n "${ZSH_VERSION:-}" ]]; then
  autoload -Uz add-zsh-hook 2>/dev/null || true
  if typeset -f add-zsh-hook > /dev/null 2>&1; then
    add-zsh-hook precmd codesymphony_terminal_sanitize_env
  else
    precmd_functions+=(codesymphony_terminal_sanitize_env)
  fi
fi

# CodeSymphony Codex agent-status shim. Codex's native `notify` only reports
# completion, so we also tail its TUI session log for turn-start / approval
# events and forward them to the runtime hook script. Only active inside a
# workspace terminal (CS_TERMINAL_SESSION_ID + CS_AGENT_HOOK_SCRIPT set).
if [[ -n "${CS_TERMINAL_SESSION_ID:-}" && -n "${CS_AGENT_HOOK_SCRIPT:-}" ]]; then
  codex() {
    local real_bin
    real_bin="$(command -v codex 2>/dev/null)"
    if [[ -z "$real_bin" || "$real_bin" == "codex" ]]; then
      real_bin="${CODEX_BINARY_PATH:-codex}"
    fi

    local notify="$CS_AGENT_HOOK_SCRIPT"
    local session_log="${TMPDIR:-/tmp}/cs-codex-session-$$-$RANDOM.jsonl"
    export CODEX_TUI_RECORD_SESSION="${CODEX_TUI_RECORD_SESSION:-1}"
    export CODEX_TUI_SESSION_LOG_PATH="$session_log"

    local watcher_pid=""
    (
      local i=0
      while [[ ! -f "$session_log" && $i -lt 200 ]]; do
        i=$((i + 1)); sleep 0.1
      done
      [[ -f "$session_log" ]] || exit 0
      tail -n +1 -F "$session_log" 2>/dev/null | while IFS= read -r line; do
        case "$line" in
          *'"dir":"from_tui"'*'"kind":"op"'*'"UserTurn"'*)
            CS_AGENT_ID=codex bash "$notify" '{"type":"task_started"}' >/dev/null 2>&1 || true ;;
          *'_approval_request"'*)
            CS_AGENT_ID=codex bash "$notify" '{"type":"exec_approval_request"}' >/dev/null 2>&1 || true ;;
        esac
      done
    ) 2>/dev/null &
    watcher_pid=$!

    CS_AGENT_ID=codex "$real_bin" --enable hooks -c "notify=[\"bash\",\"$notify\"]" "$@"
    local status=$?

    if [[ -n "$watcher_pid" ]]; then
      kill "$watcher_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$session_log" >/dev/null 2>&1 || true
    return $status
  }
fi
