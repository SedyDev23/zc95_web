#!/bin/sh
# Container start-up: on the first run, put the example Lua scripts into the (empty) scripts volume,
# then hand over to the web server.
set -e

if [ -d /app/examples ] && [ -z "$(ls -A "$ZC95_SCRIPTS_ROOT" 2>/dev/null)" ]; then
  if mkdir -p "$ZC95_SCRIPTS_ROOT/examples" 2>/dev/null && cp -r /app/examples/. "$ZC95_SCRIPTS_ROOT/examples/" 2>/dev/null; then
    echo "Copied example scripts to $ZC95_SCRIPTS_ROOT/examples"
  else
    echo "Note: couldn't write to $ZC95_SCRIPTS_ROOT (is it owned by uid 1000?) - skipping example scripts"
  fi
fi

exec "$@"
