const { Readable } = require('node:stream')

const v4l2camera = require('@dwe.ai/v4l2camera')
const sharp = require('sharp')

// Three minute timeout in case of a dangling camera stream
const DEFAULT_TIMEOUT = 180_000

const stream = (device, options = {}) => {
  const { timeout = DEFAULT_TIMEOUT, pickResolution } = options

  const readableStream = new Readable({
    objectMode: true,
    read() {}
  })

  const cam = new v4l2camera.Camera(device)

  const config = cam.formats.filter(format => format.formatName === 'MJPG' && format.width === 1280 && format.height === 720)[0]
  cam.configSet(config)

  cam.start()

  let isStreaming = true

  const captureFrame = () => {
    if (!isStreaming) return

    cam.capture((success) => {
      if (!isStreaming) return
      if (!success) setTimeout(captureFrame)

      const frame = cam.frameRaw()
      sharp(frame, { failOn: "truncated" }).jpeg().toBuffer()
        .then(it => {
          if (isStreaming) readableStream.push(it)
        })
        .catch((error) => {
          // frame errors can happen, but we don't want to stop the stream
          console.error('Error processing frame:', error)
        })
        .finally(() => {
          setTimeout(captureFrame)
        })
    })
  }

  captureFrame()

  const timeoutHandler = setTimeout(() => {
    readableStream.destroy()
  }, timeout ?? DEFAULT_TIMEOUT)

  const cleanup = () => {
    isStreaming = false
    clearTimeout(timeoutHandler)
    cam.stop()
  }

  readableStream.on('close', cleanup)
  readableStream.on('end', cleanup)

  return readableStream
}

const cameraExists = (device) => {
  try {
    new v4l2camera.Camera(device)
    console.log('YES')
    return true
  } catch (error) {
    console.log('NO', error)
    return false
  }
}

module.exports = {
  stream,
  cameraExists
}
