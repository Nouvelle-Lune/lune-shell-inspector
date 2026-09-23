#!/usr/bin/env bash
# Fixture: a spinner that erases and rewrites one line, twenty frames every 100ms.
# Where the progress fixture only uses carriage returns, this one also exercises erase-line (CSI K),
# SGR colour and a screen that must end up holding just the finished line.
set -u

frames=('|' '/' '-' '\')

for ((i = 1; i <= 20; i++)); do
    printf '\033[2K\r\033[36m%s\033[0m installing dependencies %3d%%' "${frames[$((i % 4))]}" "$((i * 5))"
    sleep 0.1
done
printf '\033[2K\rspinner: done\n'
