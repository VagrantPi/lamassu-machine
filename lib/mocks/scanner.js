const _ = require('lodash/fp')
const Pdf417Parser = require('../compliance/parsepdf417')
const { utils: coinUtils } = require('@lamassu/coins')
const fs = require('fs')
const path = require('path')

const cbTimeout = 5000
let configuration = null
let _cancelCb = null
let mockData = null
let handle
let camera = null
let opened = false

function config (_configuration) {
  configuration = _configuration

  mockData = _.get('scanner.mock.data', configuration)
}

function scanQR (callback) {
  prepareForCapture()
  _cancelCb = callback
  handle = setTimeout(function () {
    const devToolsValues = configuration.brain.devTools.getValues()
    const pairingData = devToolsValues.pairingToken || mockData.pairingData
    opened = false
    _cancelCb = null
    callback(null, pairingData)
  }, cbTimeout)
}

function scanMainQR (cryptoCode, ignore, callback) {
  prepareForCapture()
  _cancelCb = callback
  handle = setTimeout(function () {
    opened = false
    _cancelCb = null
    if (!mockData.qrDataSource) {
      const devToolsValues = configuration.brain.devTools.getValues()
      const walletAddress = devToolsValues.walletAddresses[cryptoCode] || mockData.qrData[cryptoCode]
      forward(null, walletAddress)
    } else {
      fs.readFile(path.join(__dirname, '../../', mockData.qrDataSource), forward)
    }

    function forward (err, resultStr) {
      const network = 'main'
      try {
        callback(null, coinUtils.parseUrl(cryptoCode, network, resultStr))
      } catch (error) {
        callback(error)
      }
    }
  }, cbTimeout)
}

function scanPDF417 (callback) {
  prepareForCapture()
  _cancelCb = callback

  const pdf417Data = mockData.pdf417Data
  handle = setTimeout(function () {
    _cancelCb = null
    opened = false
    var parsed = Pdf417Parser.parse(pdf417Data)
    parsed.raw = pdf417Data.toString()
    callback(null, parsed)
  }, cbTimeout)
}

function scanPhotoCard (callback) {
  prepareForCapture()
  _cancelCb = callback

  const photoData = mockData.fakeLicense
  handle = setTimeout(function () {
    _cancelCb = null
    opened = false
    callback(null, photoData)
  }, cbTimeout)
}

function scanFacephoto (callback) {
  prepareForCapture()
  _cancelCb = callback

  const photoData = mockData.fakeFacePhoto
  handle = setTimeout(function () {
    _cancelCb = null
    opened = false
    callback(null, photoData)
  }, cbTimeout)
}

function isOpened () {
  return opened
}

function hasCamera () {
  return Promise.resolve(true)
}

function cancel () {
  console.log("closing camera")
  opened = false
  clearTimeout(handle)
  camera && camera.closeCamera()
  if (_cancelCb) _cancelCb(null, null)
  _cancelCb = null
}

function prepareForCapture() {
  console.log("opening camera")
  opened = true
}

function diagnosticPhotos () {
  return Promise.resolve({
    scan: mockData.fakeLicense.toString('base64'),
    front: mockData.fakeFacePhoto.toString('base64')
  })
}

const delayedFacephoto = callback =>
  scanFacephoto(callback)

const getDelayMS = () => 3000

module.exports = {
  config,
  scanQR,
  scanMainQR,
  scanPDF417,
  scanPhotoCard,
  getDelayMS,
  cancel,
  isOpened,
  hasCamera,
  delayedFacephoto,
  diagnosticPhotos
}
