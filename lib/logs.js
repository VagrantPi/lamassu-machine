/** @module logs */

const path = require('path')
const nodeFs = require('fs')
const fs = require('pify')(nodeFs)

const dataPath = require('./data-path')
const logsPath = path.resolve(dataPath, 'log')

const DELIMITER_SIZE = 5
const MAX_SIZE = 100000
const MAX_LINES = 2000
const ONE_MB = Math.pow(1024, 2)

/**
 * Get the newest log files
 *
 * Given a timestamp, get the newest log files
 * that are created after timestamp
 *
 * @name getNewestLogFiles
 * @function
 * @async
 *
 * @param {date} timestamp Requested date as unix timestamp
 *
 * @returns {array} Array of log filenames that exceed the timetamp provided
 */
function getNewestLogFiles (timestamp) {
  const time = timestamp.slice(0, 10)
  return fs.readdir(logsPath).then(files =>
    files.filter(filename => filename.slice(0, 10) >= time && filename.slice(-3) === 'log')
  )
}

/**
 * Get the older log files
 *
 * Given a timestamp, get the log files
 * that are created on and before the timestamp
 *
 * @name getOlderLogFiles
 * @function
 * @async
 *
 * @param {date} timestamp Requested date as unix timestamp
 *
 * @returns {array} Array of log filenames that are older than the timetamp provided
 */
function getOlderLogFiles (timestamp) {
  const time = timestamp.slice(0, 10)
  return fs.readdir(logsPath).then(files =>
    files.filter(filename =>
      filename.slice(0, 3) === 'old' || filename.slice(0, 10) <= time
    )
  )
}

function removeLogFiles (timestamp) {
  const timestampISO = new Date(timestamp).toISOString()
  return getOlderLogFiles(timestampISO)
    .then(files =>
      Promise.all(files.map(filename =>
        fs.unlink(path.resolve(logsPath, filename))
      ))
    )
}

const parseAndHandleInvalid = it => {
  const jsonLike = /\{.*\}/g
  const match = jsonLike.exec(it)
  try {
    return [JSON.parse(match)]
  } catch (e) {
    return []
  }
}

/**
 * Given a timestamp, get the newest log lines that are created
 * after the requested date
 *
 * @name queryNewestLogs
 * @function
 *
 * @param {date} timestamp Requested date as unix timestamp
 *
 * @returns {array} Array of objects (log lines) in ascending order
 */
function queryNewestLogs (last) {
  last ??= {timestamp: new Date(0).toISOString(), serial: 0}
  const logComparator = log => [log.timestamp, log.serial]
  const logCompare = (loga, logb) => logComparator(loga) > logComparator(logb) ? 1 : -1
  const isRecent = log => logCompare(log, last) > 0

  const prepareFileLogs = logs => logs
    .split('\n')
    .flatMap(line => {
      line = line.trim()
      // Remove empty lines
      if (line.length === 0) return []

      // Parse each line
      line = parseAndHandleInvalid(line)
      if (line.length === 0) return []
      line = line[0]

      // Filter only logs that are created after the required timestamp
      return isRecent(line) ? [line] : []
    })

  return getNewestLogFiles(last.timestamp)
  // Read log data from log files
    .then(files =>
      Promise.all(files.map(filename => {
        const filePath = path.resolve(logsPath, filename)
        const rotatedPath = path.resolve(logsPath, `old${filename}`)

        return fs.stat(filePath).then(it =>
          it['size'] > ONE_MB ?
            fs.rename(filePath, rotatedPath).then(() => '') :
            fs.readFile(filePath, { encoding: 'utf8' })
        )
      }))
    )
    .then(logfiles => {
      let allLogs = logfiles
        .flatMap(prepareFileLogs)
        // Sort ascending -- all together now!
        .sort(logCompare)

      // Only send last MAX_LINES lines.
      // Ensures syncing is fast at the expensive of possible
      // gaps in server-side log storage.
      allLogs = allLogs.length > MAX_LINES ? allLogs.slice(allLogs.length - MAX_LINES) : allLogs

      // Don't send more than MAX_SIZE
      // to avoid any large payload errors
      const [logs, _size] = allLogs.reduce(([logs, size], log) => {
        size += JSON.stringify(log).length + DELIMITER_SIZE
        return [
          size < MAX_SIZE ? logs.concat([log]) : logs,
          size,
        ]
      }, [[], 0])

      return logs
    })
}

module.exports = { removeLogFiles, queryNewestLogs }
