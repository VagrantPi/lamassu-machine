const { load } = require('../printer/loader')

const PRINTER_CONFIG = {
  model: "genmega",
  address: "/dev/ttyS4",
}

const RECEIPT_DATA = {
  operatorInfo: {
    name: "operator name",
    website: "operator website",
    email: "operator email",
    phone: "operator phone",
    companyNumber: "operator companyNumber",
  },
  location: "location",
  customer: "customer",
  session: "session",
  time: "14:29",
  direction: 'Cash-in',
  fiat: "200 EUR",
  crypto: "1.234 BTC",
  rate: "1 BTC = 123.456 EUR",
  address: "bc1qdg6hsh9w8xwdz66khec3fl8c9wva0ys2tc277f",
  txId: "07b2c12b88a2208f21fefc0a65dd045e073c566e47b721c51238886702539283",
}

const RECEIPT_CONFIG = Object.fromEntries([
  "operatorWebsite",
  "operatorEmail",
  "operatorPhone",
  "companyNumber",
  "machineLocation",
  "customerNameOrPhoneNumber",
  "exchangeRate",
  "addressQRCode",
].map(k => [k, true]))

const WALLET = { privateKey: "private    key" }

const steps = () => load().then(printer =>
  [
    {
      name: 'checkStatus',
      skipConfirm: true,
      pre: () => PRINTER_CONFIG,
      test: printerCfg => printer.checkStatus(printerCfg),
    },

    {
      name: 'printReceipt',
      confirmMessage: "Was a receipt printed?",
      keepGoing: true,
      pre: () => ({
        receiptData: RECEIPT_DATA,
        printerCfg: PRINTER_CONFIG,
        receiptCfg: RECEIPT_CONFIG,
      }),
      test: ({ receiptData, printerCfg, receiptCfg }) =>
        printer.printReceipt(receiptData, printerCfg, receiptCfg),
    },

    {
      name: 'printWallet',
      confirmMessage: "Was a wallet printed?",
      keepGoing: true,
      pre: () => ({
        wallet: WALLET,
        printerCfg: PRINTER_CONFIG,
        cryptoCode: 'BTC',
      }),
      test: ({ wallet, printerCfg, cryptoCode }) =>
        printer.printWallet(wallet, printerCfg, cryptoCode),
    },
  ]
)

module.exports = steps
