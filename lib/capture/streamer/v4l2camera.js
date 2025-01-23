const { Readable } = require('node:stream')

const v4l2camera = require('@dwe.ai/v4l2camera')

// Three minute timeout in case of a dangling camera stream
const DEFAULT_TIMEOUT = 180_000

const stream = (device, options = {}) => {
  const { timeout = DEFAULT_TIMEOUT, pickFormat } = options

  const readableStream = new Readable({
    objectMode: true,
    read() {}
  })

  const cam = new v4l2camera.Camera(device)

  // Filter for MJPG formats and let pickFormat function choose the best resolution
  const mjpgFormats = cam.formats.filter(format => format.formatName === 'MJPG')
  const config = pickFormat(mjpgFormats)

  if (!config) {
    throw new Error('No suitable camera format found')
  }
  const { width, height } = config

  cam.configSet(config)

  cam.start()

  let isStreaming = true

  const captureFrame = () => {
    if (!isStreaming) return

    cam.capture((success) => {
      if (!isStreaming) return
      if (!success) return setTimeout(captureFrame)

      const frame = cam.frameRaw()
      if (isStreaming)
        readableStream.push({ frame, width, height })
      setTimeout(captureFrame)
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
