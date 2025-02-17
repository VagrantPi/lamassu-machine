const manatee = require('@lamassu/manatee')
const fs = require('fs')
const { SCANNER_TYPE } = require('../consts')

const registerLicenses = () => {
  const license = require('../../../licenses.json').scanner.manatee.license
  const registerLicense = f => manatee.register(f, license[f].name, license[f].key)

  registerLicense('qr')
  registerLicense('pdf417')
}
registerLicenses()

const scanPDF417 = ({ frame, width, height }) => {
  const result = manatee.scanPDF417(frame, width, height)
  return result?.toString()
}

const scanQRcode = ({ frame, width, height }) => {
  const result = manatee.scanQR(frame, width, height)

  return result?.toString()
}

module.exports = {
  TYPE: SCANNER_TYPE.IMAGE,
  scanPDF417,
  scanQRcode
}
