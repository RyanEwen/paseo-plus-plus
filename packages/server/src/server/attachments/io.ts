/**
 * Run an operation, then always close its resource, preserving both failures in operation
 * order. When both fail, the AggregateError carries `message` and the operation failure as
 * its cause; a lone close failure is rethrown as is.
 */
export async function withAttachmentResource<T>(
  operation: () => Promise<T>,
  close: () => Promise<void>,
  message = "Attachment operation and resource close failed.",
): Promise<T> {
  let result: { value: T } | { failure: unknown };
  try {
    result = { value: await operation() };
  } catch (failure) {
    result = { failure };
  }
  let cleanup: { failure: unknown } | undefined;
  try {
    await close();
  } catch (failure) {
    cleanup = { failure };
  }
  if (cleanup) {
    if ("failure" in result)
      throw new AggregateError([result.failure, cleanup.failure], message, {
        cause: result.failure,
      });
    throw cleanup.failure;
  }
  if ("failure" in result) throw result.failure;
  return result.value;
}

/** Close a resource after `failure`, then rethrow it (aggregated with any close failure). */
export function closeAfterFailure(failure: unknown, close: () => Promise<void>): Promise<never> {
  return withAttachmentResource<never>(() => Promise.reject(failure), close);
}

/** Whether `error` is a Node system error with the given errno code. */
export function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
