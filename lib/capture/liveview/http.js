const crypto = require('node:crypto')
const http = require('node:http')

const PORT = 3456
const HOST = "localhost"
const MAX_PENDING_FRAMES = 3
const WRITING_INTERVAL = 50 // 20/1 FPS = 1000/20 ms/frame = 50 ms/frame


/*
 * A queue of fixed maximum length. When the maximum length is reached, old
 * elements are discarded upon enqueueing new ones.
 */
const SpillOverQueue = (N) => {
  const a = []

  const enq = (elem) => {
    if (a.length >= N)
      a.shift()
    a.push(elem)
  }

  const deq = () => a.shift()

  const clear = () => {
    a.length = 0
  }

  return { enq, deq, clear }
}


const Semaphore = (N) => {
  let credits = N

  const take = () => {
    const ret = credits > 0
    if (ret) credits--
    return ret
  }

  const put = () => {
    credits++
  }

  return { take, put }
}


const writeFrame = (res, boundaryLine, frame, written) => {
  res.write(boundaryLine)
  res.write("Cache-Control: no-store\n") // Tell the browser not to cache
  res.write("Content-Type: image/jpeg\n")
  res.write(`Content-Length: ${frame.length.toString()}\n`)
  res.write("\n")
  res.write(frame, written)
  res.write("\n")
}

const makeRequestHandler = (signal, queue) => {
  const boundary = crypto.randomBytes(64).toString('hex')
  const boundaryLine = `--${boundary}\n`
  const contentType = `multipart/x-mixed-replace; boundary=${boundary}`

  const requestHandler = (req, res) => {
    res.socket.setKeepAlive(false) // Disable TCP keep-alive
    res.setHeader('Connection', "close") // Disable HTTP keep-alive
    res.setHeader('Cache-Control', "no-store") // Tell the browser not to cache
    res.setHeader('Content-Type', contentType)

    let stopped = signal.stopped

    const pending = Semaphore(MAX_PENDING_FRAMES)
    const interval = setInterval(() => {
      stopped ||= signal.stopped
      if (stopped) {
        clearInterval(interval)
        res.end()
        return
      }

      if (!pending.take())
        return

      const frame = queue.deq()
      if (!frame) // Browser is faster than the camera
        return pending.put()

      writeFrame(res, boundaryLine, frame, pending.put)
    }, WRITING_INTERVAL)
  }

  return requestHandler
}


let liveview = null

const startServer = (liveviewEnabledCallback) => {
  const signal = { stopped: false }
  const setStopped = (stopped) => {
    signal.stopped = stopped
  }

  const queue = SpillOverQueue(MAX_PENDING_FRAMES)
  const requestHandler = makeRequestHandler(signal, queue)
  const server = http.createServer(requestHandler)
  const startPromise = new Promise((resolve, reject) => {
    server
      .listen(PORT, HOST, () => {
        console.log("[liveview] server started")
        resolve()
      })
      .on('close', () => {
        console.log("[liveview] server closed")
        liveview = null
      })
      .on('clientError', (err, sock) => {
        console.log("[liveview] client error:", err)
        sock.end()
      })
      .on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log("[liveview] address in use...")
        } else {
          console.log("[liveview] server error:", err)
        }
        reject(err)
      })
  })

  return { server, queue, startPromise, setStopped }
}

const start = (liveviewEnabledCallback) => {
  liveview?.queue.clear() // Remove any queued frames from the previous scan

  if (!liveview)
    liveview = startServer(liveviewEnabledCallback)

  return liveview.startPromise
    .then(
      () => {
        liveview.setStopped(false)
        liveviewEnabledCallback(PORT)
      },
      (err) => {
        liveview = null
        setTimeout(start, 50, liveviewEnabledCallback)
      }
    )
}

const stop = () => {
  liveview?.setStopped(true)
}

const trySend = (frame) => {
  liveview?.queue.enq(frame)
}

module.exports = {
  start,
  stop,
  trySend,
}
