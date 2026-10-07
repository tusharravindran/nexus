#!/bin/zsh
# Creates NEXUS shortcuts on the Desktop as small macOS apps, which can be
# double-clicked or opened by Siri ("Hey Siri, open Keka Clock In").
#
#   scripts/install-shortcuts.sh
#       → NEXUS.app: opens the menu (run / record / log in) in Terminal
#   scripts/install-shortcuts.sh "Keka Clock In" recordings/sedin-clockin.json [profile]
#       → Keka Clock In.app: runs that task with a visible browser, then shows a
#         notification (and the report, if it failed). No Terminal window.
#
# Apps rather than .command files: macOS does not let Siri open documents in Terminal.

set -e
root="${0:A:h:h}"
desktop="${NEXUS_SHORTCUTS_DIR:-$HOME/Desktop}"

# Apps start with a minimal PATH, so remember where node is now (nvm installs are per-version).
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" && -s "$HOME/.nvm/nvm.sh" ]]; then source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; node_bin="$(command -v node || true)"; fi
if [[ -z "$node_bin" ]]; then echo "Node.js was not found; install it first."; exit 1; fi

# AppleScript string literal.
as_string() { local s="${1//\\/\\\\}"; print -r -- "\"${s//\"/\\\"}\""; }

compile() {
  local app="$desktop/$1.app" source="$(mktemp -t nexus-shortcut).applescript"
  print -r -- "$2" > "$source"
  rm -rf "$app"
  osacompile -o "$app" "$source"
  rm -f "$source" "$desktop/$1.command"   # replaces the older .command shortcut, if any
  echo "Created: $app"
}

if (( $# == 0 )); then
  compile "NEXUS" "tell application \"Terminal\"
  activate
  do script quoted form of $(as_string "$root/scripts/menu.sh")
end tell"
  exit 0
fi

title="$1"
task="$2"
profile="${3:-work}"
if [[ ! -f "$root/$task" ]]; then echo "No such task: $root/$task"; exit 1; fi

compile "$title" "set projectDir to $(as_string "$root")
set nodeBin to $(as_string "$node_bin")
set taskFile to $(as_string "$task")
set profileName to $(as_string "$profile")
set appTitle to $(as_string "$title")

set command to \"cd \" & quoted form of projectDir & \" && \" & quoted form of nodeBin & \" src/cli.ts run \" & quoted form of taskFile & \" --profile \" & quoted form of profileName & \" --headed 2>&1\"
try
  set output to do shell script command
  display notification \"Done: \" & my lastLine(output, \"PASSED\") with title appTitle sound name \"Glass\"
on error output
  set reportPath to my reportOf(output, projectDir)
  set answer to display dialog appTitle & \" failed.\" & return & return & my lastLine(output, \"✖\") buttons {\"Close\", \"Open Report\"} default button \"Open Report\" with icon caution
  if button returned of answer is \"Open Report\" and reportPath is not \"\" then do shell script \"open \" & quoted form of reportPath
end try

-- The last output line containing marker, e.g. \"✔ PASSED  2/2 steps in 3120ms\".
on lastLine(output, marker)
  set found to \"\"
  repeat with lineText in paragraphs of output
    if lineText contains marker then set found to (contents of lineText)
  end repeat
  if found is \"\" then set found to (last paragraph of output)
  return found
end lastLine

-- Absolute path of the run's report.html, from the \"report: <path>\" line.
on reportOf(output, projectDir)
  repeat with lineText in paragraphs of output
    set lineText to contents of lineText
    if lineText contains \"report: \" then
      set relativePath to text ((offset of \"report: \" in lineText) + 8) thru -1 of lineText
      if relativePath starts with \"/\" then return relativePath
      return projectDir & \"/\" & relativePath
    end if
  end repeat
  return \"\"
end reportOf"
