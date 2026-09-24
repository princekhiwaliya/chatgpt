#!/bin/bash
# Double-click launcher for macOS and Linux: starts the local web app.
cd "$(dirname "$0")" || exit 1

pause_if_tty() { if [ -t 0 ]; then read -r -p "$1"; fi; }

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js install nahi hai."
  echo
  echo "  https://nodejs.org kholiye, bada LTS button dabaiye,"
  echo "  install kijiye, phir is file par dobara double-click kijiye."
  echo
  pause_if_tty "  Press Enter to close..."
  exit 1
fi

echo
echo "  Starting... browser apne aap khulega."
echo
node server.js "$@"
status=$?
echo
echo "  Server band ho gaya."
pause_if_tty "  Press Enter to close..."
exit $status
