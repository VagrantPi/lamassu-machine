const _ = require('lodash/fp')
const BN = require('../../bn')

const { TRIGGER_TYPES, REQUIREMENTS, DIRECTIONS } = require('./consts')

const filterSinceThreshold = days => _.filter(it => daysSince(it.created) < days)

function hasTriggered (trigger, history, tx) {
  if (tx.direction !== trigger.direction && trigger.direction !== DIRECTIONS.BOTH) {
    return false
  }

  const txHistory = _.isEmpty(history) ? [] : history

  switch (trigger.triggerType) {
    case TRIGGER_TYPES.TRANSACTION_AMOUNT:
      return transactionAmount(trigger, tx.fiat)
    case TRIGGER_TYPES.TRANSACTION_VOLUME:
      return transactionVolume(trigger, txHistory, tx.fiat)
    case TRIGGER_TYPES.TRANSACTION_VELOCITY:
      return transactionVelocity(trigger, txHistory)
    case TRIGGER_TYPES.CONSECUTIVE_DAYS:
      return consecutiveDays(trigger, txHistory)
  }
}

function transactionAmount (trigger, amount) {
  return amount > trigger.threshold
}

function getTxVolume (trigger, txHistory, amount) {
  const history = _.concat(txHistory)({ fiat: amount, created: new Date() })
  const { thresholdDays } = trigger

  const total = _.compose(
    _.reduce((previous, curr) => previous.plus(curr), BN(0)),
    _.map('fiat'),
    filterSinceThreshold(thresholdDays)
  )(history)

  return total
}

function transactionVolume (trigger, txHistory, amount) {
  const { threshold } = trigger
  const total = getTxVolume(trigger, txHistory, amount)
  return total > threshold
}

function transactionVelocity (trigger, txHistory) {
  const { threshold, thresholdDays } = trigger

  const txAmount = _.compose(_.size, filterSinceThreshold(thresholdDays))(txHistory)
  return txAmount >= threshold
}

function consecutiveDays (trigger, txHistory) {
  const { thresholdDays } = trigger

  const dailyQuantity = _.compose(_.countBy(daysSince), _.map('created'))(txHistory)
  const hasPassed = _.every(it => dailyQuantity[it])(_.range(1, thresholdDays))

  return hasPassed
}

function daysSince (created) {
  let now = new Date();
  now.setHours(0, 0, 0, 0)
  
  let then = new Date(created)
  then.setHours(0, 0, 0, 0)

  return Math.round((now-then) / (1000*60*60*24))
}

function getTriggered (triggers, history, tx) {
  return _.filter(it => hasTriggered(it, history, tx))(triggers)
}

function getAmountToHardLimit (triggers, history, tx) {
  const filterByHardLimit = _.filter(({ requirement }) =>
    requirement === REQUIREMENTS.BLOCK || requirement === REQUIREMENTS.SUSPEND
  )

  const filterByDirection = _.filter(({ direction }) =>
    tx.direction === direction || direction === DIRECTIONS.BOTH
  )

  const groupedTriggers = _.compose(_.groupBy('triggerType'), filterByHardLimit, filterByDirection)(triggers)

  const filteredAmount = groupedTriggers[TRIGGER_TYPES.TRANSACTION_AMOUNT]
  const filteredVolume = groupedTriggers[TRIGGER_TYPES.TRANSACTION_VOLUME]

  const minAmount = _.min(_.map(it => it.threshold - tx.fiat)(filteredAmount))
  const minVolume = _.min(_.map(it => it.threshold - getTxVolume(it, history, tx.fiat))(filteredVolume))
  const amount = _.min([minAmount, minVolume])
  return _.isNil(amount) ? BN(Infinity) : BN(amount)
}

/**
 * 這個函式會找出每個 requirement 類型中最低的門檻值
 * 
 * @param {Array} triggers - 一個包含多個觸發條件的陣列
 * 
 * 步驟說明:
 * 1. 先定義我們要找的兩種交易類型:
 *    - TRANSACTION_AMOUNT (交易金額)
 *    - TRANSACTION_VOLUME (交易量)
 * 
 * 2. 過濾出這兩種交易類型的觸發條件
 * 
 * 3. 將觸發條件依照 requirement(要求類型) 分組
 *    例如: { BLOCK: [...], SUSPEND: [...] }
 * 
 * 4. 對每個 requirement 組別:
 *    - 取出所有的 threshold(門檻值)
 *    - 找出最小的門檻值
 * 
 * @returns {Object} 回傳一個物件，key 是 requirement 類型，value 是該類型中最小的門檻值
 * 例如: { BLOCK: 1000, SUSPEND: 2000 }
 */

function getLowestAmountPerRequirement (triggers) {
  const types = [ TRIGGER_TYPES.TRANSACTION_AMOUNT, TRIGGER_TYPES.TRANSACTION_VOLUME ]

  const filter = _.filter(({ triggerType }) => _.includes(triggerType)(types))
  const mapValues = _.mapValues(_.compose(_.min, _.map('threshold'), filter))

  return _.compose(mapValues, _.groupBy('requirement'))(triggers)
}

module.exports = {
  getTriggered,
  getAmountToHardLimit,
  getLowestAmountPerRequirement
}
