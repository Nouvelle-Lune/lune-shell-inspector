#!/usr/bin/env bash
# Fixture: 200 numbered lines, four every 120ms (about six seconds of streaming output).
# Long enough to overflow the shell inspector's output pane on any terminal, so the scroll keys
# (Shift+Up/Shift+K, Shift+Down/Shift+J, Home, End) have something to move over while the run
# streams and after it settled. Lines are emitted in batches: spawning one external `sleep` per line
# costs more than the delay itself on macOS, which would stretch the fixture far past six seconds.
set -u

lines=200
batch=4

for ((i = 1; i <= lines; i += batch)); do
    for ((j = 0; j < batch && i + j <= lines; j++)); do
        printf '[long] line %03d of %d ................................\n' "$((i + j))" "$lines"
    done
    sleep 0.12
done
