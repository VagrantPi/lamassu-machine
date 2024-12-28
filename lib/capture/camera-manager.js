const { stream } = require('./streamer/v4l2camera')

const activeStreams = new Map()

const scanQR = (device, callback, timeout) => {
  const { stop, takeSnapshot } = stream(async (frame) => {
    try {
      await callback(frame)
    } catch (error) {
      console.error(`Error in stream ${device} callback:`, error)
    }
  }, timeout)

  activeStreams.set(device, {
    stop,
    takeSnapshot
  })

  // TODO return qr code
  return streamId
}

const cancel = (streamId) => {
  const stream = activeStreams.get(streamId)
  if (stream) {
    stream.stop()
    activeStreams.delete(streamId)
    return true
  }
  return false
}

const cancelAll = () => {
  Array.from(activeStreams.entries()).forEach(([streamId, stream]) => {
    stream.stop()
    activeStreams.delete(streamId)
  })
}

module.exports = {
  scanQR,
  cancel,
  cancelAll
}