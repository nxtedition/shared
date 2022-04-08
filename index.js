const WRITE_INDEX = 0;
const READ_INDEX = 1;

export function alloc(size) {
  return {
    sharedState: new SharedArrayBuffer(8),
    sharedBuffer: new SharedArrayBuffer(size),
  };
}

export async function reader({ sharedState, sharedBuffer }, cb) {
  const state = new Int32Array(sharedState);
  const buffer = Buffer.from(sharedBuffer);

  let readPos = 0;
  let writePos = 0;

  while (true) {
    const { async, value } = Atomics.waitAsync(state, WRITE_INDEX, writePos);
    if (async) {
      await value;
    }
    writePos = Atomics.load(state, WRITE_INDEX);

    while (readPos !== writePos) {
      const len = buffer.readInt32LE(readPos);

      if (len === -1) {
        readPos = 0;
      } else {
        const raw = buffer.slice(readPos + 4, readPos + len);
        readPos += len;

        await cb(raw);
      }

      Atomics.store(state, READ_INDEX, readPos);
    }

    Atomics.notify(state, READ_INDEX);
  }
}

export function writer({ sharedState, sharedBuffer }) {
  const state = new Int32Array(sharedState);
  const buffer = Buffer.from(sharedBuffer);
  const size = buffer.byteLength;
  const queue = [];

  let readPos = 0;
  let writePos = 0;
  let flushing = null;

  function tryWrite(...raw) {
    readPos = Atomics.load(state, READ_INDEX);

    const len = raw.reduce((len, buf) => len + buf.byteLength, 4);

    if (size - writePos < len + 4) {
      if (readPos < len + 4) {
        return false;
      }

      buffer.writeInt32LE(-1, writePos);
      writePos = 0;
    } else {
      const available =
        writePos >= readPos ? size - writePos : readPos - writePos;

      if (available < len + 4) {
        return false;
      }
    }

    buffer.writeInt32LE(len, writePos);
    writePos += 4;

    for (const buf of raw) {
      buffer.set(buf, writePos);
      writePos += buf.byteLength;
    }

    Atomics.store(state, WRITE_INDEX, writePos);
    Atomics.notify(state, WRITE_INDEX);

    return true;
  }

  async function flush() {
    if (flushing) {
      return flushing;
    }

    while (queue.length) {
      while (!tryWrite(queue[0])) {
        const { async, value } = Atomics.waitAsync(state, READ_INDEX, readPos);
        if (async) {
          await value;
        }
      }
      queue.shift();
    }

    flushing = null;
  }

  async function write(...raw) {
    if (!queue.length && tryWrite(...raw)) {
      return;
    }

    queue.push(Buffer.concat(raw));

    await (flushing ??= flush());
  }

  return write;
}
