const { readBarcodesFromImageFile } = require('zxing-wasm/reader')
const { SCANNER_TYPE } = require('../consts')

const scanPDF417 = async ({ encodedFrame }) => {
  const barcode = await readBarcodesFromImageFile(new Blob([encodedFrame]), {
    formats: ['PDF417'],
    multiple: false,
    tryHarder: true,
    textMode: "HRI"
  })

  if (!barcode?.length) return null
  return barcode[0]?.text
}

const scanQRcode = async ({ encodedFrame }) => {
  const barcode = await readBarcodesFromImageFile(new Blob([encodedFrame]), {
    formats: ['QRCode'],
    maxNumberOfSymbols: 1,
    eanAddOnSymbol: "Ignore"
  })

  if (!barcode?.length) return null
  return barcode[0]?.text
}

module.exports = {
  TYPE: SCANNER_TYPE.IMAGE,
  scanPDF417,
  scanQRcode
}
