#!/usr/bin/env bash
# Fixture: one run through every VT shape the shell inspector has to render as screen state instead
# of raw text - carriage-return redraws, erase-line, cursor movement, SGR colour and bold, an ANSI
# sequence split across pipe reads, a carriage return split across pipe reads, Japanese wide cells
# and a line wider than the emulator.
# The pauses are the point: they make the reader hand the pieces over as separate chunks, which is
# what the streaming path really sees.
set -u

# 1. Carriage-return redraws (the tqdm shape): three states, only the last one is on screen.
printf 'progress 1%%\rprogress 2%%\rprogress 3%%\n'
sleep 0.3

# 2. Erase-line: the whole line is wiped before the replacement is written.
printf 'foo bar baz\x1b[2K\rbar\n'
sleep 0.3

# 3. Cursor movement: left overwrites in place, right skips ahead over blank cells, up returns to
#    the row above (the scratch row it came from is erased afterwards).
printf 'cursor-left : abcdef'
printf '\x1b[3DXY'
printf '\n'
printf 'cursor-right: AB'
printf '\x1b[3CXY'
printf '\n'
printf 'cursor-up   : aaaa\nscratch     : bbbb'
printf '\x1b[A\x1b[15Ghit!\n\x1b[2K'
sleep 0.3

# 4. SGR colour and bold: the screen keeps the text, the pane never sees the styling.
printf '\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m\n'
sleep 0.3

# 5. An SGR sequence split across reads: `ESC [` arrives long before `31m`.
printf '\x1b['
sleep 0.4
printf '31mchunked red'
sleep 0.4
printf '\x1b[0m\n'

# 6. A carriage return split across reads: the overwrite spans three chunks.
printf 'progress 1'
sleep 0.4
printf '%%\rprog'
sleep 0.4
printf 'ress 2%%\n'

# 7. Japanese kanji, hiragana, katakana and emoji, mixed with SGR and a carriage return.
printf '\r\033[33m日本語の進捗: 00%%\033[0m'
sleep 0.4
printf '\r\033[33m日本語の進捗テスト: 五割 🚀\033[0m\n'

# 8. A line wider than the emulator (140 columns) so the wrap has to be joined back into one line.
printf 'wide: %s\n' "$(printf '漢%.0s' $(seq 1 70))"

sleep 0.3
printf 'vt-shapes: done\n'
