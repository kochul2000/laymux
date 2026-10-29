# Explicit close only. The immutable proof never comes from a displayed app name.
set -u
terminal_id=$1
proof=${LAYMUX_PTY_CLOSE_TOKEN-}
unset LAYMUX_PTY_CLOSE_TOKEN
[[ -n "$proof" ]] || exit 3

read_stat() {
  local line
  IFS= read -r line < "/proc/$1/stat" 2>/dev/null || return 1
  line=${line##*) }
  read -ra fields <<< "$line"
  [[ ${#fields[@]} -ge 20 && ${fields[0]} != Z && ${fields[0]} != X ]]
}

root=
root_ticks=
tty=
for proc in /proc/[0-9]*; do
  pid=${proc##*/}
  read_stat "$pid" || continue
  [[ ${fields[4]} != 0 && ${fields[3]} -gt 1 ]] || continue
  candidate_root=${fields[3]}
  candidate_tty=${fields[4]}
  id_match=0
  token_match=0
  while IFS= read -r -d '' entry; do
    [[ "$entry" != "LX_TERMINAL_ID=$terminal_id" ]] || id_match=1
    [[ "$entry" != "LX_AGENT_HOOK_TOKEN=$proof" ]] || token_match=1
  done < "$proc/environ" 2>/dev/null
  [[ $id_match = 1 && $token_match = 1 ]] || continue
  read_stat "$candidate_root" || continue
  [[ ${fields[3]} = "$candidate_root" && ${fields[4]} = "$candidate_tty" ]] || continue
  if [[ -n "$root" && "$root" != "$candidate_root" ]]; then
    printf 'ambiguous PTY ownership\n'
    exit 4
  fi
  root=$candidate_root
  root_ticks=${fields[19]}
  tty=$candidate_tty
done
[[ -n "$root" ]] || exit 0
read_stat "$root" || exit 0
[[ ${fields[19]} = "$root_ticks" && ${fields[4]} = "$tty" ]] || exit 0
foreground=${fields[5]}
[[ $foreground -gt 1 ]] || exit 0
IFS= read -r root_name < "/proc/$root/comm" || exit 0
shell_root=0
case "$root_name" in bash|sh|dash|zsh|fish|ash) shell_root=1 ;; esac

jobs=()
births=()
for proc in /proc/[0-9]*; do
  pid=${proc##*/}
  [[ $shell_root != 1 || "$pid" != "$root" ]] || continue
  read_stat "$pid" || continue
  [[ ${fields[2]} = "$foreground" && ${fields[4]} = "$tty" ]] || continue
  jobs+=("$pid")
  births+=("${fields[19]}")
done
[[ ${#jobs[@]} -gt 0 ]] || exit 0
# Revalidate the controlling session immediately before the single group signal.
read_stat "$root" || exit 0
[[ ${fields[19]} = "$root_ticks" && ${fields[4]} = "$tty" && ${fields[5]} = "$foreground" ]] || exit 0
kill -TERM -- "-$foreground" 2>/dev/null || { printf 'foreground SIGTERM failed\n'; exit 5; }
for ((attempt=0; attempt<120; attempt++)); do
  pending=0
  for index in "${!jobs[@]}"; do
    read_stat "${jobs[index]}" || continue
    [[ ${fields[19]} = "${births[index]}" ]] || continue
    pending=1
    break
  done
  [[ $pending = 1 ]] || exit 0
  sleep .1
done
printf 'foreground shutdown deadline expired\n'
exit 6
