import assert from 'node:assert'

const WRITE_INDEX = 0
const READ_INDEX = 1
const END_OF_PACKET = -1

export function alloc(size) {
  return {
    sharedState: new SharedArrayBuffer(8),
    sharedBuffer: new SharedArrayBuffer(size),
  }
}

async function* _reader({ sharedState, sharedBuffer }, cb) {
  const state = new Int32Array(sharedState)
  const buffer = Buffer.from(sharedBuffer)

  let readPos = 0
  let writePos = 0

  while (true) {
    const { async, value } = Atomics.waitAsync(state, WRITE_INDEX, writePos)
    if (async) {
      await value
    }
    writePos = Atomics.load(state, WRITE_INDEX)

    while (readPos !== writePos) {
      const len = buffer.readInt32LE(readPos)

      if (len === END_OF_PACKET) {
        readPos = 0
      } else {
        const raw = buffer.slice(readPos + 4, readPos + len)
        readPos += len
        if (cb) {
          const thenable = cb(raw)
          if (thenable && typeof thenable.then === 'function') {
            await thenable
          }
        } else {
          yield raw
        }
      }

      Atomics.store(state, READ_INDEX, readPos)
    }

    Atomics.notify(state, READ_INDEX)
  }
}

export function reader(options, cb) {
  if (cb) {
    _reader(options, cb).next()
  } else {
    return _reader(options)
  }
}

export function writer({ sharedState, sharedBuffer }) {
  const state = new Int32Array(sharedState)
  const buffer = Buffer.from(sharedBuffer)
  const size = buffer.byteLength
  const queue = []

  let readPos = 0
  let writePos = 0
  let flushing = null

  function acquire(len) {
    if (!len) {
      return Buffer.alloc(0)
    }

    readPos = Atomics.load(state, READ_INDEX)

    assert(len < size / 2)

    if (size - writePos < len + 4) {
      if (readPos < len + 4) {
        return false
      }

      buffer.writeInt32LE(-1, writePos)
      writePos = 0
    } else {
      const available = writePos >= readPos ? size - writePos : readPos - writePos

      if (available < len + 4) {
        return false
      }
    }

    return buffer.subarray(writePos + 4, writePos + 4 + len)
  }

  function release(len) {
    buffer.writeInt32LE(len, writePos)
    writePos += 4 + len

    Atomics.store(state, WRITE_INDEX, writePos)
    Atomics.notify(state, WRITE_INDEX)
  }

  function tryWrite(...raw) {
    if (Array.isArray(raw[0])) {
      raw = raw[0]
    }

    if (!raw.length) {
      return true
    }

    let maxLen = 4
    for (const buf of raw) {
      maxLen += buf.byteLength ?? buf.length * 3
    }

    const dst = acquire(maxLen)
    if (!dst) {
      return false
    }

    let pos = 0
    for (const buf of raw) {
      if (typeof buf === 'string') {
        pos += buffer.write(buf, pos)
      } else {
        buffer.set(buf, pos)
        pos += buf.byteLength
      }
    }

    assert(pos <= maxLen)

    release(pos)

    return true
  }

  async function flush() {
    while (queue.length) {
      while (!tryWrite(queue[0])) {
        const { async, value } = Atomics.waitAsync(state, READ_INDEX, readPos)
        if (async) {
          await value
        }
      }
      queue.shift()
    }

    flushing = null
  }

  function write(...raw) {
    if (!queue.length && tryWrite(...raw)) {
      return
    }

    queue.push(Buffer.concat(raw))

    return (flushing ??= flush())
  }

  write.acquire = acquire
  write.release = release
  write.flush = flush

  return write
}
