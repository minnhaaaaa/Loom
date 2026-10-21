import { beforeEach, expect, it, vi } from "vitest";
const driver = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  query: vi.fn(),
  prepare: vi.fn(),
  sendCommand: vi.fn(),
  statementClose: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@exasol/exasol-driver-ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../packages/db-exasol/node_modules/@exasol/exasol-driver-ts")
    >();
  return {
    ...actual,
    ExasolDriver: class {
      connect = driver.connect;
      close = driver.close;
      query = driver.query;
      prepare = driver.prepare;
      sendCommand = driver.sendCommand;
    },
  };
});
import { openConnection, writeDatabase } from "@loom/db-exasol";
const ok = () => ({
  status: "ok",
  responseData: {
    numResults: 1,
    results: [{ resultType: "rowCount", rowCount: 1 }],
  },
});
beforeEach(() => {
  vi.stubEnv("EXASOL_HOST", "fixture.invalid");
  vi.stubEnv("EXASOL_USER", "fixture");
  vi.stubEnv("EXASOL_PASSWORD", "public-test-only");
  vi.stubEnv("EXASOL_CA_FILE", "");
  vi.stubEnv("EXASOL_SCHEMA", "LOOM");
  for (const mock of Object.values(driver)) mock.mockReset();
  driver.connect.mockResolvedValue(undefined);
  driver.close.mockResolvedValue(undefined);
  driver.query.mockImplementation(async () => ok());
  driver.execute.mockResolvedValue(ok());
  driver.statementClose.mockResolvedValue(undefined);
  driver.prepare.mockResolvedValue({
    execute: driver.execute,
    close: driver.statementClose,
  });
  driver.sendCommand.mockImplementation(async (command) => {
    if (command.command === "createPreparedStatement")
      return {
        status: "ok",
        responseData: {
          statementHandle: 1,
          parameterData: {
            columns: [{ name: "V", dataType: { type: "VARCHAR", size: 100 } }],
          },
        },
      };
    if (command.command === "executePreparedStatement")
      return driver.execute(
        ...command.data.map((column: unknown[]) => column[0]),
      );
    if (command.command === "closePreparedStatement") {
      await driver.statementClose();
      return { status: "ok", responseData: {} };
    }
    return { status: "ok", responseData: {} };
  });
});
it("commits the entire callback and closes its connection after success", async () => {
  const result = await writeDatabase(async (sql) => {
    await sql.execute("INSERT INTO FIRST_TABLE (ID) VALUES (?)", ["one"]);
    await sql.execute("INSERT INTO SECOND_TABLE (ID) VALUES (?)", ["two"]);
    return "saved";
  });
  expect(result).toBe("saved");
  expect(driver.execute.mock.calls).toEqual([["one"], ["two"]]);
  expect(driver.query.mock.calls.map(([sql]) => sql)).toEqual(["COMMIT"]);
  expect(driver.close).toHaveBeenCalledOnce();
});
it("rolls back after a partial callback failure and never commits", async () => {
  await expect(
    writeDatabase(async (sql) => {
      await sql.execute("INSERT INTO FIRST_TABLE (ID) VALUES (?)", ["one"]);
      throw new Error("second operation failed");
    }),
  ).rejects.toThrow("second operation failed");
  expect(driver.query.mock.calls.map(([sql]) => sql)).toEqual(["ROLLBACK"]);
  expect(driver.close).toHaveBeenCalledOnce();
});
it("never automatically replays a callback when commit acknowledgement is lost", async () => {
  driver.query.mockImplementation(async (sql) => {
    if (sql === "COMMIT") throw new Error("lost acknowledgement");
    return ok();
  });
  const work = vi.fn(async (sql) => {
    await sql.execute("INSERT INTO FIRST_TABLE (ID) VALUES (?)", ["one"]);
  });
  await expect(writeDatabase(work)).rejects.toThrow("lost acknowledgement");
  expect(work).toHaveBeenCalledOnce();
  expect(driver.connect).toHaveBeenCalledOnce();
  expect(driver.close).toHaveBeenCalledOnce();
});
it("retries a recognized pre-commit collision from the beginning, with a bounded limit", async () => {
  driver.query.mockImplementation(async (sql) =>
    sql === "COLLIDING WRITE"
      ? {
          status: "error",
          exception: {
            sqlCode: "40001",
            text: "fixture serialization failure",
          },
        }
      : ok(),
  );
  const work = vi.fn(async (sql) => {
    await sql.execute("COLLIDING WRITE");
  });
  await expect(writeDatabase(work)).rejects.toThrow(
    "rejected the database operation",
  );
  expect(work).toHaveBeenCalledTimes(3);
  expect(driver.close).toHaveBeenCalledTimes(3);
  expect(
    driver.query.mock.calls.filter(([sql]) => sql === "COMMIT"),
  ).toHaveLength(0);
});
it("fetches prepared-result pages and closes the cursor without losing rows", async () => {
  driver.execute.mockResolvedValue({
    status: "ok",
    responseData: {
      numResults: 1,
      results: [
        {
          resultType: "resultSet",
          resultSet: {
            resultSetHandle: 7,
            numColumns: 1,
            numRows: 3,
            numRowsInMessage: 1,
            columns: [{ name: "ID", dataType: { type: "VARCHAR" } }],
            data: [["first"]],
          },
        },
      ],
    },
  });
  const dispatch = driver.sendCommand.getMockImplementation()!;
  driver.sendCommand.mockImplementation(async (command) =>
    command.command === "fetch"
      ? {
          status: "ok",
          responseData: { numRows: 2, data: [["second", "third"]] },
        }
      : dispatch(command),
  );
  const connection = await openConnection();
  try {
    expect(
      await connection.session.query("SELECT ID FROM FIXTURE WHERE SCOPE = ?", [
        "scope",
      ]),
    ).toEqual([{ ID: "first" }, { ID: "second" }, { ID: "third" }]);
    expect(driver.statementClose).toHaveBeenCalledOnce();
    expect(
      driver.sendCommand.mock.calls
        .map(([command]) => command.command)
        .filter((name) => ["fetch", "closeResultSet"].includes(name)),
    ).toEqual(["fetch", "closeResultSet"]);
  } finally {
    await connection.close();
  }
});
