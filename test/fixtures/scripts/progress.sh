#!/usr/bin/env bash
# Fixture: a single line refreshed in place with carriage returns.
# 40 steps x 50ms keep the request alive for about two seconds and stream a growing snapshot,
# then the script terminates the line with a newline before exiting successfully.
set -u

steps=40
for ((i = 1; i <= steps; i++)); do
    printf '\rprogress: %3d%%' "$((i * 100 / steps))"
    sleep 0.05
done
printf '\nprogress: done\n'
