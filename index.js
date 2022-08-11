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
        const raw = buffer.subarray(readPos + 4, readPos + len)
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

  function tryWrite(maxLen, fn, opaque) {
    readPos = Atomics.load(state, READ_INDEX)

    maxLen += 4 // len

    if (size - writePos < maxLen + 4) {
      if (readPos < maxLen + 4) {
        return false
      }

      buffer.writeInt32LE(-1, writePos)
      writePos = 0
    } else {
      const available = writePos >= readPos ? size - writePos : readPos - writePos

      if (available < maxLen + 4) {
        return false
      }
    }

    const lenPos = writePos
    writePos += 4

    writePos += fn(buffer.subarray(writePos, writePos + maxLen), opaque)

    const len = writePos - lenPos

    assert(len <= maxLen)

    buffer.writeInt32LE(len, lenPos)

    Atomics.store(state, WRITE_INDEX, writePos)
    Atomics.notify(state, WRITE_INDEX)

    return true
  }

  function flush() {
    if (queue.length && !flushing) {
      flushing = _flush()
    }
    return flushing
  }

  async function _flush() {
    while (queue.length) {
      const buf = queue[0]
      while (
        !tryWrite(
          buf.byteLength,
          (dst, buf) => {
            dst.set(buf)
            return buf.byteLength
          },
          buf
        )
      ) {
        const { async, value } = Atomics.waitAsync(state, READ_INDEX, readPos)
        if (async) {
          await value
        }
      }
      queue.shift()
    }

    flushing = null
  }

  function write(...args) {
    if (!args.length) {
      return
    }

    let len
    let fn
    let opaque

    if (Number.isInteger(args[0])) {
      len = args[0]
      fn = args[1]
      opaque = args[2]
    } else {
      if (Array.isArray(args[0])) {
        args = args[0]
      }

      len = 0
      for (const buf of args) {
        len += buf.byteLength ?? buf.length * 3
      }

      fn = (dst, data) => {
        let pos = 0
        for (const buf of data) {
          if (typeof buf === 'string') {
            pos += dst.write(buf, pos)
          } else {
            dst.set(buf, pos)
            pos += buf.byteLength
          }
        }
        return pos
      }

      opaque = args
    }

    if (!queue.length && tryWrite(len, fn, opaque)) {
      return
    }

    const buf = Buffer.allocUnsafe(len)
    queue.push(buf.subarray(0, fn(buf, opaque)))

    return flush()
  }

  write.write = write
  write.flush = flush

  return write
}
