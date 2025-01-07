const _ = require('lodash/fp')

const db = require('./db')

const reduceToKeyValue = (arr, key, value) => _.flow([
  _.map(item => [item[key], item[value]]),
  _.fromPairs
])(arr)

const loadTriggers = (trx) => {
  // If no transaction is passed, create a new one
  if (!trx) return db.transaction(newTrx => loadTriggers(newTrx))

  return trx('triggers')
    .select([
      'triggers.*',
      'customInfoRequests.id as cirId',
      'customInfoRequests.enabled as cirEnabled',
      'customRequests.name as crName',
      'customInputs.rowid as ciId',
      'customInputs.type as ciType',
      'customInputs.constraintType as ciConstraintType',
      'customInputs.label1 as ciLabel1',
      'customInputs.label2 as ciLabel2',
      'screen1.text as screen1Text',
      'screen1.title as screen1Title',
      'screen2.text as screen2Text',
      'screen2.title as screen2Title'
    ])
    .leftJoin('customInfoRequests', 'triggers.customInfoRequest', 'customInfoRequests.id')
    .leftJoin('customRequests', 'customInfoRequests.customRequest', 'customRequests.rowid')
    .leftJoin('customInputs', 'customRequests.input', 'customInputs.rowid')
    .leftJoin('customScreen as screen1', 'customRequests.screen1', 'screen1.rowid')
    .leftJoin('customScreen as screen2', 'customRequests.screen2', 'screen2.rowid')
    .queryContext({ booleanColumns: ['cirEnabled'] })
    .then(async rows => {
      // Get all choice lists in one query
      const choiceLists = await trx('customInputChoiceList')
        .select(['customInput', 'choiceText'])
        .orderBy('rowid')

      // Group choices by input
      const choicesByInput = _.flow([
        _.groupBy('customInput'),
        _.mapValues(_.map('choiceText'))
      ])(choiceLists)

      return rows.map(row => {
        const trigger = {
          id: row.id,
          direction: row.direction,
          requirement: row.requirement,
          triggerType: row.triggerType,
          suspensionDays: row.suspensionDays,
          threshold: row.threshold,
          thresholdDays: row.thresholdDays,
          externalService: row.externalService
        }

        if (row.cirId) {
          trigger.customInfoRequest = {
            id: row.cirId,
            enabled: row.cirEnabled,
            customRequest: {
              name: row.crName,
              input: {
                type: row.ciType,
                constraintType: row.ciConstraintType,
                label1: row.ciLabel1,
                label2: row.ciLabel2,
                choiceList: choicesByInput[row.ciId] || []
              },
              screen1: {
                text: row.screen1Text,
                title: row.screen1Title
              },
              screen2: {
                text: row.screen2Text,
                title: row.screen2Title
              }
            }
          }
        }

        return trigger
      })
    })
}

const loadStaticConfig = (trx) => {
  // If no transaction is passed, create a new one
  if (!trx) return db.transaction(newTrx => loadStaticConfig(newTrx))

  return trx('staticConfig').first().queryContext({ booleanColumns: ['paperReceipt', 'smsReceipt', 'enablePaperWalletOnly', 'hasLightning', 'twoWayMode'] })
}

/**
 * Loads the complete configuration from the database, including coins, locales,
 * operator info, receipt options, speedtest files, static config, terms,
 * triggers automation, triggers, and URLs to ping.
 * @returns {Promise<{
 *   coins: Array<{batchable: boolean, isCashInOnly: boolean, [key: string]: any}>,
 *   locales: Array<string>,
 *   operatorInfo: {active: boolean, [key: string]: any},
 *   receiptOptions: {[key: string]: boolean},
 *   speedtestFiles: Array<{url: string, size: number}>,
 *   staticConfig: Object,
 *   terms: {active: boolean, tcPhoto?: boolean, delay?: boolean, [key: string]: any},
 *   triggersAutomation: {[triggerType: string]: string},
 *   triggers: Array<Object>,
 *   urlsToPing: Array<string>
 * }>}
 */
const loadConfig = () => {
  return db.transaction(async (trx) => {
    const loaders = {
      coins: trx('coins').select().queryContext({ booleanColumns: ['batchable', 'isCashInOnly'] }),
      locales: trx('locales').pluck('locale'),
      operatorInfo: trx('operatorInfo').first()
        .then(it => it ? { active: true, ...it } : { active: false }),
      receiptOptions: trx('receiptOptions').select(['field', 'enabled']).queryContext({ booleanColumns: ['enabled'] })
        .then(it => reduceToKeyValue(it, 'field', 'enabled')),
      speedtestFiles: trx('speedtestFiles').select(['url', 'size']),
      staticConfig: loadStaticConfig(trx),
      terms: trx('terms').first().queryContext({ booleanColumns: ['active', 'tcPhoto', 'delay'] })
        .then(terms => terms ? terms : { active: false }),
      triggersAutomation: trx('triggersAutomation').select(['triggerType', 'automationType'])
        .then(it => reduceToKeyValue(it, 'triggerType', 'automationType')),
      triggers: loadTriggers(trx),
      urlsToPing: trx('urlsToPing').pluck('url')
    }

    const promises = Object.entries(loaders).map(([key, loader]) =>
      loader.then(result => [key, result])
    )

    return Promise.all(promises).then(it => {
      return Object.fromEntries(it)
    })
  })
}

/**
 * Saves the complete configuration to the database.
 * @param {Object} config - The configuration object to save
 * @param {Array<Object>} config.coins - Array of coin configurations
 * @param {Object} config.locales - Locale settings including country, fiatCode, and primaryLocale
 * @param {Object} config.machineInfo - Machine-specific information
 * @param {Object} config.operatorInfo - Operator-specific information
 * @param {Object<string, boolean>} config.receiptOptions - Receipt configuration options
 * @param {Array<{url: string, size: number}>} config.speedtestFiles - Speedtest file configurations
 * @param {Object} config.staticConfig - Static configuration settings
 * @param {Object} config.terms - Terms and conditions settings
 * @param {Object<string, string>} config.triggersAutomation - Trigger automation mappings
 * @param {Array<Object>} config.triggers - Trigger configurations
 * @param {Array<string>} config.urlsToPing - URLs to ping
 * @returns {Promise<void>}
 */
const saveConfig = async ({
  coins,
  locales,
  machineInfo,
  operatorInfo,
  receiptOptions: rawReceiptOptions,
  speedtestFiles,
  staticConfig: rawStaticConfig,
  terms,
  triggersAutomation: rawTriggersAutomation,
  triggers,
  urlsToPing,
}) => {
  return db.transaction(async (trx) => {
    const replaceAllRows = async (tableName, newRows) => {
      await trx(tableName).del()

      const filledArray = Array.isArray(newRows) && newRows.length > 0
      const notArrayNotEmpty = !Array.isArray(newRows) && newRows

      if (filledArray || notArrayNotEmpty) {
        await trx.insert(newRows).into(tableName)
      }
    }

    const saveTermsInternal = saveTerms(terms, trx)
    const saveCoins = replaceAllRows('coins', coins)
    const saveLocales = replaceAllRows('locales', locales.locales)
    const saveSpeedtestFiles = replaceAllRows('speedtestFiles', speedtestFiles)

    const receiptOptions = Object.entries(rawReceiptOptions ?? {}).map(([field, enabled]) => ({ field, enabled }))
    const saveReceiptOptions = replaceAllRows('receiptOptions', receiptOptions)
    const saveOperatorInfo = replaceAllRows('operatorInfo', operatorInfo)

    const triggersAutomation = Object.entries(rawTriggersAutomation).map(([triggerType, automationType]) => ({
      triggerType,
      automationType
    }))
    const saveTriggersAutomation = replaceAllRows('triggersAutomation', triggersAutomation)
    const saveURLsToPing = replaceAllRows('urlsToPing', urlsToPing)

    // static config
    const { country, fiatCode, primaryLocale } = locales
    const staticConfig = { ...rawStaticConfig, country, fiatCode, primaryLocale, ...machineInfo }
    const saveStaticConfig = replaceAllRows('staticConfig', staticConfig)

    const saveCustomRequest = async (customInfoRequest) => {
      const customRequest = customInfoRequest.customRequest
      const [input] = await trx('customInputs').insert({
        type: customRequest.input.type,
        constraintType: customRequest.input.constraintType,
        label1: customRequest.input.label1,
        label2: customRequest.input.label2
      }).returning('rowid')

      if (customRequest.input.choiceList?.length) {
        await trx('customInputChoiceList').insert(
          customRequest.input.choiceList.map(text => ({
            customInput: input.rowid,
            choiceText: text
          }))
        )
      }

      const [screen1] = await trx('customScreen').insert(customRequest.screen1).returning('rowid')
      const [screen2] = await trx('customScreen').insert(customRequest.screen2).returning('rowid')

      const [customRequestDb] = await trx('customRequests').insert({
        name: customRequest.name,
        input: input.rowid,
        screen1: screen1.rowid,
        screen2: screen2.rowid
      }).returning('rowid')

      return trx('customInfoRequests').insert({
        id: customInfoRequest.id,
        enabled: customInfoRequest.enabled,
        customRequest: customRequestDb.rowid
      }).returning('id')
    }

    const saveTriggers = trx('triggers').del()
      .then(() => Promise.all((triggers || []).map(async (trigger) => {
        if (!trigger.customInfoRequest) {
          return trx('triggers').insert(trigger)
        }

        const [customInfoRequest] = await saveCustomRequest(trigger.customInfoRequest)

        return trx('triggers').insert({
          ...trigger,
          customInfoRequest: customInfoRequest.id
        })
      })))

    return Promise.all([saveCoins, saveLocales, saveOperatorInfo, saveReceiptOptions, saveSpeedtestFiles, saveTermsInternal, saveTriggersAutomation, saveURLsToPing, saveStaticConfig, saveTriggers])
  })
}

/**
 * Saves or updates the terms and conditions settings.
 * @param {Object} terms - The terms configuration object
 * @param {boolean} terms.active - Whether the terms are active
 * @param {string} [terms.hash] - Hash of the terms content
 * @param {boolean} [terms.tcPhoto] - Whether photo is required for terms acceptance
 * @param {boolean} [terms.delay] - Whether there should be a delay in terms acceptance
 * @param {Object} [trx] - Optional Knex transaction object
 * @returns {Promise<void>}
 */
const saveTerms = (terms, trx) => {
  // If no transaction is passed, create a new one
  if (!trx) return db.transaction(newTrx => saveTerms(terms, newTrx))

  const deleteTerms = () => trx('terms').del()
  const disableTerms = () => trx('terms').update('active', false)
  const insertTerms = (terms) => trx('terms').insert({ rowid: 1, ...terms }).onConflict('rowid').merge()

  if (!terms || !terms.hash) return deleteTerms()
  if (terms.active) return deleteTerms().then(_ => insertTerms(terms))
  return disableTerms()
}

/**
 * Loads basic machine information from the static configuration.
 * @returns {Promise<{
 *   active: boolean,
 *   deviceName?: string,
 *   numberOfCassettes?: number,
 *   numberOfRecyclers?: number
 * }>} Machine information object
 */
const loadMachineInfo = async () => {
  const config = await loadStaticConfig()
  if (!config) return { active: false }

  return {
    active: true,
    deviceName: config.deviceName,
    numberOfCassettes: config.numberOfCassettes,
    numberOfRecyclers: config.numberOfRecyclers,
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  saveTerms,
  loadMachineInfo
}