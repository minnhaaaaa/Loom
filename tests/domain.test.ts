import { describe, expect, it } from "vitest";
import { applyCommand } from "@loom/domain";
import { intakeSchema, personas, type Membership } from "@loom/contracts";
import { sampleRequests } from "../packages/contracts/src/fixtures";
const members: Membership[] = personas.map((p) => ({
  userId: p.id,
  name: p.name,
  role: p.role,
}));
describe("request commands", () => {
  it("rejects forged operational changes from a requester and all viewer writes", () => {
    expect(() =>
      applyCommand(
        members[2],
        sampleRequests[0],
        { type: "set_owner", ownerId: members[2].userId },
        members,
      ),
    ).toThrow("Only an owner or operator");
    expect(() =>
      applyCommand(
        members[3],
        sampleRequests[0],
        { type: "add_comment", body: "hello", visibility: "requester_visible" },
        members,
      ),
    ).toThrow("Viewers cannot");
  });
  it("does not reveal another requester’s record", () => {
    expect(() =>
      applyCommand(
        members[2],
        sampleRequests[2],
        { type: "edit_description", values: sampleRequests[2] },
        members,
      ),
    ).toThrow("Request not found");
  });
  it("enforces transitions and readiness instead of blindly accepting a patch", () => {
    expect(() =>
      applyCommand(
        members[0],
        sampleRequests[1],
        { type: "set_status", status: "ready" },
        members,
      ),
    ).toThrow("reporting period and dataset");
    expect(() =>
      applyCommand(
        members[0],
        sampleRequests[1],
        { type: "set_status", status: "done" },
        members,
      ),
    ).toThrow("not allowed");
    expect(
      applyCommand(
        members[0],
        sampleRequests[0],
        { type: "set_status", status: "done" },
        members,
      ).version,
    ).toBe(2);
  });
  it("rejects assigning work to an inactive/foreign/non-operator owner", () => {
    expect(() =>
      applyCommand(
        members[0],
        sampleRequests[0],
        { type: "set_owner", ownerId: members[2].userId },
        members,
      ),
    ).toThrow("active owner or operator");
  });
  it("does not allow a requester to create internal comments", () => {
    expect(() =>
      applyCommand(
        members[2],
        sampleRequests[0],
        { type: "add_comment", body: "test", visibility: "internal" },
        members,
      ),
    ).toThrow("requester-visible");
  });
  it("rejects extra intake fields and normalizes whitespace", () => {
    expect(
      intakeSchema.safeParse({
        title: "  A request ",
        businessQuestion: "why?",
        status: "done",
      }).success,
    ).toBe(false);
    expect(
      intakeSchema.parse({ title: "  A request ", businessQuestion: "why?" })
        .title,
    ).toBe("A request");
  });
});
