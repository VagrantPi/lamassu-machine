const _ = require('lodash/fp')

const { stream, cameraExists } = require('./streamer/v4l2camera')
const scanner = require('./scanner/zxing')

const activeStreams = new Map()
let configuration = null

const config = (config) => {
  configuration = config
}

const mode2conf = mode =>
  mode === 'facephoto' ? 'frontFacingCamera' : 'scanner'

const getCameraDevice = mode => {
  const config = _.get(mode2conf(mode), configuration)

  if (mode === 'qr' && config?.qrDevice) {
    return config.qrDevice
  }

  return _.get('device', config)
}

const getCameraConfig = mode =>
  _.get([mode2conf(mode), mode], configuration)

const hasCamera = (mode) => {
  const device = getCameraDevice(mode)

  if (!device) {
    return false
  }

  return cameraExists(device)
}

const scanPDF417 = (callback, idCardStillsCallback) => {
  const mode = 'photoId'
  const device = getCameraDevice(mode)

  let processing = false

  const camStream = stream(device, {})
  activeStreams.set(device, camStream)

  camStream.on('data', async (frame) => {
    if (processing) return
    processing = true

    const result = await scanner.scanPDF417(frame)
    if (result) {
      camStream.destroy()
      callback(null, result)
    }

    processing = false
  })
}

const cancel = () => {
  for (const [key, stream] of activeStreams) {
    try {
      stream.destroy();
    } catch (error) {
      console.error(`Error destroying stream ${key}:`, error);
    } finally {
      activeStreams.delete(key);
    }
  }
  activeStreams.clear();
}

module.exports = {
  config,
  cancel,
  hasCamera,
  scanPDF417,
  scanPhotoCard,
  delayedFacephoto,
  isOpened,
  scanMainQr,
  getDelayMS,
  diagnosticPhotos
}