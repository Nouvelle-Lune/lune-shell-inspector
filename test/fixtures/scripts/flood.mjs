// Fixture: paced output that exceeds the built-in bash truncation limits (2000 lines / 50KB).
// 50 batches x 100 lines x 40ms emit ~5000 lines / ~200KB over about two seconds, so both the
// line and the byte limit are crossed while the request is still streaming.
const BATCHES = 50;
const LINES_PER_BATCH = 100;
const BATCH_DELAY_MS = 40;

let line = 0;
for (let batch = 0; batch < BATCHES; batch += 1) {
    let chunk = "";
    for (let i = 0; i < LINES_PER_BATCH; i += 1) {
        line += 1;
        chunk += `flood line ${String(line).padStart(5, "0")} ${"x".repeat(24)}\n`;
    }
    process.stdout.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
}
