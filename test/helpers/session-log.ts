/**
 * Seeding helper for durable session logs.
 *
 * Tests that model a session entry recorded by an *earlier* run (after `/quit`, `/resume`, `/new`,
 * `/fork`, `/tree`) must not hand-write the snapshot format: a hand-written fixture would keep
 * passing after `clearAllJobs(pi)` changed its payload, and it would test nothing about what the
 * running code persists. {@link appendShellStatus} asks the real code to serialize its jobs, so a
 * seeded branch always matches the writer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ShellManager } from "../../src/shell/shell-manager.ts";
import {
    FakeSessionLog,
    type AppendEntryCall,
    type FakeSessionLogOptions,
} from "../harness.ts";

/** Custom entry type of one persisted shell view snapshot. */
export const SHELL_STATUS_ENTRY = "lune-shell-view-status";

/** Snapshot payload of one `lune-shell-view-status` entry. */
export interface ShellStatusSnapshot {
    jobs: Array<Record<string, unknown> & { id: string; output: Record<string, unknown> }>;
    stats: {
        runningCount: number;
        completedCount: number;
        failedCount: number;
        killedCount: number;
    };
}

/** Minimal `ExtensionAPI` whose `appendEntry` records calls instead of writing a session file. */
export function recordingPi(): { pi: ExtensionAPI; calls: AppendEntryCall[] } {
    const calls: AppendEntryCall[] = [];
    const pi = {
        appendEntry: (customType: string, data?: unknown) => {
            calls.push({ customType, data });
        },
    } as unknown as ExtensionAPI;
    return { pi, calls };
}

/**
 * Append one shell snapshot of the manager's current jobs to `log`, through the real writer.
 *
 * `clearAllJobs(pi)` is the only production path that persists a snapshot, so it is the one used
 * here: the call aborts running jobs, records the payload, and empties the manager. The recorded
 * payload is returned for assertions.
 */
export function appendShellStatus(manager: ShellManager, log: FakeSessionLog): ShellStatusSnapshot {
    const { pi, calls } = recordingPi();
    manager.clearAllJobs(pi);

    if (calls.length !== 1) {
        throw new Error(`expected one persisted snapshot, got ${calls.length}`);
    }
    if (calls[0]!.customType !== SHELL_STATUS_ENTRY) {
        throw new Error(`unexpected entry type: ${calls[0]!.customType}`);
    }

    log.append({
        type: "custom",
        customType: SHELL_STATUS_ENTRY,
        data: calls[0]!.data,
    });
    return calls[0]!.data as ShellStatusSnapshot;
}

/** An empty session log, as a session file starts out. */
export function newSessionLog(options: FakeSessionLogOptions = {}): FakeSessionLog {
    return new FakeSessionLog(options);
}

/** Append an arbitrary payload as a shell status entry - for malformed or hand-made snapshots. */
export function appendRawShellStatus(log: FakeSessionLog, data: unknown): void {
    log.append({ type: "custom", customType: SHELL_STATUS_ENTRY, data });
}
