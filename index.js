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

      assert(tag === -2, `tag: ${tag} === -2`)

      const len = buffer.readInt32LE(readPos)
      readPos += 4

      const raw = buffer.subarray(readPos, readPos + len)
      readPos += len

      if (cb) {
        await cb(raw)
      } else {
        yield raw
      }

      Atomics.store(state, READ_INDEX, readPos)
      Atomics.notify(state, READ_INDEX)
    }
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
  const size = buffer.byteLength - 64

  let readPos = 0
  let writePos = 0

  function _tryWrite(maxLen, fn, opaque) {
    maxLen += 4

    assert(maxLen <= size)

    readPos = Atomics.load(state, READ_INDEX)

    if (size - writePos < maxLen) {
      if (readPos < maxLen) {
        return false
      }

      buffer.writeInt32LE(-1, writePos)
      writePos = 0
    } else {
      const available = writePos >= readPos ? size - writePos : readPos - writePos

      if (available < maxLen) {
        return false
      }
    }

    buffer.writeInt32LE(-2, writePos)
    writePos += 4

    const len = fn(buffer.subarray(writePos + 4, writePos + 4 + maxLen), opaque)
    assert(len <= maxLen - 4, `len: ${len} <= maxLen: ${maxLen - 4}`)
    assert(len <= size, `len: ${len} <= size: ${size}`)

    buffer.writeInt32LE(len, writePos)
    writePos += 4 + len
    buffer.writeInt32LE(-3, writePos)

    Atomics.store(state, WRITE_INDEX, writePos)
    Atomics.notify(state, WRITE_INDEX)

    return true
  }

  async function _write(maxLen, fn, opaque) {
    assert(maxLen <= size)

    const buf = Buffer.allocUnsafe(maxLen)
    const len = fn(buf, opaque)

    while (!_tryWrite(len, (dst, buf) => buf.copy(dst, 0, 0, len))) {
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

    let maxLen
    let fn
    let opaque

    if (Number.isInteger(args[0])) {
      maxLen = args[0]
      fn = args[1]
      opaque = args[2]

      assert(maxLen >= 0, `maxLen: ${maxLen} >= 0`)
      assert(typeof fn === 'function', `fn: ${typeof fn} === 'function`)
    } else {
      if (Array.isArray(args[0])) {
        args = args[0]
      }

      maxLen = args.reduce((len, buf) => len + Buffer.byteLength(buf), 0)
      fn = (dst, data) => {
        let pos = 0
        for (const buf of data) {
          if (typeof buf === 'string') {
            pos += dst.write(buf, pos)
          } else {
            pos += buf.copy(dst, pos)
          }
        }
        return pos
      }
      opaque = args
    }

    if (!_tryWrite(maxLen, fn, opaque)) {
      return _write(maxLen, fn, opaque)
    }
  }

  write.write = write
  write.flush = () => {}

  return write
}
