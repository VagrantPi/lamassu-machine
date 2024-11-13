const readline = require('node:readline');
const { stdin: input, stdout: output } = require('node:process');

const PERIPHERALS = {
  printer: require('./printer'),
}


let rl = null

const confirmOnce = msg => new Promise((resolve, reject) =>
  rl.question(
    `${msg} ([y]es/[n]) `,
    answer =>
      ["y", "yes"].includes(answer) ? resolve(true) :
      ["n", "no"].includes(answer) ? resolve(false) :
      reject(true)
  )
)

const confirm = async msg => {
  msg ??= "Did it work?"
  const retry = true
  while (retry) {
    try {
      return await confirmOnce(msg)
    } catch (newRetry) {
      retry = typeof(newRetry) === 'boolean' && newRetry
    }
  }
  return false
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


const runPeripherals = peripherals => {
  rl = readline.createInterface({
    input,
    output,
    terminal: true,
  })
  return Promise.all(
    Object.entries(peripherals)
      .map(([k, p]) =>
        Promise.all([
          k,
          p().catch(() => []).then(runSteps),
        ])
      )
  )
    .then(Object.fromEntries)
    .finally(() => {
      rl.close()
      rl = null
    })
}

runPeripherals(PERIPHERALS)
  .then(console.log)
  .catch(console.log)
