#!/usr/bin/env bash
# Fixture: twenty timestamped log lines, one every 100ms (about two seconds of streaming output).
set -u

for ((i = 1; i <= 20; i++)); do
    printf '[log] %s line %02d of 20\n' "$(date '+%H:%M:%S')" "$i"
    sleep 0.1
done
