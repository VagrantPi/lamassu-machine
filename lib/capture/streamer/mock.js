const { Readable } = require('node:stream')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const DEFAULT_TIMEOUT = 180_000
const IMAGE_PATH = path.join(__dirname, '../../../mock_data/compliance/mock.jpg')

const stream = (options = {}) => {
  const { timeout = DEFAULT_TIMEOUT } = options
  
  const readableStream = new Readable({
    objectMode: true,
    read() {}
  })

  let isStreaming = true
  let cachedFrame
  let imageMetadata

  // Read the image once at startup
  const initialize = async () => {
    try {
      const image = await sharp(IMAGE_PATH, { failOn: "truncated" }).jpeg().toBuffer({ resolveWithObject: true })

      cachedFrame = image.data
      imageMetadata = image.info
    } catch (error) {
      console.error('Error initializing mock streamer:', error)
      readableStream.destroy()
      return
    }
    sendFrame()
  }

  const sendFrame = () => {
    if (!isStreaming) return

    if (cachedFrame && imageMetadata) {
      const { width, height } = imageMetadata
      readableStream.push({ frame: cachedFrame, width, height })
    }

    if (isStreaming) {
      setTimeout(sendFrame, 100) // Simulate camera frame rate
    }
  }

  initialize()

  const timeoutHandler = setTimeout(() => {
    readableStream.destroy()
  }, timeout)

  const cleanup = () => {
    isStreaming = false
    clearTimeout(timeoutHandler)
  }

  readableStream.on('close', cleanup)
  readableStream.on('end', cleanup)

  return readableStream
}

const cameraExists = () => {
  return fs.existsSync(IMAGE_PATH)
}

module.exports = {
  stream,
  cameraExists
}
