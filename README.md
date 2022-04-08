# shared

Ring Buffer for NodeJS cross Worker communication.

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

writeToWorker(Buffer.from('ping'))

for await (const buffer of shared.reader(writer)) {
  console.log(`From worker ${buffer}`)
  await tp.setTimeout(1e3) // Backpressure
  writeToWorker(Buffer.from('pong'))
}
```

```js
// worker.js

import * as shared from '@nxtedition/shared'
import tp from 'timers/promise'

const writeToParent = shared.writer(workerData.writer)

for await (const buffer of shared.reader(workerData.reader)) {
  console.log(`From parent ${buffer}`)
  await tp.setTimeout(1e3) // Backpressure
  writeToWorker(Buffer.from('pong'))
}
```
