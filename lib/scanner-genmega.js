const _ = require('lodash/fp')
const { utils: coinUtils } = require('@lamassu/coins')
const { bcs } = require('@lamassu/genmega')

const Pdf417Parser = require('./compliance/parsepdf417')
const scanner = require('./scanner-node')

const NETWORK = 'main'

let barcodeScannerPath = null
let gmrunning = false

function config (_configuration) {
  scanner.config(_configuration)
  scanner.setFPS(5)
  barcodeScannerPath = _.get(`scanner.device`, _configuration)
}

function cancel () {
  if (gmrunning) {
    gmrunning = false
    bcs.cancelScan()
  } else {
    scanner.cancel()
  }
}

const isOpened = () => gmrunning || scanner.isOpened()

const scanPDF417 = ({ resultCallback }) => {
  gmrunning = true
  bcs.scan(barcodeScannerPath, 1)
    .then(({ decoded, return_int, return_code, return_message }) => {
      gmrunning = false
      if (return_int < 0 && return_code !== 'HM_DEV_CANCEL') return resultCallback(new Error(return_message))
      if (return_code === 'HM_DEV_CANCEL' || !decoded) return resultCallback(null, null)

      const parsed = Pdf417Parser.parse(decoded)
      if (!parsed) return resultCallback(null, null)
      parsed.raw = decoded
      resultCallback(null, parsed)
    })
}

const scanQR = ({ resultCallback }) => {
  gmrunning = true
  bcs.scan(barcodeScannerPath, 1)
    .then(({ decoded, return_int, return_code, return_message }) => {
      gmrunning = false
      if (return_int < 0 && return_code !== 'HM_DEV_CANCEL') return resultCallback(new Error(return_message))
      if (return_code === 'HM_DEV_CANCEL' || !decoded) decoded = null
      return resultCallback(null, decoded)
    })
}

const scanMainQR = ({ resultCallback, cryptoCode }) => {
  gmrunning = true
  bcs.scan(barcodeScannerPath, 1)
    .then(({ decoded, return_int, return_code, return_message }) => {
      gmrunning = false
      if (return_int < 0 && return_code !== 'HM_DEV_CANCEL') return resultCallback(new Error(return_message))
      if (return_code === 'HM_DEV_CANCEL') return resultCallback(null, null)
      if (!decoded) {
        console.log('scanner: Empty response from genmega lib', decoded)
        return resultCallback(null, null)
      }
      console.log('DEBUG55: %s', decoded)
      try {
        resultCallback(null, coinUtils.parseUrl(cryptoCode, NETWORK, decoded))
      } catch (error) {
        resultCallback(error)
      }
    })
}

function scanPhotoCard (callback) {
  callback(new Error('ID Card photo is not supported for genmega!'))
}

module.exports = {
  config,
  scanQR,
  scanMainQR,
  scanPDF417,
  scanPhotoCard,
  cancel,
  isOpened,
  getDelayMS: scanner.getDelayMS,
  hasCamera: scanner.hasCamera,
  delayedFacephoto: scanner.delayedFacephoto,
  diagnosticPhotos: scanner.diagnosticPhotos
}
