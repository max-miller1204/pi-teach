#!/bin/bash
# send.sh <json-message-text> ; waits until settled count increases
before=$(curl -s 127.0.0.1:4299 | node -pe 'JSON.parse(require("fs").readFileSync(0)).settled')
node -e 'process.stdout.write(JSON.stringify({type:"prompt",message:process.argv[1]}))' "$1" | curl -s -X POST 127.0.0.1:4299 --data-binary @- >/dev/null
for i in $(seq 1 120); do
  now=$(curl -s 127.0.0.1:4299 | node -pe 'JSON.parse(require("fs").readFileSync(0)).settled')
  [ "$now" -gt "$before" ] && break; sleep 5
done
curl -s 127.0.0.1:4299; echo
