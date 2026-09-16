#!/usr/bin/env bash
# Start the Aegis-Agent planner + demo target + self-test harness.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/uvicorn ]; then
  echo "setting up venv…"
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r server/requirements.txt
fi

PORT="${AEGIS_PORT:-8077}"
echo
echo "  planner   : ${AEGIS_PLANNER:-heuristic}"
echo "  demo page : http://127.0.0.1:${PORT}/demo/"
echo "  self-test : http://127.0.0.1:${PORT}/tools/selftest.html"
echo "  audit log : http://127.0.0.1:${PORT}/v1/audit"
echo
echo "  load unpacked extension from: $(pwd)/extension"
echo

cd server
exec ../.venv/bin/uvicorn main:app --host 127.0.0.1 --port "$PORT"
