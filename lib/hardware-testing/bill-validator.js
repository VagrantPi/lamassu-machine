const { load } = require("../bill-validator")

const DEVICE_CONFIG = {
  deviceType: "cashflowSc",
  rs232: {
    device: "/dev/ttyUSB0",
  },
}

const FIAT_CODE = 'EUR'

const BOXES = {
  numberOfCashboxes: 1,
  cassettes: 0,
  recyclers: 0,
}

const testEnable = validator => () => new Promise(
  (resolve, reject) => {
    let accepted = false
    const enable = () => {
      accepted = false
      validator.enable()
    }

    validator.on('billsAccepted', () => { accepted = true })
    validator.on('billsRead', bills => resolve({ accepted, bills }))
    validator.on('billsRejected', () => enable())
    validator.on('error', error => reject({ accepted, error }))

    enable()
  }
).finally(() => validator.removeAllListeners())

const steps = () =>
  new Promise((resolve, reject) => {
    const validator = load(DEVICE_CONFIG, false)
    validator.setFiatCode(FIAT_CODE)
    validator.run(
      err => err ? reject(err) : resolve(validator),
      BOXES,
    )
  })
  .then(validator => [
    {
      name: 'enableReject',
      instructionMessage: `Try to insert a ${FIAT_CODE} bill...`,
      confirmationMessage: "Did the validator retrieve the bill?",
      test: testEnable(validator),
    },

    {
      name: 'reject',
      instructionMessage: `Try to insert a ${FIAT_CODE} bill...`,
      confirmationMessage: "Did the validator reject the bill?",
      test: () => validator.reject(),
    },

    {
      name: 'enableStack',
      instructionMessage: `Try to insert a ${FIAT_CODE} bill...`,
      confirmationMessage: "Did the validator retrieve the bill?",
      test: testEnable(validator),
    },

    {
      name: 'stack',
      instructionMessage: `Try to insert a ${FIAT_CODE} bill...`,
      confirmationMessage: "Did the validator stack the bill?",
      test: () => validator.stack(),
    },
  ])

module.exports = steps
