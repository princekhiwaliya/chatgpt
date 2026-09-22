#!/bin/bash
# Double-click launcher for macOS and Linux.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo
  echo "  Install it once from https://nodejs.org (pick the LTS button),"
  echo "  then double-click this file again."
  echo
  read -r -p "  Press Enter to close..."
  exit 1
fi

node pcg.js "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "  Nothing was saved. See the checklist above."
fi
read -r -p "Press Enter to close..."
exit $status
