#!/bin/bash
# Check if energy-controller watchdog heartbeat is stale
# Run via cron: */10 * * * * /opt/energy-controller/scripts/check-watchdog.sh
LOG="/opt/energy-controller/data/watchdog.log"
ALERT="/opt/energy-controller/data/watchdog-alert.txt"

if [ ! -f "$LOG" ]; then
  echo "$(date -Iseconds) watchdog.log not found" >> "$ALERT"
  exit 0
fi

LAST_LINE=$(tail -1 "$LOG")
LAST_TS=$(echo "$LAST_LINE" | grep -oP '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}' | head -1)

if [ -z "$LAST_TS" ]; then
  echo "$(date -Iseconds) cannot parse timestamp from: $LAST_LINE" >> "$ALERT"
  exit 0
fi

LAST_EPOCH=$(date -d "$LAST_TS" +%s 2>/dev/null)
NOW_EPOCH=$(date +%s)
DIFF=$(( NOW_EPOCH - LAST_EPOCH ))

if [ "$DIFF" -gt 900 ]; then
  # Last heartbeat > 15 min ago
  if echo "$LAST_LINE" | grep -q "HEARTBEAT"; then
    # Last entry was HEARTBEAT, no SHUTDOWN → ungraceful death
    echo "$(date -Iseconds) UNGRACEFUL DEATH detected! Last heartbeat: $LAST_TS (${DIFF}s ago). Last line: $LAST_LINE" >> "$ALERT"
  elif echo "$LAST_LINE" | grep -q "SHUTDOWN"; then
    # Graceful shutdown, service should have restarted via systemd
    echo "$(date -Iseconds) Graceful SHUTDOWN at $LAST_TS (${DIFF}s ago). Service should be restarting." >> "$ALERT"
  fi
fi

