import { expect, test } from "vitest";
import { HistoryIdentityCommittedError, HistoryStorageConflictError } from "./binding.js";

test("a committed identity error reports its committed session in the reason and message", () => {
  const error = new HistoryIdentityCommittedError("forked-session-1");
  expect(error).toBeInstanceOf(HistoryStorageConflictError);
  expect(error.reason).toBe("rewind-committed-adoption-failed");
  expect(error.committedSessionId).toBe("forked-session-1");
  expect(error.describe()).toBe("rewind-committed-adoption-failed:forked-session-1");
  expect(error.message).toBe(
    "Configured provider history cannot use this route: rewind-committed-adoption-failed:forked-session-1",
  );
});

test("a plain conflict describes itself by its reason alone", () => {
  const error = new HistoryStorageConflictError("history-symlink");
  expect(error.describe()).toBe("history-symlink");
  expect(error.message).toBe("Configured provider history cannot use this route: history-symlink");
});
