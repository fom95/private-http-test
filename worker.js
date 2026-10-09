import fs from "node:fs";
import path from "node:path";

const target = path.resolve(
  "node_modules/@mtcute/core/highlevel/methods/files/download-iterable.js"
);

if (!fs.existsSync(target)) {
  console.error(`Cannot find ${target}`);
  console.error("Run this from the project root after installing dependencies.");
  process.exit(1);
}

let source = fs.readFileSync(target, "utf8");
const original = source;

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1;
  if (count === 0) {
    if (source.includes(after)) {
      console.log(`Already applied: ${label}`);
      return;
    }
    throw new Error(`${label}: exact source anchor not found; no file written.`);
  }
  if (count !== 1) {
    throw new Error(`${label}: expected one match, found ${count}; no file written.`);
  }
  source = source.replace(before, after);
  console.log(`Applied: ${label}`);
}

// 1. Add byte accounting and a wakeable wait queue next to the existing buffer.
replaceOnce(
  "add bounded-buffer accounting",
  '  const buffer = {};\n  const isSmall = fileSize && fileSize <= SMALL_FILE_MAX_SIZE || location._ === "inputPeerPhotoFileLocation";',
  `  const buffer = {};
  let bufferBytes = 0;
  let maxBufferBytes = Infinity;
  const bufferWaiters = new Set();
  const wakeBufferWaiters = () => {
    for (const wake of bufferWaiters) wake();
    bufferWaiters.clear();
  };
  const waitForBufferRoom = async (chunk) => {
    while (!ended && bufferBytes >= maxBufferBytes && chunk !== nextChunkIdx) {
      await new Promise((resolve) => bufferWaiters.add(resolve));
    }
  };
  const isSmall = fileSize && fileSize <= SMALL_FILE_MAX_SIZE || location._ === "inputPeerPhotoFileLocation";`
);

// 2. Set the cap after the pool size is known.
replaceOnce(
  "set buffer limit from worker count",
  '  const poolSize = await client.getPoolSize(connectionKind, dcId);\n  const delayGate = isSmall ? void 0 : new DownloadDelayGate();',
  `  const poolSize = await client.getPoolSize(connectionKind, dcId);
  // Bound queued chunks to roughly one worker-window of data.
  // A few in-flight responses may temporarily sit outside this buffer.
  maxBufferBytes = chunkSize * Math.max(2, poolSize * (isSmall ? 1 : REQUESTS_PER_CONNECTION));
  const delayGate = isSmall ? void 0 : new DownloadDelayGate();`
);

// 3. Before retaining a completed response, wait for room. Always allow the next
// required chunk through, preventing out-of-order chunks from deadlocking the stream.
replaceOnce(
  "apply backpressure before buffering a response",
  '    buffer[chunk] = result.bytes;\n    if (chunk === nextChunkIdx) {',
  `    await waitForBufferRoom(chunk);
    if (ended) return;
    buffer[chunk] = result.bytes;
    bufferBytes += result.bytes.length;
    if (chunk === nextChunkIdx) {`
);

// 4. Decrease accounting as the consumer removes a buffered chunk.
replaceOnce(
  "release buffer capacity as chunks are yielded",
  '        const buf = buffer[nextChunkIdx];\n        delete buffer[nextChunkIdx];\n        position += buf.length;',
  `        const buf = buffer[nextChunkIdx];
        delete buffer[nextChunkIdx];
        bufferBytes = Math.max(0, bufferBytes - buf.length);
        wakeBufferWaiters();
        position += buf.length;`
);

// 5. Wake blocked workers if a worker fails.
replaceOnce(
  "wake buffer waiters on worker error",
  '    error = e;\n    ended = true;\n    nextChunkCv.notify();',
  `    error = e;
    ended = true;
    wakeBufferWaiters();
    nextChunkCv.notify();`
);

// 6. Wake blocked workers when aborted.
replaceOnce(
  "wake buffer waiters on abort",
  '    error = abortSignal.reason;\n    ended = true;\n    nextChunkCv.notify();',
  `    error = abortSignal.reason;
    ended = true;
    wakeBufferWaiters();
    nextChunkCv.notify();`
);

// 7. Clear accounting and wake waiters during cleanup.
replaceOnce(
  "clear buffer accounting during cleanup",
  '    ended = true;\n    for (const idx in buffer) delete buffer[Number(idx)];\n    nextChunkCv.notify();',
  `    ended = true;
    for (const idx in buffer) delete buffer[Number(idx)];
    bufferBytes = 0;
    wakeBufferWaiters();
    nextChunkCv.notify();`
);

// 8. Reduce each file download to a single worker chain. The chain still
// downloads sequentially ahead of the consumer, while backpressure bounds memory.
replaceOnce(
  "use a single download worker chain",
  '    length: Math.min(poolSize * (isSmall ? 1 : REQUESTS_PER_CONNECTION), numChunks)',
  '    length: Math.min(1, numChunks)'
);

if (source === original) {
  console.log("No changes needed; patch was already applied.");
} else {
  // Validate syntax before replacing the installed package file.
  try {
    await import(`data:text/javascript,${encodeURIComponent(source)}`);
  } catch (error) {
    // Imports of the module's bare package dependencies cannot resolve from a
    // data URL, so only reject clear syntax errors; this is checked separately
    // by node --check after writing.
    if (error instanceof SyntaxError) {
      throw new Error(`Patched source has a syntax error: ${error.message}`);
    }
  }
  fs.writeFileSync(target, source, "utf8");
  console.log(`Patched successfully: ${target}`);
  console.log("Run: node --check node_modules/@mtcute/core/highlevel/methods/files/download-iterable.js");
}
