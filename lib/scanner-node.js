const _ = require('lodash/fp')

const Pdf417Parser = require('./compliance/parsepdf417')
const { utils: coinUtils } = require('@lamassu/coins')
const { cameraExists, stream } = require('./capture/streamer/v4l2camera')
const { maxCamResolutions, minCamResolutions, maxCamResolutionQRCode, maxCamResolutionPhotoId } = require('./capture/consts')
const scanner = require('./capture/scanner/manatee')
const sharp = require('sharp')
const supyo = require('@lamassu/supyo')

const DEFAULT_FPS = 10
const DEFAULT_DELAYEDSHOT_DELAY = 3
const NETWORK = 'main'

let configuration = null
let current_fps = DEFAULT_FPS
let delayedshot_delay = DEFAULT_DELAYEDSHOT_DELAY

let activeStream = null

const mode2conf = mode =>
  mode === 'facephoto' ? 'frontFacingCamera' : 'scanner'

const getCameraDevice = mode => {
  const config = _.get(mode2conf(mode), configuration)

  if (mode === 'qr' && config && config.qrDevice) {
    return config.qrDevice
  }

  return _.get('device', config)
}

const getDelayMS = () => delayedshot_delay * 1000

const setFPS = fps => { current_fps = fps }

function setConfig(formats, mode) {
  const isQRCodeMode = mode === 'qr'
  const isPhotoIdMode = mode === 'photoId'

  const pixelRes = format => format.width * format.height
  const isSuitableRes = res => {
    const currentRes = pixelRes(res)

    const isAboveMinAcceptableResolutions = _.some(_.flow(pixelRes, _.gte(currentRes)))
    const isUnderMaxAcceptableResolutions = _.some(_.flow(pixelRes, _.lte(currentRes)))

    const maxResolutions = isQRCodeMode ? maxCamResolutionQRCode :
      isPhotoIdMode ? maxCamResolutionPhotoId :
        maxCamResolutions
    return isUnderMaxAcceptableResolutions(maxResolutions) &&
      isAboveMinAcceptableResolutions(minCamResolutions)
  }

  const format = _.flow(
    _.orderBy(pixelRes, ['desc']),
    _.find(isSuitableRes),
  )(formats)

  if (!format) throw new Error('Unsupported cam resolution!')
  return format
}

const pickFormat = mode => formats => setConfig(formats, mode)

function config(_configuration) {
  const getConfDelay = camera => _.defaultTo(DEFAULT_DELAYEDSHOT_DELAY, _.get([camera, 'diagnosticDelay'], configuration))
  configuration = _configuration
  delayedshot_delay = Math.max(getConfDelay('scanner'), getConfDelay('frontFacingCamera'))
}

const cancel = () => {
  activeStream?.destroy()
  activeStream = null
}

const isOpened = () => !!activeStream

const hasCamera = mode => {
  return Promise.resolve(cameraExists(getCameraDevice(mode)))
}

const noopStillsCallback = () => {}

const capture = ({
  device,
  mode,
  resultCallback,
  stillsCallback = noopStillsCallback,
  processCallback,
}) => {
  if (!!activeStream) {
    console.log('Camera is already open. Shouldn\'t happen.')
    return resultCallback(new Error('Camera open'))
  }

  const externallyClosedHandler = () => {
    resultCallback(null, null)
  }

  const cleanup = () => {
    activeStream.removeListener('close', externallyClosedHandler)
    activeStream.destroy()
    activeStream = null
  }

  try {
    let processing = false
    let lastStillTime = 0

    activeStream = stream(device, {
      fps: current_fps,
      pickFormat: pickFormat(mode)
    })

    // Handle camera being closed by another process
    activeStream.on('close', externallyClosedHandler)

    activeStream.on('data', async ({ frame, width, height }) => {
      if (processing) return
      processing = true
      const result = await processCallback({ frame, width, height }).catch(err => {
        cleanup()
        resultCallback(err, null)
      })
      if (result) {
        cleanup()
        resultCallback(null, result)
      } else {
        const now = Date.now()
        if (now - lastStillTime > 1000) {
          lastStillTime = now
          stillsCallback(frame)
        }
      }

      processing = false
    })
  } catch (err) {
    resultCallback(err, null)
  }
}

const scanPDF417 = ({ resultCallback, stillsCallback }) => {
  const mode = 'photoId'
  const device = getCameraDevice(mode)

  const processCallback = async ({ frame, width, height }) => {
    const bwFrame = await sharp(frame).greyscale().raw().toBuffer()
    const result = await scanner.scanPDF417({ frame: bwFrame, width, height })
    return result ? Pdf417Parser.parse(result) : null
  }

  capture({ device, mode, resultCallback, stillsCallback, processCallback })
}

const scanQR = ({ resultCallback }) => {
  const mode = 'qr'
  const device = getCameraDevice(mode)

  const processCallback = async ({ frame, width, height }) => {
    const bwFrame = await sharp(frame).greyscale().raw().toBuffer()
    return scanner.scanQRcode({ frame: bwFrame, width, height })
  }

  capture({ device, mode, resultCallback, processCallback })
}

const scanMainQR = ({ resultCallback, cryptoCode, stillsCallback }) => {
  const mode = 'qr'
  const device = getCameraDevice(mode)

  const processCallback = async ({ frame, width, height }) => {
    const pipeline = sharp(frame).greyscale();
    const [bwFrame, bwEncoded] = await Promise.all([
      pipeline.clone().raw().toBuffer(),
      pipeline.clone().jpeg().toBuffer()
    ]);
    const code = await scanner.scanQRcode({ frame: bwFrame, encodedFrame: bwEncoded, width, height })
    if (!code) return null

    return coinUtils.parseUrl(cryptoCode, NETWORK, code)
  }

  capture({ device, mode, resultCallback, stillsCallback, processCallback })
}

const delayedPhoto = ({ device, mode, resultCallback }) => {
  const timerInit = new Date().getTime()
  const processCallback = async ({ frame, width, height }) => {
    if (timerInit > new Date().getTime() - getDelayMS()) return null
    return frame
  }

  capture({ device, mode, resultCallback, processCallback })
}

const delayedFacephoto = (resultCallback) => {
  const mode = 'facephoto'
  const device = getCameraDevice(mode)
  delayedPhoto({ device, mode, resultCallback })
}

const scanPhotoCard = resultCallback => {
  const mode = 'photoId'
  const device = getCameraDevice(mode)

  const processCallback = async ({ frame, width, height }) => {
    const bwFrame = await sharp(frame).greyscale().raw().toBuffer()
    const detected = supyo.detect(bwFrame, width, height, {
      minSize: 100,
      qualityThreshold: 20,
      verbose: false
    })

    if (!detected) return null
    return frame
  }

  capture({ device, mode, resultCallback, processCallback })
}

const diagnosticPhotos = () => {
  const response = {
    scan: null,
    front: null
  }

  const delayOne = (device, field) => (
    new Promise((resolve) => {
      const resultCallback = (err, frame) => {
        if (frame) response[field] = frame
        resolve(response)
      }
      delayedPhoto({ device, resultCallback })
    })
  )

  return delayOne('/dev/video-scan', 'scan')
    .then(() => delayOne('/dev/video-front', 'front'))
}

module.exports = {
  config,
  setFPS,
  getDelayMS,
  cancel,
  isOpened,
  hasCamera,

  scanQR,
  scanMainQR,
  scanPDF417,
  scanPhotoCard,
  delayedFacephoto,
  diagnosticPhotos,
}
