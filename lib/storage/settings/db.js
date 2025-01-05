const path = require('path')
const knex = require('knex')
const knexStringcase = require('knex-stringcase')

const db = knex({
  client: 'sqlite3', // or 'better-sqlite3'
  useNullAsDefault: true,
  connection: {
    filename: process.env.NODE_ENV === 'test' ? ':memory:' : 'data/settings.sqlite3',
  },
  migrations: {
    directory: path.resolve(__dirname, 'migrations'),
  },
  pool: {
    afterCreate: (conn, cb) => conn.run('PRAGMA foreign_keys = ON', cb)
  },
  ...knexStringcase.default({
    appPostProcessResponse: (result, queryContext) => {
      if (queryContext?.booleanColumns) {
        const processBooleans = (row) => {
          const processed = { ...row }
          queryContext.booleanColumns.forEach(col => {
            if (col in processed && (processed[col] === 1 || processed[col] === 0)) {
              processed[col] = Boolean(processed[col])
            }
          })
          return processed
        }

        if (Array.isArray(result)) {
          return result.map(processBooleans)
        }
        if (result && typeof result === 'object') {
          return processBooleans(result)
        }
      }
      return result
    }
  })
})

module.exports = db