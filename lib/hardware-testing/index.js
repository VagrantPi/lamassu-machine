const { createReadline, confirm, closeReadline } = require('./confirm')

const PERIPHERALS = {
  printer: require('./printer'),
}


const defaultPost = (error, result) => error ? { error } : { result }

const reducer = (acc, {
  name,
  confirmMessage,
  skipConfirm,
  keepGoing,
  pre,
  test,
  post = defaultPost,
}) =>
  acc
  .then(([cont, report]) => {
    if (!cont) return [cont, report]
    const args = pre()
    return Promise.resolve(test(args)) // ensure it's a promise
      .then(
        result => [true, post(null, result)],
        error => [!!keepGoing, post(error, null)],
      )
      .then(([cont, result]) =>
        (skipConfirm ? Promise.resolve(true) : confirm(confirmMessage))
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
  createReadline()
  return Promise.all(Object.entries(peripherals).map(runPeripheral))
    .then(Object.fromEntries)
    .finally(() => closeReadline())
}

runPeripherals(PERIPHERALS)
  .then(results => console.log(JSON.stringify(results, null, 2)))
  .catch(console.log)
