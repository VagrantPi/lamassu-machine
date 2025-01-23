const manatee = require('manatee')
const { SCANNER_TYPE } = require('../consts')

const registerLicenses = () => {
  const license = require('../../../licenses.json').scanner.manatee.license
  const registerLicense = f => manatee.register(f, license[f].name, license[f].key)
  ['qr', 'pdf417'].forEach(registerLicense)
}
registerLicenses()

const scanPDF417 = ({ frame, width, height }) =>
  manatee.scanPDF417(frame, width, height)

const scanQRcode = ({ frame, width, height }) =>
  manatee.scanQR(frame, width, height)

module.exports = {
  TYPE: SCANNER_TYPE.IMAGE,
  scanPDF417,
  scanQRcode
}
