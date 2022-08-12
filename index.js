import assert from 'node:assert'

const WRITE_INDEX = 0
const READ_INDEX = 1

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
      const tag = buffer.readInt32LE(readPos)
      readPos += 4

      if (tag === -1) {
        readPos = 0
        continue
      }

      assert.equal(tag, -2)

      const len = buffer.readInt32LE(readPos)
      readPos += 4

      assert(len >= 0)

      const raw = buffer.subarray(readPos, readPos + len)
      readPos += len

      if (cb) {
        await cb(raw)
      } else {
        yield raw
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

  let readPos = 0
  let writePos = 0

  function tryWrite(maxLen, fn, opaque) {
    assert(maxLen < size - 12)

    readPos = Atomics.load(state, READ_INDEX)

    if (size - writePos < maxLen + 12) {
      if (readPos < maxLen + 12) {
        return false
      }

      buffer.writeInt32LE(-1, writePos)
      writePos = 0
    } else {
      const available = writePos >= readPos ? size - writePos : readPos - writePos

      if (available < maxLen + 12) {
        return false
      }
    }

    buffer.writeInt32LE(-2, writePos)
    writePos += 4

    const lenPos = writePos
    writePos += 4

    const len = fn(buffer.subarray(writePos, writePos + maxLen), opaque)
    writePos += len

    assert(len <= maxLen)

    buffer.writeInt32LE(len, lenPos)

    Atomics.store(state, WRITE_INDEX, writePos)
    Atomics.notify(state, WRITE_INDEX)

    return true
  }

  async function _write(len, fn, opaque) {
    let buf = Buffer.allocUnsafe(len)
    buf = buf.subarray(0, fn(buf, opaque))

    while (!tryWrite(len, (dst, buf) => buf.copy(dst), buf)) {
      const { async, value } = Atomics.waitAsync(state, READ_INDEX, readPos)
      if (async) {
        await value
      }
    }
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

      assert(len >= 0)
      assert(typeof fn === 'function')
    } else {
      if (Array.isArray(args[0])) {
        args = args[0]
      }

      const data = args

      len = 0
      for (const buf of data) {
        len += buf.byteLength ?? buf.length * 3
      }

      fn = (dst, data) => {
        let pos = 0
        for (const buf of data) {
          if (typeof buf === 'string') {
            pos += dst.write(buf, pos)
          } else {
            pos += buf.copy(dst, pos)
          }
        }
        assert(pos <= len)
        return pos
      }

      opaque = data
    }

    if (!tryWrite(len, fn, opaque)) {
      return _write(len, fn, opaque)
    }
  }

  write.write = write
  write.flush = () => {}

  return write
}
