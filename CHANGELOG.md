# Changelog

## [Unreleased]

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

[Unreleased]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Nouvelle-Lune/lune-shell-inspector/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Nouvelle-Lune/lune-shell-inspector/releases/tag/v1.0.0
