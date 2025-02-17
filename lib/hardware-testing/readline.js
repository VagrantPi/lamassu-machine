const readline = require('node:readline');
const { stdin: input, stdout: output } = require('node:process');

let rl = null


const create = () => {
  rl = readline.createInterface({
    input,
    output,
    terminal: true,
  })
}


const close = () => {
  rl.close()
  rl = null
}


const instruct = msg => new Promise((resolve, reject) => {
  try {
    rl.write(`\n${msg}\n`)
    return resolve()
  } catch (error) {
    return reject(error)
  }
})


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


module.exports = {
  create,
  instruct,
  confirm,
  close,
}
