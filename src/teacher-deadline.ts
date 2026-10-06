/** Bound each request. Model output resets only the inactivity timer. */
export class TeacherDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private totalTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly started = Date.now();
  private phase = "starting app-server";
  private lastProgress = "none";

  private readonly fail: (error: Error) => void;
  private readonly timeoutMs: number;
  constructor(fail: (error: Error) => void, timeoutMs = 180_000, totalTimeoutMs = 300_000) {
    this.fail = fail;
    this.timeoutMs = timeoutMs;
    this.totalTimer = setTimeout(() => {
      this.expire(
        new Error(
          `Codex teacher exceeded the ${totalTimeoutMs / 1000} second request limit while ${this.phase}. ` +
            `Last progress: ${this.lastProgress}. Elapsed: ${Math.round((Date.now() - this.started) / 1000)} seconds.`,
        ),
      );
    }, totalTimeoutMs);
    this.arm();
  }

  enter(phase: string): void {
    this.phase = phase;
    this.lastProgress = "none";
    this.arm();
  }

  progress(detail: string): void {
    this.lastProgress = detail;
    this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.expire(
        new Error(
          `Codex teacher made no progress for ${this.timeoutMs / 1000} seconds while ${this.phase}. ` +
            `Last progress: ${this.lastProgress}. Elapsed: ${Math.round((Date.now() - this.started) / 1000)} seconds.`,
        ),
      );
    }, this.timeoutMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.totalTimer);
  }

  private expire(error: Error): void {
    if (this.stopped) return;
    this.stop();
    this.fail(error);
  }
}
