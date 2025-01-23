const manatee = require('manatee')
const { SCANNER_TYPE } = require('../consts')

const scanPDF417 = ({ frame, width, height }) =>
  manatee.scanPDF417(frame, width, height)

const scanQRcode = ({ frame, width, height }) =>
  manatee.scanQR(frame, width, height)

module.exports = {
  TYPE: SCANNER_TYPE.IMAGE,
  scanPDF417,
  scanQRcode
}
