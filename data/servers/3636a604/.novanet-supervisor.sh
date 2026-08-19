#!/bin/sh
PIDFILE="/tmp/novanet-app.pid"
STATEFILE="/tmp/novanet-app.state"
MAX_CRASH=5
BACKOFF=3

cd /home/container || exit 1
echo $$ > "$PIDFILE"

cleanup() {
  echo "stopped" > "$STATEFILE"
  rm -f "$PIDFILE"
  exit 0
}
trap cleanup TERM INT

crash=0
echo "running" > "$STATEFILE"
while true; do
  sh /home/container/.novanet-start.sh
  code=$?

  if [ "$code" -eq 0 ]; then
    echo "stopped" > "$STATEFILE"
    rm -f "$PIDFILE"
    exit 0
  fi
  crash=$((crash + 1))
  echo "[supervisor] proses berhenti (exit $code), percobaan $crash/$MAX_CRASH" >>"$LOGFILE"
  if [ "$crash" -ge "$MAX_CRASH" ]; then
    echo "[supervisor] menyerah setelah $MAX_CRASH kali gagal berturut-turut." >>"$LOGFILE"
    echo "crashed" > "$STATEFILE"
    rm -f "$PIDFILE"
    exit 1
  fi
  echo "retrying" > "$STATEFILE"
  sleep "$BACKOFF"
  echo "running" > "$STATEFILE"
done

