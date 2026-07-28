#!/bin/bash
# Booking Bandit - Local Engine Setup (macOS). Double-click to run.
# If macOS says "cannot verify developer": right-click this file -> Open -> Open.
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "============================================================"
echo "  Booking Bandit - Local Engine Setup (macOS)"
echo "============================================================"
echo ""
echo "This registers the Booking Bandit helper so Chrome can use"
echo "your local Claude. No typing needed - just wait for it to finish."
echo ""
bash "$DIR/local-engine/install/install-mac.sh"
STATUS=$?
echo ""
echo "============================================================"
if [ $STATUS -eq 0 ]; then
  echo "  DONE. If you see \"SMOKE PASS\" above, setup worked."
  echo "  Next: FULLY quit Chrome (Cmd-Q) and reopen it, then open"
  echo "  Booking Bandit > Settings > Key > \"Test local engine\"."
else
  echo "  SETUP HIT A PROBLEM. Send Joe a screenshot of this window."
fi
echo "============================================================"
echo ""
echo "Press any key to close this window."
read -n 1 -s
