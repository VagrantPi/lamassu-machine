const { SCANNER_TYPE } = require('../consts')

const scanPDF417 = () => {
  return [{
    format: 'PDF417',
    text: '1234567890'
  }]
}

module.exports = {
  TYPE: SCANNER_TYPE.DEVICE,
  scanPDF417,
  scanQRcode
}
