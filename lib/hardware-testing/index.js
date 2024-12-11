const readline = require('./readline')

const PERIPHERALS = {
  printer: require('./printer'),
}


const defaultPre = () => null
const defaultPost = (error, result) => error ? { error } : { result }

const reducer = (acc, {
  name,
  instructionMessage,
  confirmationMessage,
  skipConfirm = false,
  keepGoing = false,
  pre = defaultPre,
  test,
  post = defaultPost,
}) =>
  acc
  .then(([cont, report]) => {
    if (!cont) return [cont, report]
    return (instructionMessage ?
      readline.instruct(instructionMessage) :
      Promise.resolve()
    )
      .then(() => {
        const args = pre()
        return test(args)
      })
      .then(
        result => [true, post(null, result)],
        error => [!!keepGoing, post(error, null)],
      )
      .then(([cont, result]) =>
        (skipConfirm ? Promise.resolve(true) : readline.confirm(confirmationMessage))
          .then(worked => [cont, result, worked])
          .catch(error => [false, result, false])
      )
      .then(([cont, result, confirmed]) => {
        report = Object.assign(report, {
          [name]: { result, confirmed }
        })
        return [cont, report]
      })
  })


const runSteps = steps =>
  steps.reduce(reducer, Promise.resolve([true, {}]))

const runPeripheral = ([peripheral, steps]) =>
  steps()
    .then(
      steps => steps === null ? { skipped: true } : runSteps(steps),
      error => { error }
    )
    .then(result => [peripheral, result])

const runPeripherals = peripherals => {
  readline.create()
  return Promise.all(Object.entries(peripherals).map(runPeripheral))
    .then(Object.fromEntries)
    .finally(() => readline.close())
}

runPeripherals(PERIPHERALS)
  .then(results => console.log(JSON.stringify(results, null, 2)))
  .catch(console.log)
