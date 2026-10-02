# Changelog

## [Unreleased]

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

### Changed

- **BREAKING:** **Background `bash` results are structured in codemode.** A background call now
  resolves to `{ background, command, shell_job_id }` instead of a string, so a script reads the job
  id as a field instead of parsing the text; scripts that treated the background result as text must
  switch to `shell_job_id`. Foreground results keep the built-in
  `{ output, truncated, exit_code, wall_time_seconds }` shape.
- **`/shell` opens on an empty job list.** The inspector renders an empty frame instead of doing
  nothing when there are no shell jobs, and clearing the last entry keeps that frame on screen
  rather than closing the overlay.

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

[Unreleased]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Nouvelle-Lune/lune-shell-inspector/releases/tag/v1.0.0
