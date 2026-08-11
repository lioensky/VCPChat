"use strict";

const { TextDecoder } = require("util");

const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024;
const MAX_NDJSON_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_NDJSON_TOPICS = 10_000;
const MAX_NDJSON_MESSAGES = 100_000;

function decodeNdjsonLine(line) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch (error) {
    throw new Error(`NDJSON frame is not valid UTF-8: ${error.message}`);
  }
}

async function* readNdjsonLines(
  input,
  {
    maxLineBytes = MAX_NDJSON_LINE_BYTES,
    maxTotalBytes = MAX_NDJSON_TOTAL_BYTES,
  } = {},
) {
  let fragments = [];
  let lineBytes = 0;
  let totalBytes = 0;

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error("NDJSON request exceeds 256 MiB total budget");
    }
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const part = chunk.subarray(start, newline);
      if (lineBytes + part.length > maxLineBytes) {
        throw new Error("NDJSON frame exceeds 32 MiB budget");
      }
      const length = lineBytes + part.length;
      const line = fragments.length
        ? Buffer.concat([...fragments, part], length)
        : part;
      fragments = [];
      lineBytes = 0;
      if (line.length > 0 && line.toString("utf8").trim()) yield line;
      start = newline + 1;
    }
    if (start < chunk.length) {
      const remainder = chunk.subarray(start);
      lineBytes += remainder.length;
      if (lineBytes > maxLineBytes) {
        throw new Error("NDJSON frame exceeds 32 MiB budget");
      }
      fragments.push(remainder);
    }
  }

  if (lineBytes > 0) {
    const line =
      fragments.length === 1
        ? fragments[0]
        : Buffer.concat(fragments, lineBytes);
    if (line.toString("utf8").trim()) yield line;
  }
}

class NdjsonWriter {
  constructor(
    response,
    {
      maxLineBytes = MAX_NDJSON_LINE_BYTES,
      maxTotalBytes = MAX_NDJSON_TOTAL_BYTES,
    } = {},
  ) {
    this.response = response;
    this.maxLineBytes = maxLineBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.totalBytes = 0;
  }

  async write(frame) {
    const line = `${JSON.stringify(frame)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxLineBytes) {
      throw new Error("NDJSON response frame exceeds 32 MiB budget");
    }
    this.totalBytes += bytes;
    if (this.totalBytes > this.maxTotalBytes) {
      throw new Error("NDJSON response exceeds 256 MiB total budget");
    }
    if (this.response.write(line)) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.response.removeListener("drain", onDrain);
        this.response.removeListener("close", onClose);
        this.response.removeListener("error", onError);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("NDJSON consumer disconnected"));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      this.response.once("drain", onDrain);
      this.response.once("close", onClose);
      this.response.once("error", onError);
    });
  }
}

module.exports = {
  MAX_NDJSON_LINE_BYTES,
  MAX_NDJSON_MESSAGES,
  MAX_NDJSON_TOPICS,
  MAX_NDJSON_TOTAL_BYTES,
  NdjsonWriter,
  decodeNdjsonLine,
  readNdjsonLines,
};
