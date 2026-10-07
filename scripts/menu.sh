#!/bin/zsh
# NEXUS menu: run, record, or log in without typing commands.
# Double-click a .command file that calls this script (see scripts/install-shortcuts.sh).

cd "${0:A:h}/.." || exit 1

# Terminal windows opened from Finder may not have nvm's node on PATH yet.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it (or nvm), then try again."
  read -k1 "?Press any key to close…"
  exit 1
fi

PROFILE="${NEXUS_PROFILE:-work}"
nexus() { node src/cli.ts "$@"; }

choose_task() {
  local tasks=(recordings/*.json(N) drafts/*.json(N))
  if (( ${#tasks} == 0 )); then
    echo "No tasks yet. Record one first (option 2)."
    return 1
  fi
  local i=1
  for task in $tasks; do echo "  $i) ${task}"; (( i++ )); done
  local pick
  read "pick?Task number: "
  if [[ "$pick" != <-> ]] || (( pick < 1 || pick > ${#tasks} )); then
    echo "Not a valid number."
    return 1
  fi
  REPLY="${tasks[$pick]}"
}

while true; do
  echo
  echo "━━━ NEXUS ━━━  (login profile: $PROFILE)"
  echo "  1) Run a task"
  echo "  2) Record a new task"
  echo "  3) Open a browser to log in"
  echo "  4) Quit"
  read "choice?Choose 1-4: "
  case "$choice" in
    1)
      choose_task || continue
      nexus run "$REPLY" --profile "$PROFILE" --headed
      ;;
    2)
      read "url?Website address (e.g. https://sedin.keka.com/): "
      [[ -z "$url" ]] && continue
      read "name?Short name for this task (e.g. keka-clockout): "
      name="${${name// /-}:l}"
      [[ -z "$name" ]] && continue
      file="recordings/${name}.json"
      if [[ -e "$file" ]]; then
        read "ok?$file exists. Replace it? [y/N]: "
        [[ "$ok" == [yY]* ]] || continue
      fi
      nexus record "$url" --out "$file" --profile "$PROFILE"
      ;;
    3)
      read "url?Website address to log in to: "
      [[ -z "$url" ]] && continue
      nexus open "$url" --profile "$PROFILE"
      ;;
    4|q|Q|"")
      exit 0
      ;;
    *)
      echo "Please choose 1, 2, 3 or 4."
      ;;
  esac
done
