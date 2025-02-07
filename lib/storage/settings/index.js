const { loadMachineInfo, loadConfig, saveConfig, saveTerms } = require('./settings')

/* TODO V11 - DB_REWORK
- New method for migrating all dbs
- Fail fast when config set changes from the server
  -- Say we now fetch a bool called 'screensaverEnabled' on staticConfig
  -- During development the database should fail and not silently ignore the change
  -- Might require to be written in TS
- Trader.js should load from the db with the exact same code that loads from the server
  -- this will also prevent the silent failure when new configs are added
- Remove the db on unpair
  -- probably best to save connectionInfo and compare on dbLoad
- Maybe for atomicity reasons we should save the version of the config set
*/

module.exports = {
  loadConfig,
  loadMachineInfo,
  saveConfig,
  saveTerms,
}