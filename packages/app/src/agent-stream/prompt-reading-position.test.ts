import { describe, expect, it, vi } from "vitest";
import { createPromptReadingPublisher } from "./prompt-reading-position";

describe("createPromptReadingPublisher", () => {
  it("fills omitted fields with the defaults of a manual, unmeasured sample", () => {
    const reading = createPromptReadingPublisher();

    reading.publish({ rowId: "row-1" });

    expect(reading.getSnapshot()).toEqual({
      rowId: "row-1",
      seq: null,
      navigating: false,
      following: false,
      manual: true,
    });
  });

  it("notifies only when the sample changes", () => {
    const reading = createPromptReadingPublisher();
    const listener = vi.fn();
    reading.subscribe(listener);

    reading.publish({ rowId: "row-1", seq: 4 });
    reading.publish({ rowId: "row-1", seq: 4 });
    reading.publish({ rowId: "row-2", seq: 4 });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying an unsubscribed listener", () => {
    const reading = createPromptReadingPublisher();
    const listener = vi.fn();
    const unsubscribe = reading.subscribe(listener);

    unsubscribe();
    reading.publish({ rowId: "row-1" });

    expect(listener).not.toHaveBeenCalled();
  });
});
