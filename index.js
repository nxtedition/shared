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

      assert(len > 0, `len: ${len} > 0`)

      const raw = buffer.subarray(readPos, readPos + len)
      readPos += len

      if (cb) {
        const thenable = cb(raw)
        if (thenable) {
          await thenable
        }
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

  return function write(...args) {
    if (!args.length) {
      return
    }

    let len
    let fn

    if (Number.isInteger(args[0])) {
      len = args.shift()
      fn = args.shift()

      assert(len >= 0, `len: ${len} >= 0`)
      assert(typeof fn === 'function', `fn: ${typeof fn} === 'function`)
    } else {
      if (Array.isArray(args[0])) {
        args = args[0]
      }

      len = 0
      for (const buf of args) {
        len += Buffer.byteLength(buf)
      }
    }

    assert(len <= size)

    readPos = Atomics.load(state, READ_INDEX)

    if (size - writePos < len) {
      buffer.writeInt32LE(-1, writePos)
      writePos += 4
      buffer.subarray(writePos).fill(-4)
      writePos = 0
    }

    while (true) {
      const available = writePos >= readPos ? size - writePos : readPos - writePos
      if (available >= len) {
        break
      }
      Atomics.wait(state, READ_INDEX, readPos)
    }

    buffer.writeInt32LE(-2, writePos)
    writePos += 4

    buffer.writeInt32LE(-3, writePos)

    let pos = 0
    if (fn) {
      pos += fn(buffer.subarray(writePos + 4, writePos + 4 + len), ...args)
    } else {
      for (const buf of args) {
        if (typeof buf === 'string') {
          pos += buffer.write(buf, writePos + 4 + pos)
        } else {
          pos += buf.copy(buffer, writePos + 4 + pos)
        }
      }
    }

    assert(pos > 0, `pos: ${pos} > 0`)
    assert(pos <= len, `pos: ${pos} <= len: ${len}`)
    assert(pos <= size, `pos: ${pos} <= size: ${size}`)

    buffer.writeInt32LE(pos, writePos)
    writePos += 4 + pos
    buffer.writeInt32LE(-4, writePos)

    Atomics.store(state, WRITE_INDEX, writePos)
    Atomics.notify(state, WRITE_INDEX)
  }
}
