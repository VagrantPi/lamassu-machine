const readline = require('node:readline');
const { stdin: input, stdout: output } = require('node:process');

let rl = null


const createReadline = () => {
  rl = readline.createInterface({
    input,
    output,
    terminal: true,
  })
}


const closeReadline = () => {
  rl.close()
  rl = null
}


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
  createReadline,
  confirm,
  closeReadline,
}
