/** Stop stalled work. Model output extends an active turn's deadline. */
export class TeacherDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly started = Date.now();
  private phase = "starting app-server";
  private lastProgress = "none";

  private readonly fail: (error: Error) => void;
  private readonly timeoutMs: number;
  constructor(fail: (error: Error) => void, timeoutMs = 180_000) {
    this.fail = fail;
    this.timeoutMs = timeoutMs;
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
    this.stop();
    this.timer = setTimeout(() => {
      this.fail(
        new Error(
          `Codex teacher made no progress for ${this.timeoutMs / 1000} seconds while ${this.phase}. ` +
            `Last progress: ${this.lastProgress}. Elapsed: ${Math.round((Date.now() - this.started) / 1000)} seconds.`,
        ),
      );
    }, this.timeoutMs);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
