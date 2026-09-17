import { describe, expect, it } from "vitest";
import {
  DESKTOP_CONTROL_IPC_FD,
  DESKTOP_HOST_PROTOCOL_VERSION,
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  DesktopHostResponseDecoder,
  encodeDesktopRequestCancel,
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestStart,
} from "../host-protocol.ts";

const FRAME_MAGIC = 0x44534833;
const FRAME_HEADER_BYTES = 13;
const MAX_CONTROL_PAYLOAD_BYTES = 1024 * 1024;

const RESPONSE_START = 1;
const RESPONSE_DATA = 2;
const RESPONSE_END = 3;
const RESPONSE_ERROR = 4;

const REQUEST_START = 1;
const REQUEST_DATA = 2;
const REQUEST_END = 3;
const REQUEST_CANCEL = 4;

function frame(type: number, streamId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(FRAME_MAGIC, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(streamId, 5);
  header.writeUInt32BE(payload.byteLength, 9);
  return Buffer.concat([header, payload]);
}

function jsonFrame(type: number, streamId: number, value: unknown): Buffer {
  return frame(type, streamId, Buffer.from(JSON.stringify(value), "utf8"));
}

interface ParsedFrame {
  readonly magic: number;
  readonly type: number;
  readonly streamId: number;
  readonly length: number;
  readonly payload: Buffer;
}

function parseFrame(bytes: Buffer): ParsedFrame {
  return {
    magic: bytes.readUInt32BE(0),
    type: bytes.readUInt8(4),
    streamId: bytes.readUInt32BE(5),
    length: bytes.readUInt32BE(9),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
}

describe("protocol constants", () => {
  it("keeps the version and descriptor numbers the desktop host implements", () => {
    expect(DESKTOP_HOST_PROTOCOL_VERSION).toBe(3);
    expect(DESKTOP_REQUEST_PIPE_FD).toBe(3);
    expect(DESKTOP_RESPONSE_PIPE_FD).toBe(4);
    expect(DESKTOP_CONTROL_IPC_FD).toBe(5);
    expect(DESKTOP_PIPE_CHUNK_BYTES).toBe(64 * 1024);
  });
});

describe("response decoding", () => {
  it("decodes a hand-built start frame", () => {
    const decoder = new DesktopHostResponseDecoder();
    const bytes = jsonFrame(RESPONSE_START, 12, {
      status: 201,
      headers: [["content-type", "text/html"]],
      hasBody: true,
    });

    expect(decoder.push(bytes)).toEqual([
      {
        type: "start",
        streamId: 12,
        status: 201,
        headers: [["content-type", "text/html"]],
        hasBody: true,
      },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("decodes frames delivered one byte at a time", () => {
    const decoder = new DesktopHostResponseDecoder();
    const payload = Buffer.from([0x00, 0xff, 0x10]);
    const bytes = Buffer.concat([
      jsonFrame(RESPONSE_START, 1, { status: 200, headers: [], hasBody: true }),
      frame(RESPONSE_DATA, 1, payload),
      frame(RESPONSE_END, 1, Buffer.alloc(0)),
    ]);

    const frames = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])));

    expect(frames.map((entry) => entry.type)).toEqual(["start", "data", "end"]);
    expect(frames[1]).toEqual({ type: "data", streamId: 1, data: payload });
  });

  it("keeps stream order when two frames arrive in one chunk", () => {
    const decoder = new DesktopHostResponseDecoder();
    const bytes = Buffer.concat([
      jsonFrame(RESPONSE_ERROR, 1, { message: "boom" }),
      jsonFrame(RESPONSE_ERROR, 2, { message: "later" }),
    ]);

    expect(decoder.push(bytes)).toEqual([
      { type: "error", streamId: 1, message: "boom" },
      { type: "error", streamId: 2, message: "later" },
    ]);
  });

  it("accepts the boundaries of the stream id and status ranges", () => {
    const decoder = new DesktopHostResponseDecoder();
    const bytes = Buffer.concat([
      jsonFrame(RESPONSE_START, 1, { status: 100, headers: [], hasBody: false }),
      jsonFrame(RESPONSE_START, 0xffff_ffff, { status: 599, headers: [], hasBody: false }),
    ]);

    expect(decoder.push(bytes)).toHaveLength(2);
  });

  it("rejects a frame whose marker is wrong", () => {
    const decoder = new DesktopHostResponseDecoder();
    const bytes = jsonFrame(RESPONSE_END, 1, Buffer.alloc(0));
    bytes.writeUInt32BE(0, 0);

    expect(() => decoder.push(bytes)).toThrow(/invalid Host response frame marker/u);
  });

  it("rejects an unknown frame type", () => {
    const decoder = new DesktopHostResponseDecoder();

    expect(() => decoder.push(frame(5, 1, Buffer.alloc(0)))).toThrow(
      /unknown Host response frame type 5/u,
    );
  });

  it("rejects an end frame that carries a payload", () => {
    const decoder = new DesktopHostResponseDecoder();

    expect(() => decoder.push(frame(RESPONSE_END, 1, Buffer.from("x")))).toThrow(
      /end frame carried a payload/u,
    );
  });

  it("rejects the stream id zero the host never allocates", () => {
    const decoder = new DesktopHostResponseDecoder();

    expect(() => decoder.push(frame(RESPONSE_END, 0, Buffer.alloc(0)))).toThrow(
      /invalid pipe stream id 0/u,
    );
  });

  it("caps body frames at the pipe chunk size and control frames at a megabyte", () => {
    const bodyDecoder = new DesktopHostResponseDecoder();
    const controlDecoder = new DesktopHostResponseDecoder();
    const oversized = (type: number, length: number): Buffer => {
      const header = Buffer.alloc(FRAME_HEADER_BYTES);
      header.writeUInt32BE(FRAME_MAGIC, 0);
      header.writeUInt8(type, 4);
      header.writeUInt32BE(1, 5);
      header.writeUInt32BE(length, 9);
      return header;
    };

    expect(() => bodyDecoder.push(oversized(RESPONSE_DATA, DESKTOP_PIPE_CHUNK_BYTES + 1))).toThrow(
      /exceeds the 65536-byte limit/u,
    );
    expect(() =>
      controlDecoder.push(oversized(RESPONSE_START, MAX_CONTROL_PAYLOAD_BYTES + 1)),
    ).toThrow(/exceeds the 1048576-byte limit/u);
  });

  it("rejects malformed start and error payloads", () => {
    const decoder = new DesktopHostResponseDecoder();

    expect(() =>
      decoder.push(jsonFrame(RESPONSE_START, 1, { status: 600, headers: [], hasBody: true })),
    ).toThrow(/invalid Host response start payload/u);
    expect(() =>
      decoder.push(jsonFrame(RESPONSE_START, 1, { status: 200, headers: [["a"]], hasBody: true })),
    ).toThrow(/invalid Host response start payload/u);
    expect(() => decoder.push(jsonFrame(RESPONSE_START, 1, { status: 200, headers: [] }))).toThrow(
      /invalid Host response start payload/u,
    );
    expect(() => decoder.push(frame(RESPONSE_START, 1, Buffer.from("not json")))).toThrow(
      /Host response start payload is not JSON/u,
    );
    expect(() => decoder.push(jsonFrame(RESPONSE_ERROR, 1, { message: 7 }))).toThrow(
      /invalid Host response error payload/u,
    );
  });

  it("refuses to finish on a truncated frame", () => {
    const decoder = new DesktopHostResponseDecoder();

    const truncated = frame(RESPONSE_DATA, 1, Buffer.from([1, 2])).subarray(
      0,
      FRAME_HEADER_BYTES + 1,
    );

    expect(decoder.push(truncated)).toEqual([]);
    expect(() => decoder.finish()).toThrow(/ended inside a frame/u);
  });
});

describe("request encoding", () => {
  it("writes a start frame with the documented header and JSON payload", () => {
    const bytes = encodeDesktopRequestStart(7, {
      url: "https://dsh.invalid/api/session-editor",
      method: "POST",
      headers: [["content-type", "application/json"]],
      hasBody: true,
    });
    const parsed = parseFrame(bytes);

    expect(parsed.magic).toBe(FRAME_MAGIC);
    expect(parsed.type).toBe(REQUEST_START);
    expect(parsed.streamId).toBe(7);
    expect(parsed.length).toBe(parsed.payload.byteLength);
    expect(JSON.parse(parsed.payload.toString("utf8"))).toEqual({
      url: "https://dsh.invalid/api/session-editor",
      method: "POST",
      headers: [["content-type", "application/json"]],
      hasBody: true,
    });
  });

  it("writes body bytes verbatim", () => {
    const body = Buffer.from([0x00, 0x80, 0xff]);
    const parsed = parseFrame(encodeDesktopRequestData(3, body));

    expect(parsed.type).toBe(REQUEST_DATA);
    expect(parsed.streamId).toBe(3);
    expect([...parsed.payload]).toEqual([...body]);
  });

  it("writes empty end and cancel frames", () => {
    const end = parseFrame(encodeDesktopRequestEnd(9));
    const cancel = parseFrame(encodeDesktopRequestCancel(9));

    expect([end.type, end.length, end.streamId]).toEqual([REQUEST_END, 0, 9]);
    expect([cancel.type, cancel.length, cancel.streamId]).toEqual([REQUEST_CANCEL, 0, 9]);
  });

  it("rejects a body frame above the pipe chunk size", () => {
    expect(() => encodeDesktopRequestData(1, Buffer.alloc(DESKTOP_PIPE_CHUNK_BYTES + 1))).toThrow(
      /exceeds the 65536-byte limit/u,
    );
  });

  it("rejects stream ids the host would not accept", () => {
    for (const streamId of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(() => encodeDesktopRequestEnd(streamId)).toThrow(/invalid pipe stream id/u);
    }
  });
});
