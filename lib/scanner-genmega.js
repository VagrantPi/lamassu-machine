const _ = require('lodash/fp')
const { utils: coinUtils } = require('@lamassu/coins')
const { bcs } = require('@lamassu/genmega')

const Pdf417Parser = require('./compliance/parsepdf417')
const scanner = require('./scanner')

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

function scanPDF417 (callback) {
  gmrunning = true
  bcs.scan(barcodeScannerPath, 1)
    .then(({ decoded, return_int, return_code, return_message }) => {
      gmrunning = false
      if (return_int < 0 && return_code !== 'HM_DEV_CANCEL') return callback(new Error(return_message))
      if (return_code === 'HM_DEV_CANCEL' || !decoded) return callback(null, null)

      const parsed = Pdf417Parser.parse(decoded)
      if (!parsed) return callback(null, null)
      parsed.raw = decoded
      callback(null, parsed)
    })
}

function scanQR (callback) {
  gmrunning = true
  bcs.scan(barcodeScannerPath, 1)
    .then(({ decoded, return_int, return_code, return_message }) => {
      gmrunning = false
      if (return_int < 0 && return_code !== 'HM_DEV_CANCEL') return callback(new Error(return_message))
      if (return_code === 'HM_DEV_CANCEL' || !decoded) decoded = null
      return callback(null, decoded)
    })
}

function scanMainQR (cryptoCode, shouldSaveAttempt, callback) {
  gmrunning = true
  bcs.scan(barcodeScannerPath, 1)
    .then(({ decoded, return_int, return_code, return_message }) => {
      gmrunning = false
      if (return_int < 0 && return_code !== 'HM_DEV_CANCEL') return callback(new Error(return_message))
      if (return_code === 'HM_DEV_CANCEL') return callback(null, null)
      if (!decoded) {
        console.log('scanner: Empty response from genmega lib', decoded)
        return callback(null, null)
      }
      console.log('DEBUG55: %s', decoded)
      const network = 'main'
      callback(null, coinUtils.parseUrl(cryptoCode, network, decoded))
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
