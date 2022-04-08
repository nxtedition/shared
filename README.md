# shared

Ringbuffer for NodeJS cross Worker communication
## Install

```
npm i @nxtedition/shared
```

## Quick Start

```js
// index.js

import * as shared from '@nxtedition/shared'
import tp from 'timers/promise'

const writer = shared.alloc(16 * 1024 * 1024)
const reader = shared.alloc(16 * 1024 * 1024)

const worker = new Worker(new URL('worker.js', import.meta.url), {
  workerData: { reader, writer },
})

const writeToWorker = shared.writer(reader)

shared.reader(writer, async (buffer) => {
  console.log(`From worker ${buffer}`)
  await tp.setTimeout(1e3) // Backpressure
})

while (true) {
  await writeToParent(Buffer.from('Hello from parent')
}
```

```js
// worker.js

import * as shared from '@nxtedition/shared'
import tp from 'timers/promise'

const writeToParent = shared.writer(workerData.writer)

shared.reader(workerData.reader, (buffer) => {
  console.log(`From parent ${buffer}`)
  await tp.setTimeout(1e3) // Backpressure
})

while (true) {
  await writeToParent(Buffer.from('Hello from worker')
}
```