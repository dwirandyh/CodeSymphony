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
