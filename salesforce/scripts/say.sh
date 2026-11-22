#!/bin/bash
# Usage: scripts/say.sh <sessionId> "<utterance>"
# Sends one preview utterance, prints the spoken reply, then the compact trace.
set -e
S="$1"; shift
sf agent preview send --json --authoring-bundle HVAC_Service_Voice_Agent --session-id "$S" -u "$*" 2>/dev/null \
  | python3 -c "
import json,sys
raw=sys.stdin.read(); raw=raw[raw.index('{'):]
d=json.loads(raw)
if 'result' not in d:
    print('ERROR', json.dumps(d)[:600]); raise SystemExit(1)
for m in d['result']['messages']:
    print('AGENT:', m.get('message'))
"
python3 "$(dirname "$0")/trace.py" "$S" 1
