# Changelog

## [Unreleased]

### Added

- **Auto-hiding scrollbars in `/shell`.** Overflowing output and shell lists now show themed
  scrollbars during scrolling or shell selection, hiding independently after one second of inactivity.
  The bars reflect each viewport without covering text or changing the pause-and-follow behavior.
- **The `/shell` inspector remembers the selected shell.** Closing the overlay and reopening `/shell`
  resumes on the shell that was selected last instead of jumping back to the first entry. The
  position is memory-only view state: it is not written to the session snapshot, and clearing the
  shell list (new session, shutdown, tree navigation) resets it to the first shell.

### Changed

- **Background shell notifications now appear in the transcript.** A settled shell - or one batch of
  them - draws a tool-result band under the command that started it: a status header, one row per
  job with its command, outcome and runtime, and the tail of its output, which `ctrl+o` expands to
  the full text. The agent-facing message is unchanged, and the box reads the output from that same
  message instead of storing a second copy; job ids stay in the message, not in the row, because
  only the agent needs them.

### Fixed

- **Inspector output wraps instead of truncating long lines.** The detail pane reflows output to its
  width, preserving long lines and wide characters without ellipses. Scrolling moves through the
  wrapped rows, so content taller than the pane remains readable with the existing controls.
- **`/shell` no longer lags while scrolling.** Every repaint re-read and re-wrapped the whole
  scrollback, so a wheel tick over a 2000-line output cost ~18ms and a one-second refresh or
  streaming burst ~9–11ms. Wrapped rows are now cached per screen revision and width, and a pane
  that follows the newest output wraps only its last rows, which brings those frames to ~0.2–1.2ms.
  `ShellManager` gains `getScreenRevision(id)` for readers that cache what they derive from a screen.

- **A flooding background shell no longer crashes the host.** Output that arrived faster than the
  screen emulator parsed it (`yes`, a verbose build) piled up until xterm threw
  `write data discarded` from the stream handler, which exited pi. Output is now fed to the
  emulator with flow control that drops the oldest unparsed output, so the screen still ends with
  the newest; the retained text and the spill file are unaffected.

### Refactored

- **Split `shell-inspector.ts` into `src/shell/inspector/`.** The 830-line component is now a
  ~440-line orchestrator for input, selection and timers, with layout, frame, panes, scrollbars,
  footer notice, output rows and the output viewport in their own modules. Rendering and key
  behavior are unchanged.

## [1.1.0] - 2026-10-02

### Added

- **Agent kill tool.** `kill_background_shell` stops one managed background shell by its job ID,
  aborting the shell's process tree through the same manager primitive as `/shell`'s `x` key so the
  agent never needs a pid. A killed shell stays listed as `killed`, with its output still readable
  through `background_shell` and `/shell`, until it is explicitly cleared.
- **Shell labels.** Background `bash` calls accept an optional `label`: a short human-readable
  name that `/shell` shows in the job list instead of the command, since the left pane is too
  narrow to show most commands. Labels are trimmed, blank ones are ignored, and they survive
  session restore.
- **Inspector clear key.** Pressing `c` in `/shell` removes the selected shell when it has settled
  (`completed`, `failed` or `killed`) and refuses a running one without touching its process. The
  footer answers either outcome with a short-lived notice that replaces the key hints, and the
  persistent hints now advertise `c to clear`.
- **Mouse support in `/shell`.** In pi's fullscreen mode, the wheel scrolls the output pane (with the
  same pause-and-follow behavior as the scroll keys) or moves the selection over the job list, and a
  left click selects a job. Presses elsewhere are left to pi's text selection, and regular mode keeps
  the keyboard-only controls.
- **Back-to-bottom label.** While the output is paused, the separator under the panes shows a
  clickable `[ ↓ Back to bottom · End ]` label that resumes following the newest output.

### Changed

- **BREAKING:** **Background `bash` results are structured in codemode.** A background call now
  resolves to `{ background, command, shell_job_id }` instead of a string, so a script reads the job
  id as a field instead of parsing the text; scripts that treated the background result as text must
  switch to `shell_job_id`. Foreground results keep the built-in
  `{ output, truncated, exit_code, wall_time_seconds }` shape.
- **BREAKING:** **The pi peer requirements are explicit.** `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` are declared as `>=1.0.0` instead of `*`, so a pre-1.0 pi installation
  fails the install instead of loading against an unsupported API; upgrade pi to 1.0.0 or newer.
- **`/shell` opens on an empty job list.** The inspector renders an empty frame instead of doing
  nothing when there are no shell jobs, and clearing the last entry keeps that frame on screen
  rather than closing the overlay.
- **Background shell notifications are batched and failure-tolerant.** Terminal job events now
  accumulate into one steering message per batch, with `details.jobs[]` replacing the single
  `shellJobId`, and a failed delivery keeps a per-notification budget of two retries through the
  normal batching scheduler instead of crashing Pi with an unhandled rejection. Exhausted
  notifications are reported through the session UI (stderr when headless) and dropped without
  blocking later ones.

## [1.0.3] - 2026-09-28

### Fixed

- **Command previews are normalized in `/shell` too.** The inspector renders job commands through the same
  formatter as the dock (`src/shell/shell-command.ts`), so terminal sequences, carriage returns, newlines,
  tabs and repeated spaces can no longer break the job list or the selected-job header.

## [1.0.2] - 2026-09-26

### Added

- **Inspector kill key.** Pressing `x` in `/shell` stops the selected running shell: its process
  tree is aborted and the agent receives exactly one steering notification carrying the shell id,
  command, kill reason and the output collected so far.

### Changed

- **Display-width command truncation.** The dock measures the command in terminal columns instead
  of UTF-16 code units, so CJK and emoji commands are cut at a text-element boundary and the `…`
  marker stays inside the 20-column budget.
- **Status-colored dock summary.** Running, completed, failed and killed segments now carry their
  own colors with dim separators, and mixed job lists render per-status counts.

### Fixed

- **Lifecycle kills no longer notify.** Leaving a branch (`session_before_tree`) stops running
  shells and persists them as `killed` without sending a background-shell notification or
  triggering an agent turn; `session_tree` restores that state.
- **Listener failures are isolated.** A throwing `ShellManager` subscriber no longer prevents later
  subscribers from receiving the event, nor makes `startJob()` / `appendOutput()` / `settleJob()`
  fail after the mutation was applied.
- **Control bytes can no longer break the dock.** Commands are stripped of terminal sequences and
  have carriage returns, newlines and tabs collapsed before truncation, so the dock stays one line.
- **Notification delivery matches pi's API.** The notifier calls `pi.sendMessage()` synchronously
  (it returns `void`, and pi owns delivery errors), so a synchronous throw from a stale extension
  API can no longer roll back the settled job state or escape as an unhandled rejection.

## [1.0.1] - 2026-09-25

### Changed

- README leads with npm installation and badges, and the preview image uses an absolute URL.

## [1.0.0] - 2026-09-25

### Added

- Initial release: background `bash` mode with a shared shell manager, the one-line shell dock, the
  `/shell` inspector with output scrolling, the `background_shell` status/output tool, bounded
  output retention with full-output spill files, terminal-screen rendering of streamed output, and
  persistence/restore of shell state across session lifecycle events.

[Unreleased]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Nouvelle-Lune/lune-shell-inspector/releases/tag/v1.0.0
