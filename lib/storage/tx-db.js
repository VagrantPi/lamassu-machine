const _ = require('lodash/fp')
const { existsSync, readdirSync } = require('node:fs')
const { appendFile, mkdir, readFile, readdir, unlink, writeFile } = require('node:fs/promises')
const cp = require('node:child_process')
const uuid = require('uuid')
const path = require('node:path')

const BN = require('../bn')

let dbName

module.exports = { save, prune, clean }

function list (dbRoot) {
  return mkdir(dbRoot)
    .catch(() => {})
    .then(() => readdir(dbRoot))
}

function rotate (dbRoot) {
  dbName = 'tx-db-' + uuid.v4() + '.dat'
  return mkdir(dbRoot)
    .catch(() => {})
    .then(() => writeFile(path.resolve(dbRoot, dbName), ''))
}

function save (dbRoot, tx) {
  return appendFile(path.resolve(dbRoot, dbName), JSON.stringify(tx) + '\n')
}

function nuke (dbPath) {
  return unlink(dbPath)
}

function safeJsonParse (txt) {
  try {
    return JSON.parse(txt)
  } catch (_) {

  }
}

function pruneFile (dbRoot, cleanP, _dbName) {
  const dbPath = path.resolve(dbRoot, _dbName)

  return load(dbPath)
    .then(txs => cleanP(txs))
    .then(r => {
      return nuke(dbPath)
        .catch(err => console.log(`Couldn't nuke ${dbPath}: ${err}`))
        .then(() => r)
    })
}

function prune (dbRoot, cleanP) {
  return list(dbRoot)
    .then(files => {
      console.log(`Processing ${files.length} db files`)

      return rotate(dbRoot)
        .then(() => {
          const promises = _.map(file => pruneFile(dbRoot, cleanP, file), files)
          return Promise.all(promises)
            .then(results => {
              const sum = _.sum(results)
              if (sum === 0) return console.log('No pending txs to process.')
              console.log(`Successfully processed ${_.sum(results)} pending txs.`)
            })
            .catch(err => console.log(`Error processing pending txs: ${err.stack}`))
        })
    })
}

function massage (tx) {
  if (!tx) return

  const massagedFields = {
    fiat: _.isNil(tx.fiat) ? undefined : BN(tx.fiat),
    cryptoAtoms: _.isNil(tx.cryptoAtoms) ? undefined : BN(tx.cryptoAtoms)
  }

  return _.assign(tx, massagedFields)
}

function load (dbPath) {
  const txTable = {}

  return readFile(dbPath, {encoding: 'utf8'})
    .then(f => {
      const recs = f.split('\n')
      const parse = _.flow([safeJsonParse, massage])
      const txs = _.remove(_.isEmpty, _.map(parse, recs))
      _.forEach(tx => { txTable[tx.id] = tx }, txs)
      return _.sortBy(tx => tx.deviceTime, _.values(txTable))
    })
}

function clean (dbRoot) {
  if (_.isNil(dbRoot)) return
  if (!existsSync(dbRoot)) return
  const files = readdirSync(dbRoot)
  if (files.length) {
    cp.exec('rm ' + dbRoot + '/*', {}, err => {
      if (err) console.log(err)
    })
  }
}
