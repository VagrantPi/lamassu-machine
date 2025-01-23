const _ = require('lodash/fp')

const Pdf417Parser = require('./compliance/parsepdf417')
const { utils: coinUtils } = require('@lamassu/coins')
const { cameraExists, stream } = require('./capture/streamer/v4l2camera')
const scanner = require('./capture/scanner/zxing')
const sharp = require('sharp')

const DEFAULT_FPS = 10
const DEFAULT_DELAYEDSHOT_DELAY = 3

let configuration = null
let current_fps = DEFAULT_FPS
let delayedshot_delay = DEFAULT_DELAYEDSHOT_DELAY

let activeStream = null

const maxCamResolutions = [
  {
    width: 2592,
    height: 1944
  }
]

const minCamResolutions = [
  {
    width: 1280,
    height: 1024
  },
  {
    width: 1280,
    height: 960
  },
  {
    width: 1280,
    height: 720
  },
  {
    width: 640,
    height: 480
  }
]

const maxCamResolutionQRCode = [
  {
    width: 1920,
    height: 1080
  }
]

const maxCamResolutionPhotoId = [
  {
    width: 1280,
    height: 1024
  }
]

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

const getCameraConfig = mode =>
  _.get([mode2conf(mode), mode], configuration)

const setFPS = fps => { current_fps = fps }

function setConfig (formats, mode) {
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

function config (_configuration) {
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

const capture = (device, { mode }, returnCallback, stillsCallback, process) => {
  if (!!activeStream) {
    console.log('Camera is already open. Shouldn\'t happen.')
    return returnCallback(new Error('Camera open'))
  }

  try {
    let processing = false
    let lastStillTime = 0

    activeStream = stream(device, {
      fps: current_fps,
      pickFormat: pickFormat(mode)
    })

    const externallyClosedHandler = () => {
      returnCallback(null, null)
    }

    activeStream.on('close', externallyClosedHandler)

    activeStream.on('data', async (frame) => {
      if (processing) return
      processing = true
      const result = await process({ frame, width, height })

      if (result) {
        activeStream.removeListener('close', externallyClosedHandler)
        activeStream.destroy()
        activeStream = null
        returnCallback(null, result)
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
    returnCallback(err, null)
  }
}

const scanPDF417 = (resultCallback, idCardStillsCallback) => {
  const mode = 'photoId'
  const device = getCameraDevice(mode)

  capture(device, { mode }, resultCallback, idCardStillsCallback, async ({ frame, width, height }) => {
    const bwFrame = await sharp(frame).greyscale().raw().toBuffer()
    const result = await scanner.scanPDF417({ bwFrame, width, height })
    return result ? Pdf417Parser.parse(result) : null
  })
}

const scanQR = (resultCallback) => {
  const mode = 'qr'
  const device = getCameraDevice(mode)

  capture(device, { mode }, resultCallback, _.noop, async ({ frame, width, height }) => {
      const bwFrame = await sharp(frame).greyscale().raw().toBuffer()
      return scanner.scanQRcode({ bwFrame, width, height })
    }
  )
}

const scanMainQR = (cryptoCode, qrStillsCallback, resultCallback) => {
  const mode = 'qr'
  const device = getCameraDevice(mode)

  capture(device, { mode }, resultCallback, qrStillsCallback, async ({ frame, width, height }) => {
    const bwFrame = await sharp(frame).greyscale().raw().toBuffer()
    const code = await scanner.scanQRcode({ bwFrame, width, height })
    const network = 'main'

    if (!code) return null
    console.log(code)
    return coinUtils.parseUrl(cryptoCode, network, code)
  })
}

const delayedPhoto = (device, config, callback) => {
  const timerInit = new Date().getTime()
  capture(device, config, callback, _.noop, async ({ frame, width, height }) => {
    if (timerInit > new Date().getTime() - getDelayMS()) return null
    return frame
  })
}

const delayedFacephoto = (callback) => {
  const mode = 'facephoto'
  const device = getCameraDevice(mode)

  delayedPhoto(device, { mode }, callback)
}

const scanPhotoCard = callback => {
  const mode = 'photoId'
  const device = getCameraDevice(mode)

  delayedPhoto(device, { mode }, callback)
}

const diagnosticPhotos = () => {
  return new Promise((resolve, reject) => {

    const response = {
      scan: null,
      front: null
    }

    delayedPhoto('/dev/video-scan', { }, (err, scan) => {
      if (scan) response.scan = scan
      delayedPhoto('/dev/video-front', { }, (err, front) => {
        if (front) response.front = front
        resolve(response)
      })
    })
  })
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
