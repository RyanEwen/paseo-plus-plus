import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Windows runners fail with EMFILE when thousands of writes start at once.
const WRITE_BATCH_SIZE = 64;

/** Fill a profile's todos directory one entry past the launch audit's 10,000-entry bound. */
export async function seedOversizedClaudeHome(home: string): Promise<void> {
  const todos = path.join(home, "todos");
  await mkdir(todos);
  const names = Array.from({ length: 10_001 }, (_, index) => `${index}.json`);
  for (let start = 0; start < names.length; start += WRITE_BATCH_SIZE) {
    const batch = names.slice(start, start + WRITE_BATCH_SIZE);
    await Promise.all(batch.map((name) => writeFile(path.join(todos, name), "")));
  }
}
