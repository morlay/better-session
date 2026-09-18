import { describe, expect, it } from "vitest";
import { DESKTOP_HOST_PROTOCOL_VERSION } from "../host-protocol.ts";

describe("protocol constants", () => {
  it("keeps the IPC-only generation the desktop host implements", () => {
    expect(DESKTOP_HOST_PROTOCOL_VERSION).toBe(4);
  });
});
