import { normalizePathForIdentity } from "./path.js";

/** Serialize destination selection and Git creation within each existing project directory. */
export class WorktreeCreationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Keep exact conflicts and legacy suffix allocation atomic across daemon callers.
   * The caller creates the project directory before entering; absent destination paths
   * must not supply the identity key. Setup runs outside this short creation lane.
   */
  async run<T>(projectDirectory: string, create: () => Promise<T>): Promise<T> {
    const key = normalizePathForIdentity(projectDirectory);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);
    try {
      await previous;
      return await create();
    } finally {
      // Only resolved barriers are queued, so a failed creation cannot poison its successor.
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
