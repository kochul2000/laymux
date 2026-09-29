# Shared by WSL attribution and liveness. Keep argv contents inside the guest.
# A zombie has an empty cmdline/environ but can inherit a pane marker through
# its live parent. Only a proven kernel exit state excludes it; stopped and
# unreadable processes remain candidates.
laymux_is_terminated_process() {
  [ -r "$1/status" ] || return 1
  while read -r laymux_state_key laymux_state_code laymux_state_detail; do
    [ "$laymux_state_key" = 'State:' ] || continue
    case "$laymux_state_code" in
      Z|X) return 0 ;;
      *) return 1 ;;
    esac
  done < "$1/status" 2>/dev/null
  return 1
}

# Only the observed, explicit entry mode proves this is a Chrome host rather
# than a conversation. An unreadable command line preserves the candidate.
laymux_is_claude_chrome_host() {
  case "$2" in
    [cC][lL][aA][uU][dD][eE]|[cC][lL][aA][uU][dD][eE].[eE][xX][eE]) ;;
    *) return 1 ;;
  esac
  [ -r "$1/cmdline" ] || return 1
  # Translate embedded newlines away before translating NUL delimiters, so a
  # newline inside one argument cannot masquerade as an argv boundary.
  laymux_claude_mode=$(LC_ALL=C tr '\000\n' '\n\001' < "$1/cmdline" 2>/dev/null | sed -n '2p')
  [ "$laymux_claude_mode" = '--chrome-native-host' ]
}

# A daemon can retain LX_TERMINAL_ID after its TUI returns to the shell.
# Only an exact argv[1] proves the observed server role; unknown modes remain
# candidates, including when cmdline is unreadable.
laymux_is_codex_app_server() {
  case "$2" in
    [cC][oO][dD][eE][xX]|[cC][oO][dD][eE][xX].[eE][xX][eE]) ;;
    *) return 1 ;;
  esac
  [ -r "$1/cmdline" ] || return 1
  laymux_codex_mode=$(LC_ALL=C tr '\000\n' '\n\001' < "$1/cmdline" 2>/dev/null | sed -n '2p')
  [ "$laymux_codex_mode" = 'app-server' ]
}

laymux_is_agent_helper() {
  laymux_is_claude_chrome_host "$1" "$2" || laymux_is_codex_app_server "$1" "$2"
}
