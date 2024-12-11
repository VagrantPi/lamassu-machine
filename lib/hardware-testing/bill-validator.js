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

const addEventListeners = (validator, reject, eventListenersToAdd) => {
  const allEvents = [
    'actionRequiredMaintenance',
    'billsAccepted',
    'billsRead',
    'billsRejected',
    'billsValid',
    'cashSlotRemoveBills',
    'disconnected',
    'enabled',
    'error',
    'jam',
    'leftoverBillsInCashSlot',
    'stackerClosed',
    'stackerOpen',
    'standby',
  ]

  const handleUnexpected = eventName => (...eventArguments) => {
    const error = new Error("Unexpected event received")
    error.eventName = eventName
    error.eventArguments = [...eventArguments]
    reject(error)
  }

  allEvents.forEach(
    ev => validator.on(ev, eventListenersToAdd[ev] ?? handleUnexpected)
  )
}

const doFinally = validator => () => {
  validator.removeAllListeners()
  validator.disable()
}

const testEnable = validator => () => new Promise(
  (resolve, reject) => {
    let accepted = false
    const enable = () => {
      accepted = false
      validator.enable()
    }

    addEventListeners(validator, reject, {
      billsAccepted: () => { accepted = true },
      billsRead: bills => resolve({ accepted, bills }),
      billsRejected: () => enable(),
    })

    enable()
  }
).finally(doFinally(validator))

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
      confirmationMessage: "Did the validator reject the bill?",
      test: () =>
        new Promise((resolve, reject) => {
          addEventListeners(validator, reject, {
            billsRejected: () => resolve(),
          })
          validator.reject()
        }).finally(doFinally(validator)),
    },

    {
      name: 'enableStack',
      instructionMessage: `Try to insert a ${FIAT_CODE} bill...`,
      confirmationMessage: "Did the validator retrieve the bill?",
      test: testEnable(validator),
    },

    {
      name: 'stack',
      confirmationMessage: "Did the validator stack the bill?",
      test: () =>
        new Promise((resolve, reject) => {
          addEventListeners(validator, reject, {
            billsValid: () => resolve(),
          })
          validator.stack()
        }).finally(doFinally(validator)),
    },
  ])

module.exports = steps
