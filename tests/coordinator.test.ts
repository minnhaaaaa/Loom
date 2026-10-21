import { expect, it } from "vitest";
import { coordinateWrite } from "@loom/db-exasol";
it("serializes overlapping commands and releases the queue after a failed command", async () => {
  const events: string[] = [];
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const first = coordinateWrite(async () => {
    events.push("first start");
    await gate;
    events.push("first end");
    throw new Error("rollback");
  });
  const observed = first.catch(() => undefined);
  const second = coordinateWrite(async () => {
    events.push("second");
    return 42;
  });
  await Promise.resolve();
  expect(events).toEqual(["first start"]);
  unlock();
  await observed;
  expect(await second).toBe(42);
  expect(events).toEqual(["first start", "first end", "second"]);
});
