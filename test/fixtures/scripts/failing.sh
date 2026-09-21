#!/usr/bin/env bash
# Fixture: a few stdout lines, then stderr lines, then a non-zero exit.
# The 0.5s gaps spread the output over about two seconds so partial snapshots can be observed,
# and the mixed streams prove both are accumulated into the single reported output.
set -u

echo "build: step 1 ok"
sleep 0.5
echo "build: step 2 ok"
sleep 0.5
echo "build: step 3 skipped" >&2
sleep 0.5
echo "error: missing artifact" >&2
sleep 0.5
echo "fatal: aborting with code 3" >&2
exit 3
