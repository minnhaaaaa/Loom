import { afterEach, expect, it, vi } from "vitest";
const driver = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@exasol/exasol-driver-ts", async (original) => ({
  ...(await original<object>()),
  ExasolDriver: class {
    connect = driver.connect;
    query = driver.query;
    close = driver.close;
  },
}));
import { readDatabase, writeDatabase, coordinatorState } from "@loom/db-exasol";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it("rejects stalled driver queries and releases the write queue at the deadline", async () => {
  vi.useFakeTimers();
  vi.stubEnv("EXASOL_HOST", "127.0.0.1");
  vi.stubEnv("EXASOL_USER", "fixture");
  vi.stubEnv("EXASOL_PASSWORD", "fixture");
  vi.stubEnv("EXASOL_CA_FILE", "");
  driver.connect.mockResolvedValue(undefined);
  driver.query.mockImplementation(() => new Promise(() => {}));
  driver.close.mockImplementation(() => new Promise(() => {}));
  const pending = writeDatabase((sql) => sql.query("SELECT 1"));
  const rejected = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(coordinatorState.pending).toBe(0);
  expect(driver.close).not.toHaveBeenCalled();
  const read = readDatabase((sql) => sql.query("SELECT 1"));
  const readRejected = expect(read).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20_000);
  await readRejected;
});
