/**
 * Split a GitHub Actions workflow into its jobs: a map from job id to the job's own lines.
 *
 * Mirrors the parser in scripts/ci-workflow.test.mjs so fork workflow contract tests can live
 * beside the code they cover. Only two-space job keys under `jobs:` start a job.
 */
export function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}
