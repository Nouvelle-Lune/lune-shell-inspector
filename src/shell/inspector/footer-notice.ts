import type { ThemeColor } from "./job-format.ts";

const NOTICE_DURATION_MS = 1800;

export interface Notice {
    text: string;
    color: ThemeColor;
}

/** A message that replaces the footer's key hints until it expires on its own. */
export class FooterNotice {
    private current: Notice | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly onExpired: () => void;

    constructor(onExpired: () => void) {
        this.onExpired = onExpired;
    }

    get active(): Notice | undefined {
        return this.current;
    }

    show(text: string, color: ThemeColor): void {
        this.current = { text, color };

        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.current = undefined;
            this.timer = undefined;
            this.onExpired();
        }, NOTICE_DURATION_MS);
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}
