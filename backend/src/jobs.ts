/**
 * Background jobs that run inside the API process. Each job is guarded so a
 * failure is logged and retried on the next tick instead of crashing the API.
 */
type Job = { name: string; everyMs: number; run: () => Promise<void> };

const jobs: Job[] = [];
let started = false;

export function registerJob(job: Job): void {
  jobs.push(job);
}

export function startBackgroundJobs(): void {
  if (started || process.env.DISABLE_BACKGROUND_JOBS === 'true') return;
  started = true;
  for (const job of jobs) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (error) {
        console.error(`Background job ${job.name} failed:`, error instanceof Error ? error.message : error);
      } finally {
        running = false;
      }
    };
    setInterval(() => void tick(), job.everyMs).unref();
  }
}
