const fs = require('fs')
const fsPromises = require('node:fs/promises')
const { setTimeout: pDelay } = require('node:timers/promises')
const cp = require('child_process')
const os = require('os')
const path = require('path')
const net = require('net')
const _ = require('lodash/fp')
const minimist = require('minimist')
const pify = require('pify')
const pRetry = require('p-retry')
const { utils: coinUtils } = require('@lamassu/coins')
const uuid = require('uuid');

const commandLine = minimist(process.argv.slice(2))

const pairing = require('./pairing')
const Tx = require('./tx')
const BN = require('./bn')
const version = require('../package.json').version
const db = require('./storage/tx-db')
const actionEmitter = require('./action-emitter')
const optimizeDispense = require('./dispense-optimizer')
const ping = require('./ping')
const ledManager = require('./leds/led-manager')
const { setVariableInterval, clearVariableInterval } = require('./variable-interval.js')

const deviceConfig = require('../device_config.json')

const E = require('./error')
const sms = require('./compliance/flows/sms')
const email = require('./compliance/flows/email')
const complianceTiers = require('./compliance/compliance-tiers')
const idCardData = require('./compliance/flows/id-card-data')
const idCardPhoto = require('./compliance/flows/id-card-photo')
const facephoto = require('./compliance/flows/facephoto')
const sanctions = require('./compliance/flows/sanctions')
const usSsn = require('./compliance/flows/US-SSN')
const customTier = require('./compliance/flows/custom-info-request')
const external = require('./compliance/flows/external')

const { getLowestAmountPerRequirement, getAmountToHardLimit, getTriggered } = require('./compliance/triggers/triggers')
const { ORDERED_REQUIREMENTS, REQUIREMENTS } = require('./compliance/triggers/consts')

const printerLoader = require('./printer/loader')
const billValidator = require('./bill-validator')
const BigNumber = BN.klass

let transitionTime

const CUSTOMER_AUTHENTICATION = {
  SMS: 'SMS',
  EMAIL: 'EMAIL'
}
const AUTOMATABLE_REQUIREMENTS = ['idCardData', 'sanctions', 'idCardPhoto', 'facephoto', 'usSSn']
const COMPLIANCE_VERIFICATION_STATES = ['smsVerification', 'permission_id', 'permission_face_photo', 'usSsnPermission', 'customInfoRequestPermission', 'externalPermission']
const COMPLIANCE_REJECTED_STATES = ['registerUsSsn', 'inputCustomInfoRequest', 'externalCompliance']
const BILL_ACCEPTING_STATES = ['billInserted', 'billsRead', 'acceptingBills', 'acceptingFirstRecyclerBills', 'acceptingRecyclerBills',
  'acceptingFirstBill', 'maintenance']
const NON_TX_STATES = ['networkDown', 'connecting', 'pairing', 'initializing', 'booting']
const ARE_YOU_SURE_ACTIONS = ['cancelTransaction', 'continueTransaction']
const ARE_YOU_SURE_HANDLED = ['depositCancel']
const ARE_YOU_SURE_SMS_HANDLED = ['cancelPhoneNumber', 'cancelSecurityCode']
const ARE_YOU_SURE_HANDLED_SMS_COMPLIANCE = ['deposit_timeout', 'rejected_zero_conf']
const INITIAL_STATE = 'start'
const MIN_SCREEN_TIME = 1000
const ACTIVE_POLL_INTERVAL = commandLine.pollTime || 5000
const IDLE_POLL_INTERVAL = 30 * 1000
const INSUFFICIENT_FUNDS_CODE = 570
const SCORE_THRESHOLD_REACHED_CODE = 571
const CIPHERTRACE_ERROR_CODE = 572
const NETWORK_TIMEOUT_INTERVAL = 20000
const EXTERNAL_VALIDTION_TIMEOUT = 60000
const MIN_WAITING = 500
const STATUS_QUERY_TIMEOUT = 2000
const DEFAULT_NUMBER_OF_CASSETTES = 2
const DEFAULT_NUMBER_OF_RECYCLERS = 0

const SCANNER_TIMEOUT = 120000
const CONNECTING_TIMEOUT = 40000
const QR_TIMEOUT = 60000
const GOODBYE_TIMEOUT = 2000
const INVALID_ADDRESS_TIMEOUT = 10000
const BILL_TIMEOUT = 60000
const COMPLETED_TIMEOUT = 60000
const PERIODIC_LOG_INTERVAL = 3600000
const INSUFFICIENT_FUNDS_TIMEOUT = 30000
const CHECK_IDLE = 10000
const IDLE_TIME = 600000
const EXIT_TIME = 10800000
const PROMO_CODE_TIMEOUT = 15000
const PING_INTERVAL = 3600000
const SPEED_TEST_INTERVAL = 86400000
const TERMS_DELAY = 7000

const TRIGGER_AUTOMATION = {
  AUTOMATIC: 'Automatic',
  MANUAL: 'Manual'
}

/**
 * Brain 是一個主要的控制器類別，負責管理加密貨幣ATM的核心功能
 * 
 * @param {Object} config - 包含所有設定值的物件
 *   config.brain - Brain 類別專用的設定
 *   config.dataPath - 存放資料的路徑
 *   config.billValidator - 鈔票驗證器的設定
 *   config.billDispenser - 鈔票發放器的設定
 *   config.cryptomatMaker - ATM製造商名稱
 *   config.mockCam - 是否使用模擬的相機
 *   config.qrSnapshotDebug - 是否要儲存QR code掃描的除錯資訊
 *
 * Brain 類別會:
 * 1. 初始化所有必要的路徑 (資料路徑、憑證路徑等)
 * 2. 設定並啟動鈔票驗證器
 * 3. 設定並啟動鈔票發放器 
 * 4. 設定並啟動掃描器(用於掃描QR code)
 * 5. 設定並啟動印表機
 * 6. 設定瀏覽器介面
 * 
 * 這個類別是整個ATM系統的大腦,負責協調所有硬體設備和處理交易邏輯
 */

const Brain = function (config) {
  
  if (!(this instanceof Brain)) return new Brain(config)

  this.rootConfig = config
  this.config = config.brain

  this.bootTime = Date.now()

  this.dataPath = path.resolve(__dirname, '..', this.config.dataPath)
  this.certPath = {
    cert: path.resolve(this.dataPath, 'client.pem'),
    key: path.resolve(this.dataPath, 'client.key')
  }

  this.connectionInfoPath = path.resolve(this.dataPath, 'connection_info.json')
  this.dbRoot = path.resolve(this.dataPath, 'tx-db')

  if (this.isUsingMocks(config)) {
    // Inject the dev tools into brain's config, for values to be accessible inside mocks, allowing them to be changed on the fly
    const DevTools = require('./devtools')
    this.config.devTools = new DevTools(config)
    this.config.devTools.run()
  }

  this.isGenmegaMachine = config.cryptomatMaker === 'genmega'

  this.shouldSaveQrAttempts = config.qrSnapshotDebug
  this.scanner = config.mockCam
    ? require('./mocks/scanner')
    : require(`./${this.isGenmegaMachine ? 'scanner-genmega' : 'scanner-node'}`)

  this.scanner.config(config)

  if (!_.isNil(config.billValidator.rs232)) {
    config.billValidator.rs232.device = determineDevicePath(config.billValidator.rs232.device)
  }

  if (config.billDispenser) {
    config.billDispenser.device = determineDevicePath(config.billDispenser.device)
  }

  this.billValidator = this.loadBillValidator()

  printerLoader.load().then(printer => {
    this.printer = printer
  }).catch(console.log)

  this.setBrowser(require('./browser')())
  this._setState(INITIAL_STATE)
  this.tx = null
  this.permissionsGiven = {}
  this.requirementAmountTriggered = {}
  this.pk = null
  this.currentScreenTimeout = null
  this.screenTimeout = null
  this.networkDown = true
  this.hasConnected = false
  this.localeInfo = {
    primaryLocale: "en-US",
    primaryLocales: ["en-US"]
  }
  this.dirtyScreen = false
  this.billValidatorErrorFlag = false
  this.startDisabled = false
  this.uiCassettes = null
  this.scannerTimeout = null
  this.manualTriggersDataProvided = _.zipObject(AUTOMATABLE_REQUIREMENTS, Array(AUTOMATABLE_REQUIREMENTS.length).fill(false))
  this.txBlockedByTrigger = false
  this.termsAcceptButtonPressed = false
  this.networkDownTimeout = null

  this.numberOfCassettes = _.isFinite(parseInt(deviceConfig.billDispenser.cassettes))
    ? parseInt(deviceConfig.billDispenser.cassettes)
    : DEFAULT_NUMBER_OF_CASSETTES

  this.numberOfRecyclers = _.isFinite(parseInt(deviceConfig.billDispenser.recyclers))
    ? parseInt(deviceConfig.billDispenser.recyclers)
    : DEFAULT_NUMBER_OF_RECYCLERS

  if (!this.billValidator.reenable) this.billValidator.reenable = ()=>{}

  // 當機器開始接受第一張鈔票到回收箱時，重新啟動鈔票驗證器
  // 讓機器可以繼續接收鈔票
  this.on('acceptingFirstRecyclerBills', () => this.reenableBillValidator())

  // 當機器正在接受鈔票到回收箱時，重新啟動鈔票驗證器
  // 讓機器可以繼續接收鈔票
  this.on('acceptingRecyclerBills', () => this.reenableBillValidator())

  // 當機器開始接受第一張鈔票時，重新啟動鈔票驗證器
  // 讓機器可以繼續接收鈔票
  this.on('acceptingFirstBill', () => this.reenableBillValidator())

  // 當機器正在接受鈔票時，重新啟動鈔票驗證器
  // 讓機器可以繼續接收鈔票
  this.on('acceptingBills', () => this.reenableBillValidator())
}

const EventEmitter = require('events').EventEmitter
const util = require('util')
util.inherits(Brain, EventEmitter)

Brain.prototype.isUsingMocks = function isUsingMocks (config) {
  return config.mockCam || config.mockBillDispenser || config.mockBillValidator
}

Brain.prototype.checkDownloadSpeed = function checkDownloadSpeed (files) {
  ping.checkDownloadSpeed(files)
    .then(res => {
      if (!res) return
      const filteredResults = _.filter(x => {
        if (_.isNil(x.speed)) return false
        return _.isFinite(_.toNumber(x.speed))
      })(res)
      if (_.isEmpty(filteredResults)) return
      this.trader.networkPerformance(filteredResults)
    })
    .catch(console.error)
}

Brain.prototype.networkHeartbeat = function networkHeartbeat (urls) {
  ping.pingRepository(urls)
    .then(res => {
      if (!res) return
      const filteredResults = _.filter(x => x.isAlive)(res)
      if (_.isEmpty(filteredResults)) return
      this.trader.networkHeartbeat(filteredResults)
    })
    .catch(console.error)
}

Brain.prototype.initNetworkMeasurements = function initNetworkMeasurements () {
  this.networkHeartbeat(this.trader.urlsToPing)
  this.checkDownloadSpeed(this.trader.speedtestFiles)

  this.pingInterval = setInterval(() => {
    return this.networkHeartbeat(this.trader.urlsToPing)
  }, PING_INTERVAL)

  this.speedtestInterval = setInterval(() => {
    return this.checkDownloadSpeed(this.trader.speedtestFiles)
  }, SPEED_TEST_INTERVAL)
}

Brain.prototype.traderRun = function traderRun () {
  return this.trader.loadConfigsFromDB()
    .then(_ => this.trader.poll())
    .finally(() => {
      this.pollHandle = setVariableInterval(
        () => {
          if (this.state === 'networkDown') this.trader.clearConfigVersion()
          return this.trader.poll()
        },
        ACTIVE_POLL_INTERVAL,
        res => (res || this.networkDown) ? ACTIVE_POLL_INTERVAL : IDLE_POLL_INTERVAL
      )
    })
}

Brain.prototype.stop = function stop () {
  clearVariableInterval(this.pollHandle)
  clearInterval(this.pingInterval)
  clearInterval(this.speedtestInterval)
}

Brain.prototype.prunePending = function prunePending (txs) {
  const pendingTxs = _.filter('dirty', txs)

  if (_.isEmpty(pendingTxs)) return 0

  const modifier = tx => tx.direction === 'cashIn'
    ? Tx.update(tx, { send: true, timedout: true })
    : Tx.update(tx, { timedout: true })

  const postTx = tx => {
    return this.postTx(modifier(tx))
      .catch(err => {
        if (err instanceof E.RatchetError) return
        if (err instanceof E.StaleError) return
        throw err
      })
  }

  // Since it's pending we want to send and not wait for more bills
  const promises = _.map(postTx, pendingTxs)

  return Promise.all(promises)
    .then(() => pendingTxs.length)
}

Brain.prototype.loadBillValidator = function loadBillValidator () {
  return billValidator.load(this.rootConfig.billValidator, !!commandLine.mockBillValidator)
}

Brain.prototype.billValidatorHasShutter = function billValidatorHasShutter () {
  return this.billValidator.hasShutter
}

Brain.prototype.isCashRecycler = function isCashRecycler () {
  return this.billValidator.isCashRecycler
}

Brain.prototype.processPending = function processPending () {
  const pending = [db.prune(this.dbRoot, txs => this.prunePending(txs))]

  // if (fs.existsSync(path.resolve(this.dataPath, 'empty-unit'))) {
  //   console.log('Pending emptyUnit event queued for processing')
  //   pending.push(this._emptyUnit(true))
  // }

  // if (fs.existsSync(path.resolve(this.dataPath, 'refill-unit'))) {
  //   console.log('Pending refillUnit event queued for processing')
  //   pending.push(this._refillUnit(true))
  // }

  console.log('Processing pending txs...')
  return Promise.all(pending)
    .catch(err => console.log(err.stack))
}

/**
 * run() 是 Brain 類別的主要執行函式
 * 
 * 這個函式會:
 * 1. 初始化系統 (_init())
 * 2. 啟動 LED 燈控制 (ledManager.run())
 * 3. 讓瀏覽器開始監聽網路連線
 * 4. 定期記錄系統狀態 (_periodicLog())
 * 
 * 它也會設定一個定時重啟的功能:
 * - 當系統閒置一段時間後會自動重啟
 * - 重啟前會先切換到 'restart' 狀態
 * 
 * 另外還會:
 * - 檢查是否有前置相機可用於拍照
 * - 檢查是否有憑證檔案
 *   - 如果沒有憑證 -> 進入 'virgin' 狀態
 *   - 如果有憑證 -> 進入 'booting' 狀態並初始化交易系統
 * 
 * @returns {void} 這個函式不會回傳任何值
 */
Brain.prototype.run = function run () {
  console.log('crypto Machine software initialized.')
  const self = this
  this._init()
  ledManager.run(deviceConfig.cryptomatModel)
  this.browser().listen(this.config.wsHost, this.config.wsPort)
  this._periodicLog()

  const callback = function () {
    self._transitionState('restart')
    console.log('Scheduled restart after idle time.')
    process.exit()
  }

  this.scanner.hasCamera('facephoto')
    .catch(err => {
      console.log(err)
      return false
    })
    .then(hasFrontFacingCamera => {
      this.hasFrontFacingCamera = hasFrontFacingCamera
      if (!hasFrontFacingCamera) console.log('Warning: no front facing camera detected.')
    })

  this._executeCallbackAfterASufficientIdlePeriod(callback)

  this.clientCert = pairing.getCert(this.certPath)

  if (!this.clientCert) {
    return this._transitionState('virgin', { version })
  }

  if (this.state === 'maintenance') return
  this._transitionState('booting')
  this.initTrader()
}

Brain.prototype.epipeLogs = function epipeLogs () {
  if (this.trader) {
    this.trader.epipeLogs()
  }
}

Brain.prototype._executeCallbackAfterASufficientIdlePeriod =
function _executeCallbackAfterASufficientIdlePeriod (callback) {
  const self = this
  const exitOnIdle = EXIT_TIME + IDLE_TIME

  setInterval(function () {
    if (self.isStaticState()) {
      const date = new Date()
      const elapsed = (date.getTime()) - self.bootTime
      if (exitOnIdle && elapsed > exitOnIdle) {
        callback()
      }
    }
  }, CHECK_IDLE)
}

Brain.prototype._periodicLog = function _periodicLog () {
  const self = this
  const tempSensorPath = this.config.tempSensorPath
  const readFile = pify(fs.readFile)
  const tempSensorPaths = _.compact(_.castArray(tempSensorPath))
  const machine = this.rootConfig.cryptomatModel

  function reporting () {
    const clauses = ['machine: %s, version: %s, cpuLoad: %s, memUse: %s, memFree: %s\n  nodeUptime: %s, ' +
    'osUptime: %s']

    const tempPromises = _.map(path => readFile(path, { encoding: 'utf8' }), tempSensorPaths)

    return Promise.any(tempPromises)
      .then((temperature) => {
        if (temperature.value) {
          clauses.push('CPU temperature: ' + (temperature.value.trim() / 1000) + '° C')
        }
      })
      // Do nothing, we don't want to fail the whole reporting because of a missing temp sensor
      .catch(() => {})
      .finally(() => {
        const cpuLoad = os.loadavg()[1].toFixed(2)
        const memUse = (process.memoryUsage().rss / Math.pow(1000, 2)).toFixed(1) +
      ' MB'
        const memFree = (os.freemem() * 100 / os.totalmem()).toFixed(1) + '%'
        const nodeUptimeMs = Date.now() - self.bootTime
        const nodeUptime = (nodeUptimeMs / 3600000).toFixed(2) + 'h'
        const osUptime = (os.uptime() / 3600).toFixed(2) + 'h'
        const format = clauses.join(', ')
        console.log(format, machine, version, cpuLoad, memUse, memFree, nodeUptime, osUptime)
      })
  }
  reporting()
  setInterval(reporting, PERIODIC_LOG_INTERVAL)
}

Brain.prototype.initialize = function initialize () {
  this.clientCert = pairing.getCert(this.certPath)

  if (!this.clientCert) this._transitionState('initializing')

  pairing.init(this.certPath)
    .then(clientCert => {
      this.clientCert = clientCert

      if (this.state === 'maintenance') return
      this._transitionState('booting')
      this.initTrader()
    })
}
/**
 * 初始化所有需要的功能
 * 這個函式會呼叫其他初始化函式來設定:
 * - 心跳檢測 (確認系統是否還在運作)
 * - 瀏覽器事件 (處理使用者介面的互動)
 * - 鈔票驗證器事件 (處理現金投入)
 * - Brain事件 (處理主要邏輯)
 * - 動作事件 (處理各種操作)
 */
Brain.prototype._init = function init () {
  this._initHearbeat()
  this._initBrowserEvents()
  this._initBillValidatorEvents()
  this._initBrainEvents()
  this._initActionEvents()
}

Brain.prototype._initHearbeat = function _initHeartbeat () {
  let pingIntervalPtr

  const heartbeatServer = net.createServer(function (c) {
    console.log('heartbeat client connected')
    c.on('end', function () {
      clearInterval(pingIntervalPtr)
      console.log('heartbeat client disconnected')
    })

    c.on('error', function (err) {
      console.log('hearbeat server error: %s', err)
    })

    pingIntervalPtr = setInterval(function () {
      c.write('ping')
    }, 5000)
  })

  try { fs.unlinkSync('/tmp/heartbeat.sock') } catch (ex) {}
  heartbeatServer.listen('/tmp/heartbeat.sock', function () {
    console.log('server bound')
  })
}

Brain.prototype._initTraderEvents = function _initTraderEvents () {
  const self = this
  this.trader.on('pollUpdate', needsRefresh => this._pollUpdate(needsRefresh))
  this.trader.on('networkDown', function () { self._networkDown() })
  this.trader.on('networkUp', function () { self._networkUp() })
  this.trader.on('error', function (err) { console.log(err.stack) })
  this.trader.on('unpair', function () { self._unpair() })
  this.trader.on('reboot', function () { self._reboot() })
  this.trader.on('shutdown', function () { self._shutdown() })
  this.trader.on('restartServices', function () { self._restartServices('Remote restart services', true) })
  this.trader.on('emptyUnit', function () { self._emptyUnit() })
  this.trader.on('refillUnit', function () { self._refillUnit() })
  this.trader.on('diagnostics', function () { self._diagnostics() })
}

Brain.prototype._initBrowserEvents = function _initBrowserEvents () {
  const self = this
  const browser = this.browser()

  browser.on('connected', function () { self._connectedBrowser() })
  browser.on('message', function (req) { self._processRequest(req) })
  browser.on('messageError', function (err) {
    console.log('Browser error: ' + err.message)
  })
  browser.on('error', function (err) {
    console.log('Browser connect error: ' + err.message)
    console.log('Likely that two instances are running.')
  })
}
// 這個函式是用來設定鈔票驗證機的各種事件處理
// 當鈔票驗證機發生不同狀況時,會觸發不同的事件,這個函式就是在設定要如何處理這些事件
Brain.prototype._initBillValidatorEvents = function _initBillValidatorEvents () {
  const self = this // 把 this 存在 self 變數中,這樣在事件處理中才能正確使用
  const billValidator = this.billValidator // 取得鈔票驗證機物件

  // 當發生錯誤時的處理
  billValidator.on('error', function (err) { self._billValidatorErr(err) })

  // 當機器斷線時的處理
  billValidator.on('disconnected', function () { self._billValidatorErr() })

  // 當鈔票被接受時的處理
  billValidator.on('billsAccepted', function () { self._billsInserted() })

  // 當鈔票被讀取時的處理
  billValidator.on('billsRead', function (bills) { self._billsRead(bills) })

  // 當鈔票被確認有效時的處理
  billValidator.on('billsValid', function () { self._billsValid() })

  // 當鈔票被拒絕時的處理
  billValidator.on('billsRejected', function () { self._billsRejected() })

  // 當機器進入待機狀態時的處理
  billValidator.on('standby', function () { self._billStandby() })

  // 當鈔票卡住時的處理
  billValidator.on('jam', function () { self._billJam() })

  // 當錢箱被打開時的處理
  billValidator.on('stackerOpen', function () { self._stackerOpen() })

  // 當錢箱被關閉時的處理
  billValidator.on('stackerClosed', function () { self._idle() })

  // 當需要維護時的處理
  billValidator.on('actionRequiredMaintenance', function () { self.actionRequiredMaintenance() })

  // 當機器被啟用時的處理
  billValidator.on('enabled', function () { self._billsEnabled() })

  // 當需要從出鈔口移除鈔票時的處理
  billValidator.on('cashSlotRemoveBills', () => this._cashSlotRemoveBills())

  // 當出鈔口還有剩餘鈔票時的處理
  billValidator.on('leftoverBillsInCashSlot', () => this._leftoverBillsInCashSlot())
}

Brain.prototype._initBrainEvents = function _initBrainEvents () {
  this.on('newState', function (state) {
    console.log('new brain state:', state)
  })
}

Brain.prototype._initActionEvents = function _initActionEvents () {
  actionEmitter.on('action', (...args) => this.processAction.apply(this, args))
  actionEmitter.on('brain', (...args) => this.processBrainAction.apply(this, args))
}

Brain.prototype.oldScanBayLightOn = function oldScanBayLightOn () {
  if (this.hasNewScanBay()) return
  this.billValidator.lightOn()
}

Brain.prototype.oldScanBayLightOff = function oldScanBayLightOff () {
  if (this.hasNewScanBay()) return
  this.billValidator.lightOff()
}

Brain.prototype.processBrainAction = function processBrainAction (action) {
  switch (action.action) {
    case 'scanBayLightOn': return this.oldScanBayLightOn()
    case 'scanBayLightOff': return this.oldScanBayLightOff()
  }
}

Brain.prototype.processAction = function processAction (action, stateMachine) {
  switch (action) {
    // idCardData actions
    case 'scanPDF':
      this.scanPDF()
      break
    case 'authorizeIdCardData':
      this.authorizeIdCardData()
      break
    // idCardPhoto actions
    case 'scanPhotoCard':
      this.scanPhotoCard()
      break
    case 'authorizePhotoCardData':
      this.authorizePhotoCardData()
      break
    // facephoto actions
    case 'retryTakeFacephoto':
    case 'takeFacephoto':
      this.takeFacephoto()
      break
    case 'authorizeFacephotoData':
      this.authorizeFacephotoData()
      break
    // generic actions
    case 'timeoutToScannerCancel':
      this.timeoutToScannerCancel(stateMachine)
      break
    case 'transitionScreen':
      this.transitionScreen()
      break
    case 'timeoutToFail':
      setTimeout(() => stateMachine.dispatch('FAIL'), SCANNER_TIMEOUT)
      break
    case 'success':
      this.authFlowHandleReturnState()
      break
    case 'failure':
      this.failedCompliance = stateMachine.key
      this.failedComplianceValue = this.requirementAmountTriggered[this.failedCompliance]
      this.authFlowHandleReturnState()
      break
    // sanctions
    case 'triggerSanctions':
      this.triggerSanctions()
      break
    case 'sanctionsFailure':
      this._timedState('sanctionsFailure')
      break
    // suspend
    case 'triggerSuspend':
      this.triggerSuspend()
      break
    // block
    case 'triggerBlock':
      this.triggerBlock()
      break
    // us ssn
    case 'saveUsSsn':
      this.saveUsSsn()
      break
    // custom info request data saving
    case 'saveCustomInfoRequestData':
      this.saveCustomInfoRequestData()
      break
    // external
    case 'askForExternal':
      this.triggerExternal(external.getTrigger())
      break
  }
}

Brain.prototype.transitionScreen = function transitionScreen () {
  let appState = null

  // check idCardData state
  let machineState = idCardData.getState()
  switch (machineState) {
    case 'scanId':
      appState = 'scan_id_data'
      break
    case 'authorizing':
      appState = 'verifying_id_data'
      break
    case 'idScanFailed':
      appState = 'failed_scan_id_data'
      break
    case 'idVerificationFailed':
      appState = 'failed_permission_id'
      break
  }

  if (!appState) {
    // otherwise check idCardPhoto state
    machineState = idCardPhoto.getState()
    switch (machineState) {
      case 'scanPhotoCard':
        appState = 'scan_id_photo'
        break
      case 'scanPhotoCardManual':
        appState = 'scan_manual_id_photo'
        break
      case 'authorizing':
        appState = 'verifying_id_photo'
        break
      case 'photoCardScanFailed':
        appState = 'failed_scan_id_photo'
        break
      case 'photoCardVerificationFailed':
        appState = 'failed_verifying_id_photo'
        break
    }
  }

  if (!appState) {
    // otherwise check facephoto state
    machineState = facephoto.getState()
    switch (machineState) {
      case 'takeFacephoto':
        appState = 'scan_face_photo'
        break
      case 'retryTakeFacephoto':
        appState = 'retry_scan_face_photo'
        break
      case 'authorizing':
        appState = 'verifying_face_photo'
        break
      case 'facephotoFailed':
        appState = 'failed_scan_face_photo'
        break
      case 'facephotoVerificationFailed':
        appState = 'failed_permission_id'
        break
    }

    if (!appState) {
      // sanctions state
      machineState = sanctions.getState()
      switch (machineState) {
        case 'triggerSanctions':
          appState = 'waiting'
          break
      }
    }

    if (!appState) {
      // usSsn state
      machineState = usSsn.getState()
      switch (machineState) {
        case 'askForSsn':
          appState = 'registerUsSsn'
          break
        case 'authorizing':
          appState = 'waiting'
          break
      }
    }

    if (!appState) {
      // custom info request state
      machineState = customTier.getState()
      switch (machineState) {
        case 'askForCustomInfoRequest':
          appState = 'inputCustomInfoRequest'
          break
        case 'saveData':
          appState = 'waiting'
          break
      }
    }
  }

  if (!appState) { return }
  const customInfoRequest = appState === 'inputCustomInfoRequest'
    ? {
      customInfoRequest: _.get('customInfoRequest.customRequest')(_.find(trigger => trigger.customInfoRequestId === this.customInfoRequestId)(this.triggers))
    }
    : null
  this._transitionState(appState, _.assign(customInfoRequest, { context: 'compliance' }))
}

Brain.prototype.clearTimeoutToScannerCancel = function clearTimeoutToScannerCancel () {
  if (!this.scannerTimeout) { return }

  clearTimeout(this.scannerTimeout)
  this.scannerTimeout = null
}

Brain.prototype.timeoutToScannerCancel = function timeoutToScannerCancel (stateMachine) {
  this.clearTimeoutToScannerCancel()
  this.scannerTimeout = setTimeout(() => {
    this.scanner.cancel()
    stateMachine.dispatch('SCAN_ERROR')
  }, SCANNER_TIMEOUT)
}

Brain.prototype.scanPDF = function scanPDF () {
  const customer = this.customer
  // TODO: Change the LED code to support genmega
  this.scanBayLightOn()
  const idCardStillsCallback = photo => idCardData.addIdDataPhoto(photo)
  this.scanner.scanPDF417((err, result) => {
    this.scanBayLightOff()
    this.startDisabled = false
    if (!this.isGenmegaMachine && (err || !result)) {
      const photos = idCardData.getIdDataPhotos()
      this.trader.updateIdCardPhotos(customer.id, { photos })
        .then(
          () => console.log('Successfully saved', photos.length, 'id data photos'),
          err => console.log('Error saving id card photos', err)
        )
    }

    if (err || !result) {
      console.log(err || 'No PDF417 result')
      return idCardData.dispatch('SCAN_ERROR')
    }

    if (this.hasExpired(result)) {
      console.log('Expired ID card')
      return idCardData.dispatch('SCAN_ERROR')
    }

    idCardData.setData(result)
    this.setManualTrigger('idCardData')
    return idCardData.dispatch('SCANNED')
  }, idCardStillsCallback)
}

Brain.prototype.hasExpired = function hasExpired (cardData) {
  // TODO: ZA cards currently do not have an expiration date to confirm against
  if (cardData.country === 'ZA') return false

  // In case the expiration date field is not found. Prevents l-m from bailing
  if (_.isNil(cardData.expirationDate)) return false

  const expirationYear = cardData.expirationDate.substring(0, 4)
  const expirationMonth = cardData.expirationDate.substring(4, 6)
  const expirationDay = cardData.expirationDate.substring(6, 8)
  const expirationDate = new Date(expirationYear, expirationMonth, expirationDay)

  // this checks if the expiration date is a valid date object
  if (isNaN(expirationDate)) return true

  const now = Date.now()
  return expirationDate < now
}

Brain.prototype.triggerSanctions = function triggerSanctions () {
  const dispatchBySanctions = customerSanction => {
    const action = customerSanction ? 'SUCCESS' : 'FAILURE'
    sanctions.dispatch(action)
  }

  const customer = this.customer

  // explictly test false since sanctions can be empty
  if (customer.sanctions === false) return dispatchBySanctions(false)

  return this.trader.triggerSanctions(customer.id)
    .then(result => {
      this.customer = result.customer
      dispatchBySanctions(result.customer.sanctions)
    })
    .catch(err => {
      console.log('sanction error', err)
      dispatchBySanctions(false)
    })
}

Brain.prototype.triggerSuspend = function triggerSuspend () {
  const customer = this.customer
  const now = new Date()
  return this.trader.triggerSuspend(customer.id, this.suspendTriggerId)
    .then(result => {
      this.customer = result.customer
    })
    .catch(err => {
      console.log('block error', err)
    })
    .then(() => {
      return this.showSuspendedCustomer(this.customer, now)
    })
}

Brain.prototype.triggerBlock = function triggerBlock () {
  const customer = this.customer

  return this.trader.triggerBlock(customer.id)
    .then(result => {
      this.customer = result.customer
    })
    .catch(err => {
      console.log('block error', err)
    })
    .then(() => {
      return this.showBlockedCustomer()
    })
}

Brain.prototype.triggerExternal = function triggerExternal (trigger) {
  const customer = this.customer

  return this.trader.getExternalCompliance(customer.id, trigger.id, this.externalComplianceRetry)
    .then(result => {
      // external.dispatch('URL', result.url)
      return this.showExternalCompliance(result.url)
    })
    .catch(err => {
      console.log('external compliance error', err)
      external.dispatch('FAILURE')
    })
}

Brain.prototype.registerCustomInfoRequestData = function registerCustomInfoRequestData (data) {
  customTier.setData(data)
  customTier.dispatch('SEND')
}

Brain.prototype.saveCustomInfoRequestData = function saveCustomInfoRequestData () {
  const customer = this.customer
  const customerData = {
    customRequestPatch: { data: customTier.getData(), infoRequestId: this.customInfoRequestId }
  }

  return this.trader.updateCustomer(customer.id, customerData, this.tx.id)
    .then(result => {
      this.customer = result.customer
      this.setManualTrigger(this.customInfoRequestId)
      customTier.dispatch('SUCCESS')
    })
    .catch(err => {
      console.error('failure saving custom request data', err)
      customTier.dispatch('FAILURE')
    })
}

Brain.prototype.registerUsSsn = function registerUsSsn (ssn) {
  usSsn.setData(ssn)
  usSsn.dispatch('SEND')
}

Brain.prototype.saveUsSsn = function saveUsSsn () {
  const customer = this.customer

  return this.trader.updateCustomer(customer.id, { usSsn: usSsn.getData() }, this.tx.id)
    .then(result => {
      this.customer = result.customer
      this.setManualTrigger('usSsn')
      usSsn.dispatch('SUCCESS')
    })
    .catch(err => {
      console.log('failure saving us ssn error', err)
      usSsn.dispatch('FAILURE')
    })
}

Brain.prototype.fromYYYYMMDD = function (string) {
  let year = string.substring(0, 4)
  let month = string.substring(4, 6)
  let day = string.substring(6, 8)

  return new Date(year, month - 1, day)
}

Brain.prototype.authorizeIdCardData = function authorizeIdCardData () {
  return Promise.resolve()
    .then(() => {
      this.clearTimeoutToScannerCancel()

      const customer = this.customer
      const data = idCardData.getData()
      const idCardDataExpiration = data.expirationDate ? this.fromYYYYMMDD(data.expirationDate) : null

      return this.trader.updateCustomer(customer.id, {
        idCardData: _.omit(['raw'], data),
        idCardDataRaw: JSON.stringify(data.raw),
        idCardDataNumber: data.documentNumber,
        idCardDataExpiration
      }, this.tx.id)
    })
    .then(result => {
      this.customer = result.customer
      idCardData.dispatch('AUTHORIZED')
    }, err => {
      this._fiatError(err)
    })
    .catch(err => {
      console.log('authorizeIdCardData error', err)
      idCardData.dispatch('BLOCKED_ID')
    })
}

Brain.prototype.scanPhotoCard = function scanPhotoCard () {
  this.scanBayLightOn()
  this.scanner.scanPhotoCard((err, result) => {
    this.scanBayLightOff()
    this.startDisabled = false

    if (err) {
      console.log(err)
      return idCardPhoto.dispatch('SCAN_ERROR')
    }

    if (!result) {
      console.log('No card photo result')
      return
    }

    idCardPhoto.setData(result.toString('base64'))
    this.setManualTrigger('idCardPhoto')
    return idCardPhoto.dispatch('SCANNED')
  })
}

Brain.prototype.authorizePhotoCardData = function authorizePhotoCardData () {
  return Promise.resolve()
    .then(() => {
      this.clearTimeoutToScannerCancel()

      const customer = this.customer
      const data = idCardPhoto.getData()
      return this.trader.updateCustomer(customer.id, {
        idCardPhotoData: data
      }, this.tx.id)
    })
    .then(result => {
      this.customer = result.customer
      idCardPhoto.dispatch('AUTHORIZED')
    }, err => {
      this._fiatError(err)
    })
    .catch(err => {
      console.log('authorizePhotoCardData error', err)
      idCardPhoto.dispatch('BLOCKED_ID')
    })
}

Brain.prototype.retryFacephoto = function retryFacephoto () {
  facephoto.dispatch('RETRY')
}

Brain.prototype.takeFacephoto = function takeFacephoto () {
  this.scanner.delayedFacephoto((err, result) => {
    this.startDisabled = false

    if (err) {
      console.log(err)
      return facephoto.dispatch('SCAN_ERROR')
    }

    if (!result) {
      console.log('No photo result')
      return
    }

    console.log('DEBUG: ** Acceptable result, setting facephoto data! **')

    facephoto.setData(result.toString('base64'))
    this.setManualTrigger('facephoto')
    return facephoto.dispatch('PHOTO_TAKEN')
  })
}

Brain.prototype.takeFacePhotoTC = function takeFacePhotoTC () {
  this.scanner.delayedFacephoto((err, result) => {
    if (err) {
      console.log(err)
      return facephoto.dispatch('SCAN_ERROR')
    }

    if (result) facephoto.setTCData(result.toString('base64'))
  })
}

Brain.prototype.authorizeFacephotoData = function authorizeFacephotoData () {
  return Promise.resolve()
    .then(() => {
      this.clearTimeoutToScannerCancel()

      const customer = this.customer
      const data = facephoto.getData()
      return this.trader.updateCustomer(customer.id, {
        frontCameraData: data
      }, this.tx.id)
    })
    .then(result => {
      this.customer = result.customer
      facephoto.dispatch('AUTHORIZED')
    }, err => {
      this._fiatError(err)
    })
    .catch(err => {
      console.log('facephoto error', err)
      facephoto.dispatch('BLOCKED_ID')
    })
}

Brain.prototype.mapCryptoUnitsDisplay = function mapCryptoUnitsDisplay (coins) {
  return _.map(coin => {
    const coinSettings = coinUtils.getCryptoCurrency(coin.cryptoCode)
    const defaultUnit = _.head(_.keys(coinSettings.units))
    const unitSelected = _.get('cryptoUnits')(coin)
    const unit = _.includes(unitSelected, _.keys(coinSettings.units)) ? unitSelected : defaultUnit

    const { displayScale, displayCode } = _.get(['units', unit])(coinSettings)
    return _.assign(coin, {
      displayCode: displayCode,
      displayScale: displayScale,
      unitScale: coinSettings.unitScale
    })
  })(coins)
}

Brain.prototype._connectedBrowser = function _connectedBrowser () {
  //  TODO: have to work on this: console.assert(this.state === State.IDLE)
  console.log('connected to browser')
  const isCoincloud = this.rootConfig.cryptomatMaker === 'coincloud'
  const cryptomatModel = isCoincloud ? 'coincloud' : this.rootConfig.cryptomatModel || 'sintra'

  if (!this.trader || !this.trader.coins) {
    const rec = {
      action: this.state,
      locale: 'en-US',
      cryptomatModel,
      version,
      operatorInfo: this.trader?.operatorInfo ?? { active: false },
      screenOpts: this.trader?.machineScreenOpts
    }

    return this.browser().send(rec)
  }

  const cryptoCode = this.singleCrypto()
    ? this.trader.coins[0].cryptoCode
    : null

  const _rates = {
    rates: this.trader.rates(cryptoCode),
    cryptoCode: cryptoCode,
    coins: coinUtils.cryptoCurrencies()
  }

  const rates = cryptoCode
    ? _rates
    : undefined

  const fullRec = {
    action: this.state,
    localeInfo: this.localeInfo,
    fiatCode: this.fiatCode,
    cryptoCode: cryptoCode,
    cassettes: this.uiCassettes,
    coins: this.trader.coins,
    twoWayMode: this.twoWayMode(),
    rates,
    version,
    operatorInfo: this.trader.operatorInfo,
    cryptomatModel,
    areThereAvailablePromoCodes: this.trader.areThereAvailablePromoCodes,
    supportedCoins: this.mapCryptoUnitsDisplay(this.trader.coins),
    screenOpts: this.trader.machineScreenOpts
  }

  this.browser().send(fullRec)
}

Brain.prototype._processRequest = function _processRequest (req) {
  if (this.areYouSureHandled(req.button)) {
    return this.areYouSure()
  }

  if (_.includes(req.button, ARE_YOU_SURE_ACTIONS)) {
    return this._processAreYouSure(req)
  }

  if (this.flow) {
    return this.flow.handle(req.button, req.data)
  }

  this._processReal(req)
}

Brain.prototype._processAreYouSure = function _processAreYouSure (req) {
  switch (req.button) {
    case 'continueTransaction':
      this.continueTransaction(req.data)
      break
    case 'cancelTransaction':
      this.cancelTransaction(req.data)
      break
  }
}

/**
 * 處理使用者介面上各種按鈕的點擊事件
 * 
 * @param {Object} req - 包含按鈕事件資訊的物件
 * @param {string} req.button - 被點擊的按鈕名稱
 * @param {Object} req.data - 按鈕可能帶的資料
 *
 * 舉例來說:
 * 1. 當使用者點擊 "start" 按鈕時,
 *    會呼叫 _chooseCoin() 讓使用者選擇要用哪種加密貨幣
 * 
 * 2. 當使用者點擊 "cancelIdScan" 按鈕時,
 *    會呼叫 _cancelIdScan() 取消正在進行的身分證掃描
 */


Brain.prototype._processReal = function _processReal (req) {
  const maker = deviceConfig.cryptomatMaker || 'lamassu'
  const model = deviceConfig.cryptomatModel || 'sintra'

  switch (req.button) {
    // 初始化機器
    case 'initialize':
      this.initialize()
      break
    // 開始配對掃描
    case 'pairingScan':
      this._pairingScan()
      break
    // 取消配對掃描
    case 'pairingScanCancel':
      this.scanner.cancel()
      break
    // 處理配對錯誤
    case 'pairingErrorOk':
      this._unpaired()
      break
    // 讓使用者選擇要使用的加密貨幣
    case 'start':
      this._chooseCoin(req.data)
      break
    // 取消身分證資料掃描
    case 'idDataActionCancel':
      this._scanActionCancel(idCardData)
      break
    // 取消身分證照片掃描
    case 'idPhotoActionCancel':
      this._scanActionCancel(idCardPhoto)
      break
    // 取消整個身分證掃描流程
    case 'cancelIdScan':
      this._cancelIdScan()
      break
    // 取消美國社會安全號碼驗證，回到閒置狀態
    case 'cancelUsSsn':
      this.failedCompliance = 'usSsn'
      this.failedComplianceValue = this.requirementAmountTriggered[this.failedCompliance]

      if (this.returnState && !_.includes(this.complianceReason, ARE_YOU_SURE_HANDLED_SMS_COMPLIANCE)) {
        return this.authFlowHandleReturnState()
      }

      this._idle()
      break
    // 重試身分證號碼掃描
    case 'idCodeFailedRetry':
      idCardData.start()
      break
    // 確認身分驗證失敗
    case 'idVerificationFailedOk':
      idCardData.dispatch('FAIL')
      break
    // 取消照片掃描驗證
    case 'photoScanVerificationCancel':
      idCardPhoto.dispatch('FAIL')
      break
    // 取消掃描
    case 'cancelScan':
      this._cancelScan()
      break
    // 結束交易，回到初始畫面
    case 'bye':
      this._bye()
      break
    // 重試照片掃描，可能包含手動模式
    case 'retryPhotoScan':
      idCardPhoto.start({
        manual: (maker === 'lamassu' && model === 'sintra') || maker === 'coincloud'
      })
      break
    // 列印法幣收據
    case 'fiatReceipt':
      this._fiatReceipt()
      break
    // 取消插入紙鈔
    case 'cancelInsertBill':
      this._cancelInsertBill()
      break
    // 發送加密貨幣
    case 'sendCoins':
      this._sendCoins()
      break
    // 簡訊驗證前點擊完成按鈕
    case 'finishBeforeSms':
      this.finishBeforeSms()
      break
    // 交易完成
    case 'completed':
      this._completed()
      break
    // 進入機器選單
    case 'machine':
      this._machine()
      break
    // 取消機器選單
    case 'cancelMachine':
      this._cancelMachine()
      break
    // 中止交易
    case 'abortTransaction':
      this._abortTransaction()
      break
    // 取消選擇法幣
    case 'chooseFiatCancel':
      this._chooseFiatCancel()
      break
    // 法幣選擇按鈕
    case 'fiatButton':
      this._fiatButton(req.data)
      break
    // 清除法幣選擇
    case 'clearFiat':
      this._clearFiat()
      break
    // 存款超時
    case 'depositTimeout':
      this._depositTimeout()
      break
    // 存款超時但未發送交易
    case 'depositTimeoutNotSent':
      this.depositTimeoutNotSent()
      break
    // 現金提款
    case 'cashOut':
      this._cashOut()
      break
    // 兌換票券
    case 'redeem':
      this._redeem()
      break
    // 變更語言
    case 'changeLanguage':
      this._timedState('changeLanguage')
      break
    // 設定區域語系
    case 'setLocale':
      this._setLocale(req.data)
      break
    // 進入閒置狀態
    case 'idle':
      this._idle()
      break
    // 重新選擇加密貨幣
    case 'chooseCoin':
      this._chooseCoin(req.data)
      break
    // 重試人臉照片掃描
    case 'retryFacephoto':
      this.retryFacephoto()
      break
    // 開始掃描身分證照片
    case 'scanIdCardPhoto':
      idCardPhoto.dispatch('READY_TO_SCAN')
      break
    // 使用者同意身分驗證
    case 'permissionIdCompliance':
      this.permissionsGiven.id = true
      this._continueAuthCompliance()
      break
    // 使用者同意簡訊驗證
    case 'permissionSmsCompliance':
      this.permissionsGiven.sms = true
      this._continueAuthCompliance()
      break
    // 使用者同意電子郵件驗證
    case 'permissionEmailCompliance':
      this.permissionsGiven.email = true
      this._continueAuthCompliance()
      break
    // 使用者同意照片驗證
    case 'permissionPhotoCompliance':
      this.permissionsGiven.photo = true
      this._continueAuthCompliance()
      break
    // 使用者同意美國社會安全號碼驗證
    case 'permissionUsSsnCompliance':
      this.permissionsGiven.usSsn = true
      this._continueAuthCompliance()
      break
    // 使用者同意外部驗證
    case 'permissionExternalCompliance':
      this.permissionsGiven.external = true
      this._continueAuthCompliance()
      break
    // 受限制的客戶確認訊息
    case 'blockedCustomerOk':
      this._idle()
      break
    // 使用者接受條款
    case 'termsAccepted':
      this.acceptTerms()
      break
    // 嘗試重新輸入地址
    case 'invalidAddressTryAgain':
      this._startAddressScan()
      break
    // 重新列印錢包
    case 'printAgain':
      this._privateWalletPrinting()
      break
    // 重新掃描列印的錢包
    case 'printerScanAgain':
      this._startPrintedWalletScan()
      break
    // 註冊美國社會安全號碼
    case 'usSsn':
      this.registerUsSsn(req.data)
      break
    // 插入促銷碼
    case 'insertPromoCode':
      this._insertPromoCode()
      break
    // 取消促銷碼輸入
    case 'cancelPromoCode':
      this._cancelPromoCode()
      break
    // 提交促銷碼
    case 'submitPromoCode':
      this._submitPromoCode(req.data)
      break
    // 使用者同意客製化資訊請求
    case 'permissionCustomInfoRequest':
      this.permissionsGiven[this.customInfoRequestId] = true
      this._continueAuthCompliance()
      break
    // 取消客製化資訊請求
    case 'cancelCustomInfoRequest':
      this.failedCompliance = this.customInfoRequestId
      this.failedComplianceValue = this.requirementAmountTriggered[this.failedCompliance]

      if (this.returnState && !_.includes(this.complianceReason, ARE_YOU_SURE_HANDLED_SMS_COMPLIANCE)) {
        return this.authFlowHandleReturnState()
      }
      this._idle()
      break
    // 提交客製化資訊請求
    case 'customInfoRequestSubmit':
      return this.registerCustomInfoRequestData(req.data)
    // 發送簡訊收據
    case 'sendSmsReceipt':
      this._sendSmsReceipt()
      break
    // 列印收據
    case 'printReceipt':
      this._startPrintReceipt()
      break
    // 現金回收機繼續
    case 'recyclerContinue':
      this.recyclerContinue()
      break
    // 維護模式重新啟動
    case 'maintenanceRestart':
      this._restartServices('Maintenance restart', true)
      break
    // 現金插槽內的紙鈔被移除
    case 'cashSlotBillsRemoved':
      this.billValidator.cashSlotBillsRemoved()
      break
    // 剩餘紙鈔被移除
    case 'leftoverBillsRemoved':
      this._leftoverBillsRemoved()
      break
    // 顯示匯率畫面
    case 'ratesScreen':
      this.ratesScreen()
      break
    default:
      break
  }

}

Brain.prototype.finishBeforeSms = function () {
  if (this.tx.direction === 'cashOut') return this._idle()
  if (this.tx.fiat.gt(0)) return this._sendCoins()
  return this._idle()
}

Brain.prototype._continueAuthCompliance = function () {
  if (this.tx.direction === 'cashOut' || !this.tx.toAddress) {
    return this.authCompliance({ returnState: this.returnState })
  }

  const returnState = this.billValidatorHasShutter()
    ? this.tx.fiat.eq(0)
      ? 'acceptingFirstRecyclerBills'
      : 'acceptingRecyclerBills'
    : this.tx.fiat.eq(0)
      ? 'acceptingFirstBill'
      : 'acceptingBills'
  this.authCompliance({ returnState })
}

Brain.prototype._setState = function _setState (state, oldState) {
  if (this.state === state) return false

  if (oldState) this._assertState(oldState)

  if (this.currentScreenTimeout) {
    clearTimeout(this.currentScreenTimeout)
    this.currentScreenTimeout = null
  }

  // Starting a transaction
  if (this.isIdleState()) this.trader.setConfigVersion()

  this.state = state

  this.emit(state)
  this.emit('newState', state)
  if (this.trader) this.trader.stateChange(state, this.isIdleState())

  return true
}

Brain.prototype._unpaired = function _unpaired () {
  this._setState('unpaired')
  this.browser().send({ action: 'unpaired', version })
  db.clean(this.dbRoot)
}

Brain.prototype._pairingScan = function _pairingScan () {
  this._setState('pairingScan')
  this.browser().send({ action: 'pairingScan' })

  this.scanner.scanQR((err, totem) => {
    if (err) return this._pairingError(err)
    if (!totem) return this.initTrader()

    this._pair(totem)
  })
}

Brain.prototype.activate = function activate () {
  const connectionInfo = pairing.connectionInfo(this.connectionInfoPath)

  this._transitionState('booting')

  this.trader = require('./trader')(this.clientCert, connectionInfo, this.dataPath, deviceConfig.cryptomatModel)

  this.idVerify = require('./compliance/id_verify').factory({ trader: this.trader })

  this._initTraderEvents()

  return this.traderRun()
    .then(() => this.initNetworkMeasurements())
    .then(() => this.initValidator())
}

Brain.prototype._pair = function _pair (totem) {
  const self = this
  this._transitionState('pairing')

  return pairing.pair(totem, this.clientCert, this.connectionInfoPath, this.numberOfCassettes, this.numberOfRecyclers)
    .then(() => this.activate())
    .catch(err => {
      console.log(err.stack)
      self._pairingError(err)
    })
}

Brain.prototype._pairingError = function _pairingError (err) {
  this._setState('pairingError')
  this.browser().send({ action: 'pairingError', err: err.message })
}

function buildUiCassettes (units, virtualUnits) {
  const result = _.cloneDeep(units)

  _.each(it => result.push({denomination: it, count: null}), virtualUnits)
  return _.sortBy(el => parseInt(el.denomination, 10), result)
}

Brain.prototype._isPendingScreen = function _isPendingScreen () {
  return _.includes(this.state, ['goodbye'])
}

Brain.prototype.initTrader = function initTrader () {
  const connectionInfo = pairing.connectionInfo(this.connectionInfoPath)
  const config = this.rootConfig

  if (!connectionInfo && !config.mockTrader) {
    this._unpaired()
    return false
  }

  this.activate()

  return true
}

Brain.prototype.initValidator = function initValidator () {
  console.log('Waiting for server...')
  const h = setInterval(() => {
    if (_.isNil(this.fiatCode)) return

    clearInterval(h)

    this.billValidator.setFiatCode(this.fiatCode)

    // If the validator is the cash recycler, populate it with cassette information if available
    return this.billValidator.run(
      err => {
        if (err) return this._billValidatorErr(err)
        console.log('Bill validator connected.')
      },
      {
        numberOfCashboxes: this.rootConfig.billValidator.cashboxes ?? 1,
        cassettes: this.trader.cassettes,
        recyclers: this.trader.recyclers,
      }
    )
  }, 200)
}

Brain.prototype._idle = function _idle (locale) {
  const self = this
  const delay = transitionTime
    ? MIN_SCREEN_TIME - (Date.now() - transitionTime)
    : 0

  if (delay > 0 && self._isPendingScreen()) {
    setTimeout(function () { self._idle(locale) }, delay)
    return
  }

  emit('ledsOff')

  if (this.billValidator.leftoverBillsInCashSlot) return this._leftoverBillsInCashSlot()
  this.disableBillValidator()

  if (this.networkDown) return this._forceNetworkDown()

  /*
   * TODO: Once we move to the GraphQL poller: There's a way to manually force
   * a query to run even when using automatic polling.
   */
  const pollPromise = this.trader.poll()
  this.idVerify.reset()
  this.tx = Tx.newTx()
  this.pk = null
  this.bills = null
  this.lastRejectedBillsFiat = BN(0)
  this.failedCompliance = null
  this.failedComplianceValue = null
  this.redeem = false
  this.returnState = null
  this.complianceReason = null
  this.flow = null
  this.permissionsGiven = {}
  this.requirementAmountTriggered = {}
  this.suspendTriggerId = null

  /**
   * Clear any data from previously
   * validated customers (id & dailyVolume)
   */
  this.customer = null
  this.externalComplianceRetry = false
  this.customerTxHistory = []
  this.txBlockedByTrigger = false
  facephoto.cleanTCData()

  this._setState('pendingIdle')

  // We've got our first contact with server

  const localeInfo = _.cloneDeep(this.localeInfo)
  locale = locale || localeInfo.primaryLocale
  localeInfo.primaryLocale = locale

  this.localeInfo = localeInfo

  this.trader.clearConfigVersion()
  this.trader.cancelDispense()
  this.scanner.cancel()

  this.tx = Tx.update(this.tx, { fiatCode: this.fiatCode })

  pollPromise
    .then(() => this._idleByMode(this.localeInfo))
    .catch(console.log)
}

Brain.prototype._idleByMode = function _idleByMode (localeInfo) {
  if (this.twoWayMode()) {
    this._idleTwoWay(localeInfo)
  } else {
    this._idleOneWay(localeInfo)
  }
}

Brain.prototype.singleCrypto = function singleCrypto () {
  return this.trader.coins.length === 1
}

Brain.prototype.twoWayMode = function twoWayMode () {
  return (!this.isCashRecycler() || !this.billValidatorErrorFlag)
    && this.trader.twoWayMode
}

/**
 * Check if the customer is suspended
 *
 * That happens if the customer has reached
 * one of the enabled compliance tier thresholds
 *
 * @name isSuspended
 * @function
 *
 * @param {object} customer Acting customer
 * @param {date} now Current date
 * @returns {bool} Whether customer is suspended or not
 */
Brain.prototype.isSuspended = function isSuspended (customer, now) {
  return customer && customer.suspendedUntil && new Date(customer.suspendedUntil) > now
}

/**
 * Display the suspended screens for customer
 * If the customer hasn't inserted bills yet,
 * the suspendedCustomer screen will displayed with ok button,
 * else the bill screen will be displayed with the relative error message
 *
 * @name showSuspendedCustomer
 * @function
 *
 * @param {object} customer Acting customer
 * @param {date} now Current date
 *
 */
Brain.prototype.showSuspendedCustomer = function showSuspendedCustomer (customer, now) {
  const data = this.getHardLimitReachedData(customer, now)

  /*
   * When doing cashOut just show the hardLimitReached screen
   */
  if (this.tx.direction === 'cashOut') {
    return this._timedState('hardLimitReached', { data })
  }

  /*
   * Current transaction's fiat not including current bill
   */

  const insertedBills = this.tx.fiat.gt(0)
  if (!insertedBills) {
    return this._timedState('hardLimitReached', { data })
  }

  /*
   * Set acceptingBills first as transition (in updateBillsScreen) so that sendOnly
   * reason message would be displayed on that screen
   */
  this.updateBillsScreen(true)
    .then(() => {
      this.browser().send({
        sendOnly: true,
        reason: 'blockedCustomer',
        cryptoCode: this.tx.cryptoCode
      })
    })
}

/*
* 這個函式會計算使用者被停權的剩餘時間
* 
* 舉例來說:
* 如果使用者被停權到 2024/1/1
* 現在是 2023/12/1
* 那就會計算出還剩下幾週、幾天、幾小時
*
* 參數說明:
* @param customer: 使用者的資料，裡面會有 suspendedUntil 欄位記錄停權到期時間
* @param now: 現在的時間
*
* 回傳值說明:
* 會回傳一個物件，裡面包含:
* - hardLimitWeeks: 剩餘週數
* - hardLimitDays: 剩餘天數(扣除週數後) 
* - hardLimitHours: 剩餘小時數(扣除週數和天數後)
*/
Brain.prototype.getHardLimitReachedData = function getHardLimitReachedData (customer, now) {
  const diff = new Date(customer.suspendedUntil).valueOf() - now.valueOf()

  const diffInWeeks = _.floor(diff / 1000 / 60 / 60 / 24 / 7)
  const diffInDays = _.floor((diff / 1000 / 60 / 60 / 24) - (diffInWeeks * 7))
  const diffInHours = _.ceil((diff / 1000 / 60 / 60) - (diffInDays * 24) - (diffInWeeks * 7))

  return {
    hardLimit: {
      hardLimitWeeks: diffInWeeks,
      hardLimitDays: diffInDays,
      hardLimitHours: diffInHours
    }
  }
}

/**
 * Check if the customer is blocked
 *
 * That happens if the customer has reached
 * one of the enabled compliance tier thresholds
 * and has the relevant override status to blocked
 *
 * @name isBlocked
 * @function
 *
 * @param {object} customer Acting customer
 * @returns {boolean} Whether customer is blocked or not
 */
Brain.prototype.isBlocked = function isBlocked (customer) {
  return customer.authorizedOverride === 'blocked'
}

/**
 * Display the blocked screens for customer
 * If the customer hasn't inserted bills yet,
 * the blockedCustomer screen will displayed with ok button,
 * else the bill screen will be displayed with the relative error message
 *
 * @name showBlockedCustomer
 * @function
 *
 */
Brain.prototype.showBlockedCustomer = function showBlockedCustomer () {
  /*
   * When doing cashOut just show the blockCustomer screen
   */
  if (this.tx.direction === 'cashOut') {
    return this._transitionState('blockedCustomer')
  }

  /*
   * Current transaction's fiat not including current bill
   */

  const insertedBills = this.tx.fiat.gt(0)
  if (!insertedBills) {
    return this._transitionState('blockedCustomer', { insertedBills })
  }

  /*
   * Set acceptingBills first as transition (in updateBillsScreen) so that sendOnly
   * reason message would be displayed on that screen
   */
  this.updateBillsScreen(true)
    .then(() => {
      this.browser().send({
        sendOnly: true,
        reason: 'blockedCustomer',
        cryptoCode: this.tx.cryptoCode
      })
    })
}

Brain.prototype.showExternalCompliance = function showExternalCompliance (url) {
  if (this.tx.direction === 'cashOut') {
    this._transitionState('externalCompliance', { externalComplianceUrl: url })
    return this._screenTimeout(() => this.finishBeforeSms(), EXTERNAL_VALIDTION_TIMEOUT)
  }

  const insertedBills = this.tx.fiat.gt(0)
  if (!insertedBills) {
    this._transitionState('externalCompliance', { externalComplianceUrl: url })
    return this._screenTimeout(() => this.finishBeforeSms(), EXTERNAL_VALIDTION_TIMEOUT)
  }

  this._transitionState('externalCompliance', {
    tx: this.tx,
    sendOnly: true,
    cryptoCode: this.tx.cryptoCode,
    externalComplianceUrl: url
  })
  return this._screenTimeout(() => this.finishBeforeSms(), EXTERNAL_VALIDTION_TIMEOUT)
}

Brain.prototype._isCustomerAuthenticated = function _isCustomerAuthenticated () {
  const customerAuthentication = this.trader.customerAuthentication
  const isEmailAuth = customerAuthentication === CUSTOMER_AUTHENTICATION.EMAIL

  return (!isEmailAuth && this.tx.phone) || (isEmailAuth && this.tx.email)
}

Brain.prototype.authCompliance = function authCompliance (opts = {}) {
  this.returnState = opts.returnState
  this.complianceReason = opts.reason
  const customerAuthentication = this.trader.customerAuthentication
  const isEmailAuth = customerAuthentication === CUSTOMER_AUTHENTICATION.EMAIL

  /**
   * If the phone or email is already verified
   * proceed with the next compliance tier
   */
  if (this._isCustomerAuthenticated()) {
    return this.authFlowHandleReturnState()
  }

  const flowHandler = isEmailAuth ? email : sms

  const flow = new flowHandler.Flow({ noCode: opts.noCode })
  this.flow = flow

  flow.on('screen', rec => {
    this._transitionState(rec.screen, { context: 'compliance' })
  })

  flow.on('idle', () => {
    this._idle()
  })

  flow.on('sendCode', data => {
    const dataField = isEmailAuth ? data.email : data.phone
    const promise = isEmailAuth ? this.trader.emailCode(dataField) : this.trader.phoneCode(dataField)
    promise.then(result => {
        this.customer = result.customer
        this.txBlockedByTrigger = false

        this.customerTxHistory = result.customer.txHistory.filter(it => it.id !== this.tx.id)

        this.tx = Tx.update(this.tx, { customerId: result.customer.id })

        /*
         * Check to see if customer is blocked
         * and show the relevant screen
         */
        if (this.isBlocked(this.customer)) {
          this.flow = null
          return this.showBlockedCustomer()
        }
        const now = new Date()

        /*
         * Check to see if customer is suspended
         * and show the relevant screen
         */
        if (this.isSuspended(this.customer, now)) {
          this.flow = null
          return this.showSuspendedCustomer(this.customer, now)
        }

        /*
         * Check to see if customer has individual discounts assigned
         * and apply them
         */
        this.verifyCustomerDiscounts(this.customer.discount, 'individualDiscount')

        const isCoincloud = this.rootConfig.cryptomatMaker === 'coincloud'
        return flow.handle('requiredSecurityCode', result.code, isCoincloud)
      })
      .catch(err => {
        if (err.name === 'BadNumberError') {
          return flow.handle('badPhoneNumber')
        }

        /**
         * In case of API error throw
         */
        if (err.statusCode === 500) {
          throw err
        }

        /**
         * In case the returnState is acceptingBills,
         * display the acceptingBills screen with
         * networkDown reason and sendOnly flag to true
         * instead of a networkDown screen before user
         * returns to acceptingBills
         *
         * If returnState is not  acceptingBills this flag
         * will be ignored. Brain will handle the networkDown
         *
         */
        this.networkDown = true
        this.authFlowHandleReturnState()
      })
      .catch(err => {
        this.flow = null
        this._fiatError(err)
      })
  })

  flow.on('success', () => {
    const data = isEmailAuth ? flow.email : flow.phone
    const dataObj = isEmailAuth ? { email: data } : { phone: data }
    this.flow = null

    let txPromise
    if (this.redeem) {
      txPromise = isEmailAuth ? this.trader.fetchEmailTx(data) : this.trader.fetchPhoneTx(data)
    } else {
      txPromise = Promise.resolve(Tx.update(this.tx, dataObj))
    }

    return txPromise
      .then(tx => {
        this.tx = tx
        return this.authFlowHandleReturnState()
      })
      .catch(err => {
        if (err.statusCode === 404) {
          return this._timedState('unknownPhoneNumber')
        }

        if (err.statusCode === 411) {
        // Transaction not seen on the blockchain
          this.tx = null
          return this._timedState('txNotSeen')
        }

        if (err.statusCode === 412) {
        // There are unconfirmed transactions
          this.tx = null
          return this._timedState('unconfirmedDeposit')
        }

        this._fiatError(err)
        throw err
      })
  })

  flow.on('fail', () => {
    this.flow = null
    this.failedCompliance = isEmailAuth ? 'email' : 'sms'
    this.failedComplianceValue = this.requirementAmountTriggered[this.failedCompliance]

    if (this.returnState && !_.includes(this.complianceReason, ARE_YOU_SURE_HANDLED_SMS_COMPLIANCE)) {
      return this.authFlowHandleReturnState()
    }

    this._idle()
  })

  flow.handle('start')
}

Brain.prototype.isManualTier = function isManualTier (tier) {
  return _.get(tier, this.trader.triggersAutomation) === TRIGGER_AUTOMATION.MANUAL
}

Brain.prototype.validateTier = function validateTier (tier, triggerTx, customerTier, requiredTiers) {
  const requiredManualTiers = _.filter(this.isManualTier.bind(this), requiredTiers)
  const scannedManualTiers = _.filter(tier => _.get(tier, this.manualTriggersDataProvided), requiredManualTiers)

  // If the tier is not manual, allow pending values
  if (!_.includes(tier, requiredManualTiers)) return !_.isEmpty(customerTier)

  // If the tier is manual, block pending
  this.txBlockedByTrigger = true
  return !_.isEmpty(customerTier) || _.includes(tier, scannedManualTiers)
}

Brain.prototype.setManualTrigger = function setManualTrigger (code) {
  if (this.isManualTier(code)) {
    this.manualTriggersDataProvided[code] = true
  }
}

/*
* 這個函式用來檢查使用者是否符合特定的身份驗證要求
*
* 主要功能:
* 1. 根據不同的驗證類型(tier)來檢查使用者是否通過驗證
* 2. 每種驗證類型都有自己的檢查邏輯
*
* 參數說明:
* @param tier: 要檢查的驗證類型，例如:
*   - sms: 簡訊驗證
*   - email: 電子郵件驗證
*   - idCardData: 身分證資料
*   - idCardPhoto: 身分證照片
*   - facephoto: 臉部照片
*   等等...
* @param triggerTx: 目前的交易資訊
* @param requiredTiers: 所有需要的驗證類型
* @param trigger: 觸發這個驗證的規則
*
* 回傳值說明:
* 回傳 true 或 false
* - true: 代表使用者通過這個驗證
* - false: 代表使用者沒通過這個驗證
*
* 重要變數說明:
* - tx: 目前的交易資訊
* - customer: 使用者的資料
* - tierOrCustom: 判斷是一般驗證還是客製化驗證
*
* 使用範例:
* 如果要檢查使用者是否通過簡訊驗證:
* isTierCompliant('sms', tx, ['sms', 'email'], trigger)
* 會回傳 true 或 false
*/

Brain.prototype.isTierCompliant = function isTierCompliant (tier, triggerTx, requiredTiers, trigger) {
  const tx = this.tx
  const customer = this.customer || {}

  // custom requests have uuid
  const tierOrCustom = uuid4Validate(tier) ? 'custom' : tier

  switch (tierOrCustom) {
    case 'sms': // 檢查簡訊驗證 - 確認是否有電話號碼
      return !_.isNil(tx.phone)
    case 'email': // 檢查電子郵件驗證 - 確認是否有email
      return !_.isNil(tx.email)
    case 'idCardData': // 檢查身分證資料
      if (customer.idCardDataOverride === 'verified') return true // 如果已被手動標記為已驗證就通過
      if (customer.idCardDataOverride === 'blocked') return false // 如果已被手動標記為封鎖就不通過
      return this.validateTier(tier, triggerTx, customer.idCardData, requiredTiers)
    case 'idCardPhoto': // 檢查身分證照片
      if (customer.idCardPhotoOverride === 'verified') return true
      if (customer.idCardPhotoOverride === 'blocked') return false
      return this.validateTier(tier, triggerTx, customer.idCardPhotoPath, requiredTiers)
    case 'sanctions': // 檢查制裁名單
      return customer.sanctions
    case 'facephoto': // 檢查臉部照片
      if (customer.frontCameraOverride === 'verified') return true
      if (customer.frontCameraOverride === 'blocked') return false
      return this.validateTier(tier, triggerTx, customer.frontCameraPath, requiredTiers)
    case 'usSsn': // 檢查美國社會安全號碼
      if (customer.usSsnOverride === 'verified') return true
      if (customer.usSsnOverride === 'blocked') return false
      return this.validateTier(tier, triggerTx, customer.usSsn, requiredTiers)
    case 'block': // 封鎖狀態 - 直接回傳 false
    case 'suspend': // 停權狀態 - 直接回傳 false
      return false
    case 'custom': // 檢查客製化驗證
      const customInfoRequestId = tier
      const customerData = _.find(['info_request_id', customInfoRequestId])(customer.customInfoRequestData)

      if (_.isNil(customerData)) return false // 如果沒有客製化資料就不通過
      if (customerData.override === 'verified') return true // 如果已被手動標記為已驗證就通過
      if (customerData.override === 'blocked') return false // 如果已被手動標記為封鎖就不通過
      return this.validateTier(customInfoRequestId, triggerTx, customerData.customer_data, requiredTiers)
    case 'external': // 檢查外部驗證服務
      if (_.isNil(customer.externalCompliance) || _.isEmpty(customer.externalCompliance)) return false
      const complianceResult = customer.externalCompliance
      const service = trigger.externalService

      switch (complianceResult[service]?.answer) {
        case 'APPROVED': // 如果外部服務核准就通過
          return true
        case 'REJECTED': // 如果被拒絕或等待中
        case 'PENDING':
          // currently has same flow as manual trigger
          this.txBlockedByTrigger = true // 設定交易被觸發器阻擋
          // return true after setting block flag to get out of the compliance loop
          return true
        case 'RETRY': // 如果需要重試
        default:
          this.externalComplianceRetry = true // 設定需要重試外部驗證
          return false
      }
    default: // 不支援的驗證類型就拋出錯誤
      throw new Error(`Unsupported tier: ${tier}`)
  }
}

Brain.prototype.minimumFiat = function minimumFiat () {
  const cassette = _.head(this.trader.cassettes)
  const recycler = _.head(this.trader.recyclers)
  return Math.max(cassette?.denomination ?? 0, recycler?.denomination ?? 0)
}

/*
* 這個函式是用來處理身份驗證流程結束後的狀態
* 
* 主要功能:
* 1. 先檢查是否要顯示簡訊收據和自動列印的選項
* 2. 如果是兌換交易(redeem)就直接發錢
* 3. 如果不是兌換交易,就要檢查:
*   - 交易金額是否符合法規限制
*   - 使用者是否被封鎖或停權
*   - 是否需要進行其他身份驗證
* 4. 最後根據檢查結果決定下一步:
*   - 如果需要更多驗證就繼續驗證流程
*   - 如果使用者被封鎖就顯示封鎖訊息
*   - 如果使用者被停權就顯示停權訊息
*   - 如果都沒問題就可以繼續交易
*
* @param 無參數
* @returns 無回傳值,但會觸發不同的畫面狀態
*/

Brain.prototype.authFlowHandleReturnState = function authFlowHandleReturnState () {
  /*
   * 發送簡訊收據狀態和自動列印設定給瀏覽器
   */
  this.browser().send({
    smsReceiptStatus: this.trader.smsReceiptActive ? 'available' : 'disabled',
    automaticPrint: this.isAutomaticPrintActive()
  })

  /**
   * 如果是兌換交易就直接發錢,不需要檢查合規性
   * 因為交易已經檢查過了
   */
  if (this.redeem) {
    return this._dispenseUpdate(this.tx)
  }

  const returnState = this.returnState
  const tx = this.tx

  /*
   * 計算需要檢查合規性的金額
   * 並建立觸發交易物件
   */
  const amount = this.complianceAmount()
  const triggerTx = { fiat: amount, direction: tx.direction }

  /*
   * 檢查是否有不合規的層級
   */
  const nonCompliantTiers = this.nonCompliantTiers(this.trader.triggers, this.customerTxHistory, triggerTx)
  const isCompliant = _.isEmpty(nonCompliantTiers)
  const otherTiers = _.isNil(this.failedCompliance) && !isCompliant

  /**
   * 如果還有其他合規層級需要檢查,就繼續執行合規檢查
   */
  if (otherTiers) {
    return this.runComplianceTiers(nonCompliantTiers)
  }

  /*
   * 如果交易被觸發器阻擋,就顯示被封鎖的訊息
   */
  if (this.txBlockedByTrigger) {
    this.txBlockedByTrigger = false
    return this.showBlockedCustomer()
  }

  const isStartOfTx = BN(0).eq(this.tx.fiat)
  const now = new Date()

  /*
   * 如果是交易開始且使用者被停權,就顯示停權訊息
   */
  if (isStartOfTx && this.isSuspended(this.customer, now)) {
    const data = this.getHardLimitReachedData(this.customer, now)

    return this._timedState('hardLimitReached', { data })
  }

  /*
   * 如果沒有返回狀態
   */
  if (!returnState) {
    /**
     * 如果是提款且合規,就回到開始畫面繼續提款流程
     */
    if (tx.direction === 'cashOut' && isCompliant) {
      return this.startScreen()
    }

    /**
     * 如果是存款且合規,就回到開始畫面繼續存款流程
     */
    if (tx.direction === 'cashIn' && isCompliant) {
      return this.startScreen()
    }

    return this._idle()
  }

  /*
   * 如果返回狀態是接受鈔票的狀態,就啟用鈔票驗證器
   */
  if (_.includes(returnState, BILL_ACCEPTING_STATES)) {
    this.enableBillValidator()
  }

  /**
   * 只有在簡訊流程前的狀態是接受第一張鈔票,且簡訊流程失敗時
   * 才回到閒置狀態
   * 如果簡訊註冊成功,就讓使用者插入第一張鈔票
   */
  if ((returnState === 'acceptingFirstBill' || returnState === 'acceptingFirstRecyclerBills') && !isCompliant) {
    return this._idle()
  }

  if ((returnState === 'acceptingFirstBill' || returnState === 'acceptingFirstRecyclerBills') && isCompliant) {
    this._transitionState(returnState)
    return this._screenTimeout(() => this._idle(), BILL_TIMEOUT)
  }

  /*
   * 處理選擇金額狀態
   */
  if (returnState === 'chooseFiat') {
    const isEmailAuth = this.trader.customerAuthentication === CUSTOMER_AUTHENTICATION.EMAIL
    const complianceData = isEmailAuth ? tx.email : tx.phone
    const failedZeroConf = this.exceedsZeroConf(tx) && _.isNil(complianceData)
    const failedRegistration = failedZeroConf || !isCompliant

    if (failedRegistration) return this._idle()

    // 電話驗證成功,進入存款流程
    return this.toDeposit()
  }

  /*
   * 處理接受鈔票狀態
   */
  if (returnState === 'acceptingBills' || returnState === 'acceptingFirstRecyclerBills') {
    /**
     * 如果在簡訊合規授權期間發生網路錯誤
     * 先回到接受鈔票狀態,然後呼叫 _networkDown()
     * 立即顯示網路錯誤原因,而不是顯示網路錯誤畫面
     */
    const hasFailedCompliance = !_.isNil(this.failedCompliance)

    this.updateBillsScreen(hasFailedCompliance)
    if (this.networkDown) this._networkDown()
    return
  }

  /*
   * 處理稍後兌換狀態
   */
  if (returnState === 'redeemLater') {
    return this._redeemLater()
  }

  /*
   * 處理接受鈔票狀態且合規的情況
   */
  if (_.includes(returnState, BILL_ACCEPTING_STATES) && isCompliant) {
    const cb = this.tx.fiat.eq(0)
      ? this._idle.bind(this)
      : this._sendCoins.bind(this)
    this._transitionState(returnState, { tx: this.tx })
    return this._screenTimeout(cb, BILL_TIMEOUT)
  }

  /*
   * 其他情況就轉換到返回狀態
   */
  this._transitionState(returnState)
}

/**
 * 計算每日交易量,需考慮合規限制
 * 在交易開始時,會將交易的最小金額加入每日交易量中
 *
 * @returns {BigNumber} 每日交易量
 */
Brain.prototype.complianceAmount = function complianceAmount () {
  // 取得目前交易資訊
  const tx = this.tx
  const amount = tx.fiat // 目前交易金額

  // 檢查是否為交易開始(還沒投入任何鈔票)
  const isStartOfTx = BN(0).eq(amount)

  // 如果是提款(cashOut)交易
  if (tx.direction === 'cashOut') {
    // 如果是交易開始,回傳最小提款金額
    // 否則回傳目前交易金額
    return isStartOfTx ? this.minimumFiat() : amount
  }

  // 取得上次被拒絕的鈔票金額
  const lastRejectedFiat = this.lastRejectedBillsFiat
  // 如果沒有被拒絕的鈔票,預設為0
  const lastRejectedBills = _.defaultTo(BN(0), lastRejectedFiat)

  // 如果是交易開始(存款交易)
  if (isStartOfTx) {
    // 取得該幣種的資訊
    const coin = _.find(['cryptoCode', tx.cryptoCode], this.trader.coins)

    // 計算每日交易量:
    // 1. 目前交易金額
    // 2. 加上 "最小交易金額對應的最小鈔票" 和 "上次被拒絕鈔票金額" 中較大的值
    // 因為這兩個都有可能是使用者接下來要投入的金額
    return amount.add(
      BigNumber.max(
        this.billValidator.lowestBill(coin.minimumTx), // 該幣種最小交易金額對應的最小鈔票
        lastRejectedBills // 上次被拒絕的鈔票金額
      )
    )
  }

  // 如果存款交易已經開始(有投入鈔票)
  // 計算每日交易量 = 目前交易金額 + 上次被拒絕的鈔票金額
  // 因為被拒絕的鈔票可能會再次投入
  return amount.add(lastRejectedBills)
}

/**
 * Handler to show in screen whether or not the user
 * is allowed to proceed inserting bills or forced to
 * click the send button.
 *
 * Two reasons provided:
 *
 *  1. Transaction limit
 *  2. Low balance
 *
 */
Brain.prototype.completeBillHandling = function completeBillHandling (blockedCustomer) {
  // Available cryptocurrency balance expressed in fiat
  const availableCryptoAsFiat = this.balance().sub(this.tx.fiat)
  const highestBill = this.billValidator.highestBill(availableCryptoAsFiat)
  const hasLowBalance = highestBill.lte(0)

  if (hasLowBalance || blockedCustomer) {
    this.disableBillValidator()
  }

  this.browser().send({
    credit: this._uiCredit(),
    sendOnly: hasLowBalance || blockedCustomer,
    reason: blockedCustomer ? 'blockedCustomer' : false,
    cryptoCode: this.tx.cryptoCode
  })
}

Brain.prototype.startScreen = function startScreen () {
  const direction = this.tx.direction

  // reset T&C accept button flag
  this.termsAcceptButtonPressed = false

  // check if terms screen is enabled
  // and user still need to accept terms
  if (this.mustAcceptTerms()) {
    if (this._tcPhotoEnabled() && this.hasFrontFacingCamera) {
      this.takeFacePhotoTC()
    }
    return this._transitionState('termsScreen')
  }

  if (direction === 'cashOut') return this._chooseFiat()
  if (direction === 'cashIn') return this._start()

  throw new Error(`No such direction ${direction}`)
}

Brain.prototype.mustAcceptTerms = function mustAcceptTerms () {
  return (
    // check if terms screen is enabled
    this._tcEnabled() &&
    // and user still need to accept terms
    !this.tx.termsAccepted
  )
}

Brain.prototype.acceptTerms = function acceptTerms () {
  this.scanner.cancel()
  // disable accept button after one click
  this.browser().send({ terms: _.assign(this.trader.terms, { acceptDisabled: true }) })
  if (!this.termsAcceptButtonPressed) {
  // timeout is a safety net to ensure that we close
  // the camera before opening it for another task
    setTimeout(() => {
      // mark terms as accepted
      // and redirect user to start screen
      this.tx = Tx.update(this.tx, { termsAccepted: true })
      this.startScreen()
    }, 1000)
  }
  // avoid setting multiple timeouts
  this.termsAcceptButtonPressed = true
}

function chooseBillDispenser (config) {
  const billDispenserConfig = config.billDispenser
  const billDispenser = billDispenserConfig.model
  const isMockedDispenser = config.mockBillDispenser

  if (isMockedDispenser) {
    switch (billDispenser) {
      case 'hcm2': return require('./mocks/hcm2/hcm2').factory(billDispenserConfig)
      case 'gsr50': return require('./mocks/gsr50/gsr50').factory(billDispenserConfig)
      default: return require('./mocks/billdispenser').factory(billDispenserConfig)
    }
  }

  switch (billDispenser) {
    case 'f56':
      return require('./f56/f56-dispenser').factory(billDispenserConfig)
    case 'hcm2':
      return require('./hcm2/hcm2').factory(billDispenserConfig)
    case 'gsr50':
      return require('./gsr50/gsr50').factory(billDispenserConfig)
    case 'genmega':
      return require('./genmega/genmega-dispenser/genmega-dispenser').factory(billDispenserConfig)
    default:
      // poloon might not be specified since we didn't check against it
      return require('./puloon/puloon-dispenser').factory(billDispenserConfig)
  }
}

Brain.prototype._idleTwoWay = function _idleTwoWay (localeInfo) {
  const cassettes = this.trader.cassettes
  const recyclers = this.trader.recyclers
  const originalCassettes = this.trader.originalCassettes
  const originalRecyclers = this.trader.originalRecyclers
  const virtualCassettes = this.trader.virtualCassettes
  const virtualRecyclers = this.trader.virtualRecyclers

  const units = [...cassettes, ...recyclers]
  const virtualUnits = [...virtualCassettes, ...virtualRecyclers]
  const uiCassettes = buildUiCassettes(units, virtualUnits)
  this.uiCassettes = uiCassettes

  if (!this.billDispenser) {
    this.billDispenser = chooseBillDispenser(this.rootConfig)
  }

  if (!this.billDispenser.initialized) this._transitionState('booting')
  if (this.billDispenser.initializing) return

  return this.billDispenser.init({
    cassettes,
    fiatCode: this.trader.locale.fiatCode,
    recyclers,
    originalCassettes,
    originalRecyclers
  })
    .then(() => this._chooseCoinScreen(localeInfo, uiCassettes))
    .catch(console.log)
}

Brain.prototype._idleOneWay = function _idleOneWay (localeInfo) {
  this._chooseCoinScreen(localeInfo)
}

Brain.prototype._chooseCoinScreen = function _chooseCoinsScreen (localeInfo, cassettes) {
  this._transitionState('chooseCoin', {
    localeInfo: localeInfo,
    cassettes: cassettes,
    coins: this.trader.coins,
    screenOpts: this.trader.machineScreenOpts,
    twoWayMode: this.twoWayMode(),
    supportedCoins: this.mapCryptoUnitsDisplay(this.trader.coins)
  })
}

Brain.prototype._chooseCoin = function _chooseCoin (data) {
  // Show networkDown screen now if it's been delayed
  if (this.networkDown) return this._forceNetworkDown()

  const automatableRequirements = _.keys(this.trader.triggersAutomation)
  this.manualTriggersDataProvided = _.zipObject(automatableRequirements, Array(automatableRequirements.length).fill(false))
  this.txBlockedByTrigger = false
  this.tx = Tx.update(this.tx, data)
  this.browser().send({ cryptoCode: data.cryptoCode })
  this.sendRates()
  this.startScreen()
}

Brain.prototype.isIdleState = function isIdleState () {
  return this.state === 'chooseCoin'
}

Brain.prototype._setLocale = function _setLocale (data) {
  const self = this
  this._idle(data.locale)
  this._screenTimeout(function () { self._idle() }, 30000)
}

Brain.prototype.isLowBalance = function isLowBalance () {
  const fiatBalance = this.balance()
  const highestBill = this.billValidator.highestBill(fiatBalance)

  return highestBill.lt(0)
}

/*
* 這個函式是用來取得使用者需要完成的身份驗證項目
*
* 主要功能:
* 1. 確認是用email還是簡訊驗證
* 2. 找出所有被觸發的驗證規則
* 3. 整理並排序這些驗證項目
*
* 參數說明:
* @param triggers: 所有可能的驗證規則
* @param history: 使用者的交易紀錄
* @param triggerTx: 目前的交易資訊
*
* 回傳值說明:
* 會回傳一個陣列,裡面包含所有需要驗證的項目,而且是照順序排好的
* 例如: ['email', 'idCheck', 'customCheck']
*
* 重要變數說明:
* - isEmailAuth: 判斷是否使用email驗證(true/false)
* - requiredAuth: 存放主要驗證方式(email或sms)
* - triggered: 存放所有被觸發的驗證規則
* - requirements: 存放所有不重複的驗證項目
*/

Brain.prototype.requiredTiers = function requiredTiers (triggers, history, triggerTx) {
  // 判斷是否使用 email 驗證,否則使用 SMS 驗證
  const isEmailAuth = this.trader.customerAuthentication === CUSTOMER_AUTHENTICATION.EMAIL
  const requiredAuth = isEmailAuth ? 'email' : 'sms'

  // 取得所有被觸發的驗證規則
  const triggered = getTriggered(triggers, history, triggerTx)
  // 格式化觸發的規則,如果是客製化驗證就把 customInfoRequestId 設為 requirement
  const triggeredFormatted = _.map(o => o.customInfoRequestId ? _.assign(o, { requirement: o.customInfoRequestId }) : o, triggered)
  // 取得停權天數最長的規則 ID
  const getHighestSuspend = _.compose(_.get('id'), _.maxBy('suspensionDays'), _.filter({ requirement: REQUIREMENTS.SUSPEND }))

  // 設定停權規則 ID 和所有觸發的規則
  this.suspendTriggerId = getHighestSuspend(triggeredFormatted)
  this.triggers = triggeredFormatted

  // 取得所有不重複的驗證項目
  const requirements = _.uniq(_.map(_.get('requirement'))(triggeredFormatted))
  // 如果有驗證項目就加上主要驗證方式(email/sms),否則回傳空陣列
  const unorderedTiers = _.isEmpty(requirements) ? [] : _.union(requirements, [requiredAuth])

  // 把主要驗證方式和預設順序合併
  const orderedWithRequired = [].concat(requiredAuth, ORDERED_REQUIREMENTS)
  // 根據順序排序驗證項目,客製化驗證放最後
  const requiredTiers = _.sortBy(name => {
    return _.indexOf(uuid4Validate(name) ? REQUIREMENTS.CUSTOM : name, orderedWithRequired)
  })(unorderedTiers)

  // 設定每個驗證項目觸發的最低金額門檻
  this.requirementAmountTriggered = getLowestAmountPerRequirement(triggeredFormatted)
  return requiredTiers
}

/*
* 這個函式是用來檢查使用者是否符合所有身份驗證的要求
*
* 主要功能:
* 1. 先取得所有需要驗證的項目(例如:簡訊驗證、身分證等)
* 2. 檢查每個項目使用者是否都有通過驗證
* 3. 回傳那些還沒通過驗證的項目
*
* 參數說明:
* @param triggers: 所有需要驗證的規則
* @param history: 使用者的交易紀錄
* @param triggerTx: 目前的交易資訊
*
* 回傳值說明:
* 會回傳一個陣列,裡面包含所有還沒通過驗證的項目
* 如果陣列是空的,代表使用者已經通過所有驗證
*/

Brain.prototype.nonCompliantTiers = function nonCompliantTiers (triggers, history, triggerTx) {
  // 取得所有需要驗證的項目
  const requiredTiers = this.requiredTiers(triggers, history, triggerTx)
  // 過濾出還沒通過驗證的項目
  return _.filter(tier => {
    // 找出這個驗證項目對應的觸發規則
    const trigger = _.find(['requirement', tier], triggers)
    // 檢查是否不符合這個驗證項目的要求
    return !this.isTierCompliant(tier, triggerTx, requiredTiers, trigger)
  }, requiredTiers)
}

Brain.prototype._start = function _start () {
  if (this.startDisabled) return
  if (this.isLowBalance()) return this._timedState('balanceLow')

  const cryptoCode = this.tx.cryptoCode
  const coin = _.find(['cryptoCode', cryptoCode], this.trader.coins)

  const updateRec = {
    direction: 'cashIn',
    cashInFee: coin.cashInFee,
    commissionPercentage: BN(coin.cashInCommission).div(100),
    rawTickerPrice: BN(coin.rates.ask),
    minimumTx: this.billValidator.lowestBill(coin.minimumTx),
    cryptoNetwork: coin.cryptoNetwork
  }

  const update = _.assignAll([this.tx, updateRec])
  this.tx = Tx.update(this.tx, update)

  const amount = this.complianceAmount()
  const triggerTx = { fiat: amount, direction: this.tx.direction }

  const nonCompliantTiers = this.nonCompliantTiers(this.trader.triggers, this.customerTxHistory, triggerTx)
  const isCompliant = _.isEmpty(nonCompliantTiers)

  if (!isCompliant) {
    return this.authCompliance()
  }

  const printPaperWallet = this.trader.enablePaperWalletOnly

  this.browser().send({
    tx: this.tx,
    receiptStatus: this.trader.receiptPrintingActive ? 'available' : 'disabled',
    smsReceiptStatus: this.trader.smsReceiptActive && this.customer ? 'available' : 'disabled',
    automaticPrint: this.isAutomaticPrintActive()
  })

  if (printPaperWallet) {
    try {
      // Only BTC, LTC and BCH supported for now
      if (!_.isNil(coinUtils.createWallet(this.tx.cryptoCode))) {
        return this._privateWalletPrinting()
      }
    } catch (err) {
      return this._idle()
    }
  }

  this._startAddressScan()
}

Brain.prototype._privateWalletPrinting = function _privateWalletPrinting () {
  this._transitionState('cashInWaiting')

  if (!this.printer) {
    console.log('[ERROR]: The kiosk printer was not loaded.')
    return this._timedState('printerError')
  }

  return this.printer.checkStatus(deviceConfig.kioskPrinter, STATUS_QUERY_TIMEOUT)
    .then((printerStatus) => {
      console.log('Kiosk printer status: ', printerStatus)
      if (printerStatus.hasErrors) throw new Error()

      const wallet = coinUtils.createWallet(this.tx.cryptoCode)
      const printerCfg = deviceConfig.kioskPrinter
      this.pk = wallet.privateKey
      return this.printer.printWallet(wallet, printerCfg, this.tx.cryptoCode)
        .then(() => {
          this.tx = Tx.update(this.tx, { isPaperWallet: true, toAddress: wallet.publicAddress })
          this._startPrintedWalletScan(this.tx.toAddress)
        })
    })
    .catch((err) => {
      console.log('[ERROR]: The kiosk printer is in an invalid state.', err)
      return this._timedState('printerError')
    })
}

Brain.prototype.failedQRScans = function failedQRScans (frames) {
  return this.shouldSaveQrAttempts ?
    this.trader.failedQRScans(frames) :
    Promise.resolve(null)
}

Brain.prototype._startPrintedWalletScan = function _startPrintedWalletScan () {
  this._transitionState('printerScanAddress')
  const txId = this.tx.id

  if (this.hasNewScanBay()) this.scanBayLightOn()

  this.scanner.scanQR((err, pk) => {
    this.scanBayLightOff()
    clearTimeout(this.screenTimeout)
    this.startDisabled = false

    if (err) this.emit('error', err)
    const startState = _.includes(this.state, ['printerScanAddress', 'goodbye'])
    const freshState = this.tx.id === txId && startState

    if (!freshState) return
    if (!pk) return this._idle()
    if ((err && err.message === 'Invalid address') || this.pk !== pk) {
      return this._timedState('printerScanningError')
    }

    this.browser().send({ tx: this.tx })
    this._handleScan(this.tx.toAddress)
  })

  this.screenTimeout = setTimeout(() => {
    if (this.state !== 'printerScanAddress') return
    this.scanner.cancel()
  }, QR_TIMEOUT)
}

Brain.prototype.scanBayLightOn = function scanBayLightOn () {
  emit('scanBayLightOn')
}

Brain.prototype.scanBayLightOff = function scanBayLightOff () {
  emit('scanBayLightOff')
}

Brain.prototype.handleUnresponsiveCamera = function handleUnresponsiveCamera () {
  if (!this.scanner.isOpened()) return this._idle()

  this._transitionState('maintenance')

  let handle = setInterval(() => {
    if (this.scanner.isOpened()) return
    clearInterval(handle)
    this._idle()
  }, 200)
}

Brain.prototype._scanActionCancel = function _scanActionCancel (fsm) {
  this.clearTimeoutToScannerCancel()
  this.scanner.cancel()
  fsm.dispatch('FAIL')
}

Brain.prototype._cancelIdScan = function _cancelIdScan () {
  this.clearTimeoutToScannerCancel()
  this.startDisabled = true
  this._bye({ timeoutHandler: () => { this.handleUnresponsiveCamera() } })
  this.scanner.cancel()
}

Brain.prototype.hasNewScanBay = function hasNewScanBay () {
  const model = deviceConfig.cryptomatModel
  return model === 'aveiro' || model === 'sintra' || model === 'gaia' || model === 'tejo' || model === 'grandola'
}

Brain.prototype._startAddressScan = function _startAddressScan () {
  if (this.billValidatorErrorFlag) {
    this._transitionState('cashInDisabled')
    return setTimeout(() => {
      this._idle()
    }, 7000)
  }
  this._transitionState('scanAddress')
  const txId = this.tx.id

  const frames = []
  const saveFailedScans = this.shouldSaveQrAttempts ?
    photo => frames.push(photo) :
    _.noop
  this.scanner.scanMainQR(this.tx.cryptoCode, saveFailedScans, (err, address) => {
    this.scanBayLightOff()
    clearTimeout(this.screenTimeout)
    this.startDisabled = false

    if (err && err.message === 'Timeout') return this._idle()
    if (err && err.message === 'Invalid address') return this._invalidAddress()
    if (err && err.message === 'Non-zero amount invoice supplied.') return this._invalidAddress(true)
    if (err) this.emit('error', err)
    const startState = _.includes(this.state, ['scanAddress', 'goodbye'])
    const freshState = this.tx.id === txId && startState

    if (!freshState) {
      console.log('not a fresh state')
      return
    }
    if (!address) {
      console.log('empty address from scanner lib')
      this.failedQRScans(frames)
      return this._idle()
    }
    this._handleScan(address)
  })

  this.screenTimeout = setTimeout(() => {
    if (this.state !== 'scanAddress') return
    this.scanner.cancel()
  }, QR_TIMEOUT)
}

Brain.prototype._bye = function _bye (opts) {
  this._timedState('goodbye', opts)
}

Brain.prototype._invalidAddress = function _invalidAddress (lnInvoiceTypeError) {
  this._timedState('invalidAddress', {
    timeout: INVALID_ADDRESS_TIMEOUT,
    data: { lnInvoiceTypeError }
  })
}

Brain.prototype._cancelScan = function _cancelScan () {
  this.startDisabled = true
  // TODO new-admin
  this._bye({ timeoutHandler: () => { this.handleUnresponsiveCamera() } })
  this.scanner.cancel()
}

Brain.prototype._cancelInsertBill = function _cancelInsertBill () {
  this._idle()
  this.disableBillValidator()
}

Brain.prototype.isStaticState = function isStaticState () {
  const staticStates = ['chooseCoin', 'idle', 'pendingIdle',
    'networkDown', 'unpaired', 'maintenance', 'virgin']

  return _.includes(this.state, staticStates)
}

Brain.prototype.balance = function balance () {
  const cryptoCode = this.tx.cryptoCode
  if (!cryptoCode) throw new Error('No cryptoCode, this shouldn\'t happen')

  return this.trader.balances[cryptoCode]
}

Brain.prototype._tcEnabled = function _tcEnabled () {
  return _.get(['active'], this.trader.terms)
}

Brain.prototype._tcPhotoEnabled = function _tcPhotoEnabled () {
  return _.get(['tcPhoto'], this.trader.terms)
}

Brain.prototype._getTermsDelayConfig = function _getTermsDelayConfig () {
  const ret = { delayTimer: 0, delay: false }
  if (!this._tcEnabled()) return ret

  const termsDelayEnabled = _.get(['delay'], this.trader.terms)
  const buttonDelay = termsDelayEnabled ? TERMS_DELAY : 0
  const photoEnabled = this._tcPhotoEnabled()
  const photoDelay = photoEnabled ? this.scanner.getDelayMS() : 0

  ret.delayTimer = Math.max(photoDelay, buttonDelay)
  ret.delay = photoEnabled || termsDelayEnabled
  return ret
}

Brain.prototype.sendRates = function sendRates () {
  const cryptoCode = this.tx.cryptoCode
  if (!cryptoCode) return
  const rec = {
    fiatCode: this.fiatCode,
    rates: {
      rates: this.trader.rates(cryptoCode),
      cryptoCode: cryptoCode,
      coins: coinUtils.cryptoCurrencies()
    },
    coins: this.trader.coins,
    twoWayMode: this.twoWayMode(),
    terms: _.assign(this.trader.terms, this._getTermsDelayConfig()),
    operatorInfo: this.trader.operatorInfo,
    areThereAvailablePromoCodes: this.trader.areThereAvailablePromoCodes,
    supportedCoins: this.mapCryptoUnitsDisplay(this.trader.coins),
    screenOpts: this.trader.machineScreenOpts
  }

  this.browser().send(rec)
}

Brain.prototype._pollUpdate = function _pollUpdate (needsRefresh) {
  const locale = this.trader.locale
  this.fiatCode = locale.fiatCode
  this.localeInfo = _.merge(locale.localeInfo, { country: locale.country })

  if (!this.isIdleState()) return

  this.sendRates()
  if (needsRefresh) this._idle()
}

Brain.prototype._clearNetworkDownTimeout = function _clearNetworkDownTimeout () {
  if (this.networkDownTimeout)
    this.networkDownTimeout = clearTimeout(this.networkDownTimeout)
}

Brain.prototype._setNetworkDownTimeout = function _setNetworkDownTimeout () {
  if (!this.networkDownTimeout)
    this.networkDownTimeout = setTimeout(() => this._forceNetworkDown(), 5 * 60 * 1000)
  return this.networkDownTimeout
}

Brain.prototype._networkDown = function _networkDown () {
  if (this.state === 'networkDown') return

  if (_.isEmpty(this.trader.coins)) {
    console.log('No active cryptocurrencies.')
  }

  this.networkDown = true

  const tx = this.tx

  // If there's no ongoing transaction we can postpone the network down screen.
  if (!tx || !tx.direction)
    return this._setNetworkDownTimeout()

  const doForceDown = (tx.direction === 'cashIn' && _.isEmpty(tx.bills)) ||
    (tx.direction === 'cashOut' && !tx.toAddress)

  if (doForceDown) this._forceNetworkDown()
}

Brain.prototype._forceNetworkDown = function _forceNetworkDown () {
  this._clearNetworkDownTimeout()

  const self = this

  this.trader.clearConfigVersion()

  if (!this.hasConnected && this.state !== 'connecting') {
    this._transitionState('connecting')
    setTimeout(function () {
      self.hasConnected = true
      if (self.state === 'connecting') self._idle()
    }, CONNECTING_TIMEOUT)
    return
  }

  if (this.hasConnected) this._transitionState('networkDown')
}

const isNonTx = state => _.includes(state, NON_TX_STATES)

let firstUp = true
Brain.prototype._networkUp = function _networkUp () {
  this._clearNetworkDownTimeout()

  // Don't go to start screen yet
  if (!this.billValidator.hasDenominations()) return

  this.networkDown = false
  this.hasConnected = true

  if (firstUp) {
    firstUp = false
    this.processPending()
  }

  if (isNonTx(this.state)) return this._idle()
}

Brain.prototype._timedState = function _timedState (state, opts) {
  const self = this
  opts = opts || {}

  if (this.state === state) {
    // console.trace('WARNING: Trying to set to same state: %s', state)
    return
  }
  const timeout = opts.timeout || 30000
  const handler = opts.timeoutHandler ? opts.timeoutHandler : function () { self._idle() }

  this._transitionState(state, opts.data)
  this._screenTimeout(handler, timeout)
}

Brain.prototype._transitionState = function _transitionState (state, auxData) {
  // TODO refactor code to use this
  // If we're in maintenance state, we stay there till we die
  if (this.state === state || this.state === 'maintenance') return false
  const rec = { action: state, direction: this.tx && this.tx.direction }
  transitionTime = Date.now()
  this._setState(state)
  this.browser().send(_.merge(auxData, rec))
  return true
}

Brain.prototype._assertState = function _assertState (expected) {
  const actual = this.state
  console.assert(actual === expected,
    'State should be ' + expected + ', is ' + actual)
}

Brain.prototype._handleScan = function _handleScan (address) {
  const waitingTimeout = setTimeout(() => {
    this._transitionState('cashInWaiting')
  }, MIN_WAITING)

  const t0 = Date.now()

  return this.updateTx({ toAddress: address })
    .then(it => {
      this.updateTxCustomerPhoto(it).catch(console.log)
      clearTimeout(waitingTimeout)

      const elapsed = Date.now() - t0
      const extraTime = MIN_WAITING * 2 - elapsed
      const remaining = this.state === 'cashInWaiting'
        ? Math.max(0, extraTime)
        : 0

      if (it.addressReuse) {
        return setTimeout(() => {
          this._timedState('addressReuse')
        }, remaining)
      }

      if (it.blacklisted) {
        return setTimeout(() => {
          this._timedState('suspiciousAddress', { data: { blacklistMessage: it.blacklistMessage } })
        }, remaining)
      }

      setTimeout(() => {
        return this._firstBill()
      }, remaining)
    })
    .catch(e => {
      if (e.statusCode === SCORE_THRESHOLD_REACHED_CODE || e.statusCode === CIPHERTRACE_ERROR_CODE) {
        clearTimeout(waitingTimeout)
        return this.showBlockedCustomer()
      }

      console.log(e)
      this._networkDown()
    })
}

function emit (_event) {
  const event = _.isString(_event)
    ? { action: _event }
    : _event

  actionEmitter.emit('brain', event)
}

Brain.prototype._firstBill = function _firstBill () {
  this.billValidatorHasShutter()
    ? this._setState('acceptingFirstRecyclerBills')
    : this._setState('acceptingFirstBill')
  this.browser().send({
    billValidator: this.billValidator.name || '',
    action: 'scanned',
    buyerAddress: coinUtils.formatAddress(this.tx.cryptoCode, this.tx.toAddress)
  })
  this.enableBillValidator()
  this._screenTimeout(() => this._idle(), BILL_TIMEOUT)
}

// Bill validating states

Brain.prototype._billsInserted = function _billsInserted () {
  emit('billValidatorAccepting')
  this.browser().send({ action: 'acceptingBill' })
  this._setState('billInserted')
}

Brain.prototype.enableBillValidator = function enableBillValidator () {
  emit('billValidatorPending')
  this.billValidator.enable()
}

Brain.prototype.reenableBillValidator = function reenableBillValidator () {
  this.billValidator.reenable()
}

Brain.prototype.disableBillValidator = function disableBillValidator () {
  emit('billValidatorOff')
  this.billValidator.disable()
}
/**
 * 處理鈔票被讀取時的邏輯
 * 
 * @param {Array} bills - 讀取到的鈔票資訊陣列
 * 
 * 這個函式會:
 * 1. 檢查是否在可以接受鈔票的狀態
 * 2. 計算這次投入的鈔票金額
 * 3. 檢查是否超過各種限制:
 *    - 機器內剩餘的加密貨幣餘額(轉換成法幣)
 *    - 法規遵循的限制金額
 *    - 最低交易金額
 * 4. 如果超過限制:
 *    - 拒絕收下鈔票
 *    - 計算還可以接受多少金額的鈔票
 *    - 如果餘額太低就停用鈔票驗證機
 *    - 通知瀏覽器顯示相關訊息
 * 
 * 舉例:
 * - 如果投入1000元,但機器只剩下價值500元的加密貨幣
 * - 就會拒絕這張1000元,改成只收500元以下的鈔票
 * - 如果連500元都收不了,就會停用鈔票驗證機
 */
Brain.prototype._billsRead = function _billsRead (bills) {
  // 取得鈔票驗證機物件
  const billValidator = this.billValidator

  // 如果是現金回收機,就使用原本的鈔票資訊,否則設定鈔票目的地為錢箱
  bills = this.isCashRecycler() ? bills : [_.set('destinationUnit', 'cashbox', bills)]

  // 檢查目前狀態是否可以接受鈔票
  // 如果不在可接受鈔票的狀態,就拒絕並記錄錯誤
  if (!_.includes(this.state, BILL_ACCEPTING_STATES)) {
    console.trace('Attempting to reject, not in bills accepting state.')
    return billValidator.reject()
  }

  // 將鈔票加入交易中
  bills = this.insertBills(bills)

  // 計算這次投入的鈔票總金額
  const currentBills = this.getBillsFiatValue(bills)

  // 取得這次投入鈔票前的交易總金額
  const fiatBeforeBills = this.tx.fiat

  // 計算投入這次鈔票後的總金額
  const fiatAfterBills = fiatBeforeBills.add(currentBills)

  // 設定合規性檢查的金額上限
  // 如果 failedCompliance 是 null,表示是因為交易頻率或連續天數觸發,就設為無限大
  // 否則使用 failedComplianceValue 或 0 作為上限
  const failedTierThreshold = _.isNil(this.failedCompliance) ? BN(Infinity) : BN(this.failedComplianceValue || 0)

  // 計算還可以投入多少金額的鈔票
  // 會取 機器餘額 和 合規性上限 中較小的值,再減去已投入的金額
  const remainingFiatToInsert = BN.klass.min(this.balance(), failedTierThreshold).sub(fiatBeforeBills)

  // 取得最低交易金額限制
  const minimumAllowedTx = this.tx.minimumTx

  // 如果這次投入的金額超過剩餘可投入金額
  if (remainingFiatToInsert.lt(currentBills)) {
    // 拒絕這次投入的鈔票
    billValidator.reject()

    // 計算還可以接受的最大面額
    const highestBill = billValidator.highestBill(remainingFiatToInsert)

    // 如果連最小面額都無法接受
    if (highestBill.lte(0)) {
      console.log('DEBUG: low balance, attempting disable')
      // 停用鈔票驗證機
      this.disableBillValidator()
      // 通知瀏覽器只能發送加密貨幣
      this.browser().send({
        sendOnly: true,
        cryptoCode: this.tx.cryptoCode
      })

      return
    }

    // 通知瀏覽器顯示餘額不足,只能接受特定面額
    this.browser().send({
      action: 'highBill',
      highestBill: highestBill.toNumber(),
      reason: 'lowBalance'
    })

    return
  }

  // 如果投入後的總金額低於最低交易金額
  if (fiatAfterBills.lt(minimumAllowedTx)) {
    // 拒絕這次投入的鈔票
    billValidator.reject()

    // 計算達到最低交易金額需要的最小面額
    const lowestBill = billValidator.lowestBill(minimumAllowedTx)

    // 通知瀏覽器顯示最低交易金額訊息
    this.browser().send({
      action: 'minimumTx',
      lowestBill: lowestBill.toNumber()
    })

    return
  }

  // 建立用來檢查合規性的交易物件
  const amount = fiatBeforeBills.add(currentBills)
  const triggerTx = { fiat: amount, direction: this.tx.direction }

  // 檢查是否有不合規的層級
  const nonCompliantTiers = this.nonCompliantTiers(this.trader.triggers, this.customerTxHistory, triggerTx)
  const isCompliant = _.isEmpty(nonCompliantTiers)

  // 如果有不合規的層級
  // 注意:如果門檻是0,簡訊驗證會在 startScreen 時處理
  if (!isCompliant) {
    // 拒絕目前的鈔票並停用驗證機,直到通過合規性檢查
    this.billValidator.reject()
    this.lastRejectedBillsFiat = currentBills
    this.disableBillValidator()

    // 檢查是否需要身分證驗證
    const nonCompliantTier = _.head(nonCompliantTiers)
    const idTier = nonCompliantTier === 'idCardData' || nonCompliantTier === 'idCardPhoto'
    // 如果需要身分證驗證,就轉換到驗證畫面
    if (idTier) return this.transitionToVerificationScreen(nonCompliantTier)

    // 執行合規性檢查流程
    return this.runComplianceTiers(nonCompliantTiers)
  }

  // 檢查是否有手動觸發的不合規項目被掃描到
  if (this.txBlockedByTrigger) {
    this.txBlockedByTrigger = false
    return this.showBlockedCustomer()
  }

  // 通知瀏覽器正在接受鈔票
  this.browser().send({
    action: 'acceptingBill',
    readingBills: currentBills.toNumber()
  })
  // 更新狀態為已讀取鈔票
  this._setState('billsRead')
  // 將鈔票堆疊到錢箱
  billValidator.stack()
}

/*
 * Event handler for when a validator/recycler rejects bills and the customer
 * has to manually remove them from the cash slot.
 */
Brain.prototype._cashSlotRemoveBills = function () {
  this.browser().send({ action: 'cashSlotRemoveBills' })
  this.billValidator.openShutter()
}

Brain.prototype._leftoverBillsInCashSlot = function () {
  this.browser().send({ action: 'leftoverBillsInCashSlot' })
  this.billValidator.openShutter()
}

Brain.prototype._leftoverBillsRemoved = function () {
  this.billValidator.leftoverBillsRemoved()
    .then(ready => { if (ready) this._idle() })
    .catch(err => console.error(err)) /* TODO: maint */
}

Brain.prototype.runComplianceTiers = function (nonCompliantTiers) {
  const tier = _.head(nonCompliantTiers)

  const isCashIn = this.tx.direction === 'cashIn'
  const idTier = tier === 'idCardData' || tier === 'idCardPhoto'
  const smsTier = tier === 'sms'
  const emailTier = tier === 'email'
  const cameraTier = tier === 'facephoto'
  const usSsnTier = tier === 'usSsn'
  const externalTier = tier === 'external'
  const customTier = uuid4Validate(tier)

  const smsScreen = smsTier && isCashIn && !_.get('sms')(this.permissionsGiven)
  const emailScreen = emailTier && isCashIn && !_.get('email')(this.permissionsGiven)
  const idScreen = idTier && isCashIn && !_.get('id')(this.permissionsGiven)
  const photoScreen = cameraTier && !_.get('photo')(this.permissionsGiven)
  const usSsnScreen = usSsnTier && !_.get('usSsn')(this.permissionsGiven)
  const externalScreen = externalTier && !_.get('external')(this.permissionsGiven)
  const customScreen = customTier && !_.get(tier)(this.permissionsGiven)
  if (this.isGenmegaMachine && tier === 'idCardPhoto') {
    this.suspendTriggerId = 'id-card-photo-disabled'
    return complianceTiers.run('suspend', null, null)
  }
  if (photoScreen && !this.hasFrontFacingCamera) {
    this.suspendTriggerId = 'no-ff-camera'
    return complianceTiers.run('suspend', null, null)
  }

  if (customScreen) {
    this.customInfoRequestId = tier
  }

  if (smsScreen || emailScreen || idScreen || photoScreen || usSsnScreen || customScreen || externalScreen) {
    return this.transitionToVerificationScreen(tier)
  }

  complianceTiers.run(tier, this.rootConfig.cryptomatModel || 'sintra', _.find(['requirement', tier])(this.triggers))
}

Brain.prototype.transitionToVerificationScreen = function (tier) {
  const formattedTier = uuid4Validate(tier) ? 'custom' : tier
  switch (formattedTier) {
    case 'idCardData':
    case 'idCardPhoto':
      this._transitionState('permission_id', {
        tx: this.tx
      })
      break
    case 'facephoto':
      this._transitionState('permission_face_photo', {
        tx: this.tx
      })
      break
    case 'usSsn':
      this._transitionState('usSsnPermission', {
        tx: this.tx
      })
      break
    case 'external':
      this._transitionState('externalPermission', {
        tx: this.tx
      })
      break
    case 'custom':
      this._transitionState('customInfoRequestPermission', {
        tx: this.tx,
        customInfoRequest: _.get('customInfoRequest.customRequest')(_.find(trigger => trigger.customInfoRequestId === this.customInfoRequestId)(this.triggers))
      })
      break
    case 'email':
      this._transitionState('emailVerification', {
        tx: this.tx
      })
      break
    default:
      this._transitionState('smsVerification', {
        tx: this.tx
      })
  }
}

Brain.prototype.saveTx = function saveTx (tx) {
  return db.save(this.dbRoot, tx)
}

Brain.prototype.postTx = function postTx (tx, ongoingTx=false) {
  const onFailedAttempt = err =>
    console.error(
      err.retriesLeft > 0 ?
        "Error posting TX, will retry:" :
        "Error posting TX:",
      err.message
    )

  let timedout = false
  const started = Date.now()
  const post = () => {
    timedout = timedout || Date.now() - started >= NETWORK_TIMEOUT_INTERVAL
    return this.trader.postTx(_.set('timedout', timedout, tx))
      .catch(err => {
        if (err instanceof E.StaleError || err instanceof E.RatchetError) {
          console.log(
            err.name === 'StaleError' ?
              "Local transaction is outdated, won't retry:" :
              "Local transaction conflicts with server, won't retry:",
            err.message
          )
          return Promise.reject(new pRetry.AbortError(err))
        }

        // Stop trying if there's a higher tx version
        if (ongoingTx && this.tx.txVersion > tx.txVersion)
          return Promise.reject(new pRetry.AbortError(err))

        return Promise.reject(err)
      })
  }

  // Sum[2000*x^k, {k, 0, 3}] = 20000
  // 0..3 = 4 retries = 5 tries
  // 2000ms = 2s minimum wait
  return pRetry(post, {
      retries: 4,
      factor: 1.6608,
      minTimeout: 2000,
      onFailedAttempt,
    })
    .then(tx => {
      this.saveTx(tx) // No big deal if saving the tx details on disk fails
        .catch(err => console.log("Error saving transaction to local DB (ignoring):", err))
      return tx
    })
    .catch(e => Promise.reject(timedout ? new Error('timeout') : e))
}

Brain.prototype.updateTx = function updateTx (updateTx) {
  const newTx = Tx.update(this.tx, updateTx)
  this.tx = newTx

  return this.saveTx(newTx)
    .then(() => this.postTx(newTx, true))
    .then(tx => {
      this.tx = tx
      return tx
    })
}

Brain.prototype.updateTxCustomerPhoto = function updateTxCustomerPhoto ({ customerId, id, direction }) {
  const tcPhotoData = facephoto.getTCData()
  if (!tcPhotoData) return Promise.resolve()
  return this.trader.updateTxCustomerPhoto(id, customerId, { tcPhotoData: tcPhotoData, direction: direction })
}

// Don't wait for server response
Brain.prototype.fastUpdateTx = function fastUpdateTx (updateTx) {
  console.log('fastUpdateTx', updateTx)
  const newTx = Tx.update(this.tx, updateTx)
  this.tx = newTx

  this.postTx(newTx, true)
    .catch(err => console.log(err))

  return this.saveTx(newTx)
}

Brain.prototype.commitCashOutTx = function commitCashOutTx () {
  return this.updateTx({})
    .then(tx => {
      this.updateTxCustomerPhoto(tx).catch(console.log)
      const amountStr = this.toCryptoUnits(tx.cryptoAtoms, tx.cryptoCode).toString()
      const depositUrl = coinUtils.depositUrl(tx.cryptoCode, tx.toAddress, amountStr)
      const layer2Url = coinUtils.depositUrl(tx.cryptoCode, tx.layer2Address, amountStr)
      const toAddress = coinUtils.formatAddress(tx.cryptoCode, tx.toAddress)
      const layer2Address = coinUtils.formatAddress(tx.cryptoCode, tx.layer2Address)

      const depositInfo = {
        toAddress,
        layer2Address,
        depositUrl,
        layer2Url
      }

      this._waitForDispense('notSeen')

      return this.browser().send({ depositInfo })
    })
    .catch(err => this._fiatError(err))
}

Brain.prototype._billsValid = function _billsValid () {
  if (!_.includes(this.state, BILL_ACCEPTING_STATES)) {
    console.error("Validator emitted billsValid event; not in bills-accepting state")
    return this.billValidator.reject()
  }

  this.updateBillsScreen()
}

Brain.prototype.updateBillsScreen = function updateBillsScreen (blockedCustomer) {
  const bills = this.bills

  // No going back
  this.clearBills()
  this.lastRejectedBillsFiat = BN(0)

  emit('billValidatorPending')

  let billUpdate = Tx.billUpdate(bills)

  const state = this.billValidatorHasShutter()
    ? 'acceptingRecyclerBills'
    : 'acceptingBills'

  return this.fastUpdateTx(billUpdate)
    .then(() => {
      this._transitionState(state, { tx: this.tx })
      this._screenTimeout(() => this._sendCoins(), BILL_TIMEOUT)
    })
    .then(() => this.completeBillHandling(blockedCustomer))
}

// TODO: clean this up
Brain.prototype._billsRejected = function _billsRejected () {
  const self = this
  if (!_.includes(this.state, BILL_ACCEPTING_STATES) && !_.includes(this.state, COMPLIANCE_VERIFICATION_STATES)) return

  this.clearBills()

  const returnState = this.isCashRecycler()
    ? this.tx.fiat.eq(0)
      ? 'acceptingFirstRecyclerBills'
      : 'acceptingRecyclerBills'
    : this.tx.fiat.eq(0)
      ? 'acceptingFirstBill'
      : 'acceptingBills'

  this._transitionState(returnState)

  this._screenTimeout(function () {
    (returnState === 'acceptingFirstBill' || returnState === 'acceptingFirstRecyclerBills')
      ? self._idle()
      : self._sendCoins()
  }, BILL_TIMEOUT)

  const response = {
    action: 'rejectedBill',
    credit: this._uiCredit()
  }

  this.browser().send(response)
}

Brain.prototype._billStandby = function _billStandby () {
  if (this.state === 'acceptingFirstRecyclerBills' || this.state === 'acceptingRecyclerBills' || this.state === 'acceptingBills' || this.state === 'acceptingFirstBill') {
    this.enableBillValidator()
  }
}

Brain.prototype._billJam = function _billJam () {
  // TODO FIX: special screen and state for this
  this.browser().send({ action: 'networkDown' })
}

Brain.prototype._billsEnabled = function _billsEnabled () {
  this.billValidatorErrorFlag = false // If enabled, previous errors are no longer an issue
}

Brain.prototype._stackerOpen = function _stackerOpen () {
  return this.trader.notifyCashboxRemoval()
    .then(data => this._printCashboxReceipt(data))
}

Brain.prototype._uiCredit = function _uiCredit () {
  let updatedBills = Tx.billUpdate(this.bills)
  const tx = Tx.update(this.tx, updatedBills)

  return {
    cryptoCode: tx.cryptoCode,
    fiat: tx.fiat.toNumber(),
    cryptoAtoms: tx.cryptoAtoms.toNumber(),
    lastBill: _.last(tx.bills.map(bill => bill.fiat.toNumber()))
  }
}

/**
 * Clear the rejected bills and keep its amount as the lastRejectedBillsFiat
 *
 * @name clearBills
 * @function
 *
 */
Brain.prototype.clearBills = function clearBills () {
  this.lastRejectedBillsFiat = this.bills ? this.getBillsFiatValue(this.bills) : BN(0)
  this.bills = null
}

Brain.prototype.insertBills = function insertBills (bills) {
  console.assert(!this.bills || this.getBillsFiatValue(this.bills).eq(0), "bill fiat is positive, can't start tx")

  this.bills = _.map(it => Tx.createBill(it, this.tx), bills)

  return this.bills
}

Brain.prototype.getBillsFiatValue = function getBillsFiatValue (bills) {
  return _.reduce((acc, value) => acc.add(value.fiat), BN(0), bills)
}

Brain.prototype._insertPromoCode = function _insertPromoCode () {
  this._timedState('insertPromoCode')
}

Brain.prototype._cancelPromoCode = function _cancelPromoCode () {
  if (this.tx.direction === 'cashIn') this.returnToCashInState()
  if (this.tx.direction === 'cashOut') this.returnToCashOutState()
}

Brain.prototype._submitPromoCode = function _submitPromoCode (data) {
  const promoCode = data.input

  this.trader.verifyPromoCode(promoCode, this.tx).then(res => {
    /*
      * It's possible for a customer to insert a promo code before inserting the phone data, leading to two possible discounts.
      * In that case, use the bigger discount.
      * See: verifyCustomerDiscounts()
      */
    this.tx = Tx.update(this.tx, { promoCodeApplied: true })

    this.verifyCustomerDiscounts(res.promoCode, 'promoCode')

    const rec = {
      rates: {
        rates: Tx.getRates(this.tx)[this.tx.cryptoCode],
        cryptoCode: this.tx.cryptoCode,
        coins: Tx.coins
      },
      credit: this._uiCredit()
    }

    this.browser().send(rec)

    this.tx.direction === 'cashIn'
      ? this.returnToCashInState()
      : this.returnToCashOutState()
  }).catch(err => {
    console.log('Promo code not found: Error ' + err)
    this._transitionState('invalidPromoCode')
    this._screenTimeout(() => {
      this._cancelPromoCode()
    }, PROMO_CODE_TIMEOUT)
  })
}

Brain.prototype.returnToScanState = function returnToScanState () {
  const callback = this._start.bind(this)
  this._screenTimeout(callback, QR_TIMEOUT)
}

Brain.prototype.returnToCashInState = function returnToCashInState () {
  if (!this.tx.toAddress) return this.returnToScanState()
  const returnState = this.isCashRecycler()
    ? this.tx.fiat.eq(0)
      ? 'acceptingFirstRecyclerBills'
      : 'acceptingRecyclerBills'
    : this.tx.fiat.eq(0)
      ? 'acceptingFirstBill'
      : 'acceptingBills'

  const callback = (returnState === 'acceptingFirstBill' || returnState === 'acceptingFirstRecyclerBills')
    ? this._idle.bind(this)
    : this._sendCoins.bind(this)

  this._transitionState(returnState, { tx: this.tx })
  this._screenTimeout(callback, BILL_TIMEOUT)
}

Brain.prototype.returnToCashOutState = function returnToCashOutState () {
  this._transitionState('chooseFiat', {
    chooseFiat: this._getFiatButtonResponse(),
    tx: this.tx
  })
  this._screenTimeout(this._chooseFiatCancel.bind(this), 120000)
}

Brain.prototype.verifyCustomerDiscounts = function verifyCustomerDiscounts (discount, source) {
  if (!_.isNil(discount)) {
    /*
      * It's possible for a customer to insert a promo code before inserting the phone data, leading to two possible discounts.
      * In that case, use the bigger discount.
      */
    const currentDiscount = this.tx.discount || 0
    if (discount.discount > currentDiscount) {
      this.tx = Tx.update(this.tx, { discount: discount.discount, discountSource: source })
    }
  }
}

Brain.prototype.recyclerContinue = function recyclerContinue () {
  this.browser().send({ action:'recyclerContinue' })
  return this.billValidator.cashCount()
}

Brain.prototype.actionRequiredMaintenance = function actionRequiredMaintenance () {
  this._setState('actionRequiredMaintenance')
  this.browser().send({ action: 'actionRequiredMaintenance' })
}

Brain.prototype.canSendCoins = function () {
  return this.billValidator.canSendCoins ?
    this.billValidator.canSendCoins() :
    Promise.resolve(true)
}

Brain.prototype._sendCoins = function _sendCoins () {
  this.canSendCoins()
    .then(canSendCoins => {
      if (!canSendCoins) return
      this.browser().send({
        action: 'cryptoTransferPending',
        buyerAddress: coinUtils.formatAddress(this.tx.cryptoCode, this.tx.toAddress)
      })
      this._doSendCoins()
    })
}

Brain.prototype._doSendCoins = function _doSendCoins () {
  const complianceStates = _.concat(COMPLIANCE_VERIFICATION_STATES, COMPLIANCE_REJECTED_STATES)
  if (this.state !== 'acceptingBills' && this.state !== 'acceptingRecyclerBills' && !_.includes(this.state, complianceStates)) return
  return this._executeSendCoins()
}

// This keeps trying until success
Brain.prototype._executeSendCoins = function _executeSendCoins () {
  emit('billValidatorPendingOff')
  this.disableBillValidator()

  this._verifyTransaction()

  const coin = _.find(['cryptoCode', this.tx.cryptoCode], this.trader.coins)

  const updateTx = coin.batchable ? ({ batched: true }) : ({ send: true })
  return this.updateTx(updateTx)
    .then(tx => this._cashInComplete(tx))
    .catch(err => {
      this._sendCoinsError(err)
      this.tx = _.set('timedout', true, this.tx)
      this.saveTx(this.tx)
    })
}

// Giving up, go to special screens asking user to contact operator
Brain.prototype._sendCoinsError = function _sendCoinsError (err) {
  console.log('Error sending cryptos: %s', err.message)

  const withdrawFailureRec = {
    credit: this._uiCredit(),
    txId: this.tx.id
  }

  const self = this
  if (err.statusCode === INSUFFICIENT_FUNDS_CODE) {
    setTimeout(function () { self._idle() }, INSUFFICIENT_FUNDS_TIMEOUT)
    return this._transitionState('insufficientFunds', withdrawFailureRec)
  }
  
  this._transitionState('withdrawFailure', withdrawFailureRec)
  this._timeoutToIdle(60000)
}

// And... we're done!
Brain.prototype._cashInComplete = function _cashInComplete () {
  this._setState('completed')

  this.browser().send({
    action: 'cryptoTransferComplete',
    txId: this.tx.id
  })

  if (this.isAutomaticPrintActive()) this._startPrintReceipt()

  this._screenTimeout(this._completed.bind(this), COMPLETED_TIMEOUT)
}

Brain.prototype.isAutomaticPrintActive = function () {
  return this.trader.receiptPrintingActive && this.trader.automaticReceiptPrintActive
}

Brain.prototype._sendSmsReceipt = function _sendSmsReceipt () {
  const customer = this.customer
  const data = {
    session: this.tx.id,
    txClass: this.tx.direction
  }

  this.browser().send({ smsReceiptStatus: 'printing' })
  this.trader.smsReceipt(data, customer.id)
    .then(() => this.browser().send({ smsReceiptStatus: 'success' }))
    .catch(() => {
      this.browser().send({ smsReceiptStatus: 'failed' })
      setTimeout(() => {
        this.browser().send({ smsReceiptStatus: 'available' })
      }, 2500)
    })
}

Brain.prototype._startPrintReceipt = function _startPrintReceipt () {
  this.browser().send({ receiptStatus: 'printing', automaticPrint: this.isAutomaticPrintActive() })
  this._printReceipt()
    .then(() => this.browser().send({ receiptStatus: 'success', automaticPrint: this.isAutomaticPrintActive() }))
    .catch(() => {
      this.browser().send({ receiptStatus: 'failed', automaticPrint: this.isAutomaticPrintActive() })
      setTimeout(() => {
        this.browser().send({ receiptStatus: 'available', automaticPrint: this.isAutomaticPrintActive() })
      }, 2500)
    })
}

Brain.prototype._printReceipt = function _printReceipt () {
  if (!this.printer) {
    console.log('[ERROR]: The kiosk printer is not loaded')
    return
  }

  const cashInCommission = BN(1).add(BN(this.tx.commissionPercentage))

  const rate = BN(this.tx.rawTickerPrice).mul(cashInCommission).round(2)
  const date = new Date()
  date.setMinutes(date.getMinutes() + this.trader.timezone)

  const dateString = `${date.toISOString().replace('T', ' ').slice(0, 19)}`

  const data = {
    operatorInfo: this.trader.operatorInfo,
    location: deviceConfig.machineLocation,
    customer: this.customer ? this.customer.phone : 'Anonymous',
    session: this.tx.id,
    time: dateString,
    direction: this.tx.direction === 'cashIn' ? 'Cash-in' : 'Cash-out',
    fiat: `${this.tx.fiat.toString()} ${this.tx.fiatCode}`,
    crypto: `${this.toCryptoUnits(this.tx.cryptoAtoms, this.tx.cryptoCode)} ${this.tx.cryptoCode}`,
    rate: `1 ${this.tx.cryptoCode} = ${rate} ${this.tx.fiatCode}`,
    address: this.tx.toAddress,
    txId: this.tx.txHash
  }

  return this.printer.checkStatus(deviceConfig.kioskPrinter, STATUS_QUERY_TIMEOUT)
    .then(() => this.printer.printReceipt(data, deviceConfig.kioskPrinter, this.trader.receiptOptions))
    .catch((err) => {
      console.log('[ERROR]: The kiosk printer is in an invalid state.', err)
      throw err
    })
}

Brain.prototype._printCashboxReceipt = function (data) {
  if (!this.printer) {
    console.log('[ERROR]: The kiosk printer is not loaded')
    return
  }

  return this.printer.checkStatus(deviceConfig.kioskPrinter, STATUS_QUERY_TIMEOUT)
    .then(() => this.printer.printCashboxReceipt(data, deviceConfig.kioskPrinter))
    .catch((err) => {
      console.log('[ERROR]: The kiosk printer is in an invalid state.', err)
      throw err
    })
}

Brain.prototype._verifyTransaction = function _verifyTransaction () {
  if (!this.idVerify.inProgress()) return

  this.idVerify.addTransaction(this.tx)
  this.idVerify.verifyTransaction(function (err) { console.log(err) })
}

Brain.prototype._screenTimeoutHandler = function _screenTimeoutHandler (callback) {
  this.currentScreenTimeout = null
  callback()
}

Brain.prototype._screenTimeout = function _screenTimeout (callback, timeout) {
  const self = this

  if (this.currentScreenTimeout) {
    clearTimeout(this.currentScreenTimeout)
    this.currentScreenTimeout = null
  }

  this.currentScreenTimeout =
    setTimeout(function () { self._screenTimeoutHandler(callback) }, timeout)
}

Brain.prototype._timeoutToIdle = function _timeoutToIdle (timeout) {
  const self = this
  this._screenTimeout(function () { self._idle() }, timeout)
}

Brain.prototype._completed = function _completed () {
  if (this.state === 'goodbye' || this.state === 'maintenance') return

  emit('ledsOff')

  this._transitionState('goodbye')

  const elapsed = Date.now() - this.bootTime
  if (elapsed > EXIT_TIME) {
    console.log('Scheduled restart.')
    process.exit()
  }

  if (this.billValidatorErrorFlag) {
    this.emit('error', new Error('Bill validator error, exiting post transaction.'))
  }

  this._screenTimeout(() => this._idle(), GOODBYE_TIMEOUT)
}

Brain.prototype._machine = function _machine () {
  this.browser().send({ action: 'machine', machineInfo: this.config.unit })
  this._setState('machine')
}

Brain.prototype._cancelMachine = function _cancelMachine () {
  this._idle()
}

Brain.prototype._reboot = function _reboot () {
  console.log('Remote reboot')
  cp.execFile('shutdown', ['-r', 'now'], {}, function () {
    process.exit(0)
  })
}

Brain.prototype._shutdown = function _shutdown () {
  // can only run if machine is no in the middle of a transaction
  if (!this.isStaticState()) {
    console.log('In the middle of a transaction. Will shutdown when it is done...')
    return
  }
  console.log('Remote shutdown')
  cp.execFile('shutdown', ['now'], {}, function () {
    process.exit(0)
  })
}

Brain.prototype._diagnostics = function _diagnostics () {
  if (!this.isStaticState()) {
    console.log('Diagnostics cannot run in the middle of a transaction.')
    return
  }

  console.log('Running diagnostics')
  this.scanner.diagnosticPhotos()
    .then(body => this.trader.diagnosticPhotos(body))
    .then(() => console.log('Finished diagnostics'))
    .catch(err => console.log('Error running diagnostics:', err))
}

Brain.prototype._abortTransaction = function _abortTransaction () {
  this._idle()
}

Brain.prototype._restartServices = function _restartServices (reason, restartOthers) {
  console.log('Going down [%s]...', reason)
  if (!restartOthers) {
    return process.exit(0)
  }

  cp.execFile('supervisorctl', ['restart', 'lamassu-machine', 'lamassu-gsr50'], {}, console.log)
}

Brain.prototype._emptyUnit = function _emptyUnit (isRetry = false) {
  const lockfilePath = path.resolve(this.dataPath, 'empty-unit')
  // Using the bill validator instance, as that is the one available 100% of the time (cash-out can be disabled, losing the bill dispenser reference)
  const billValidator = this.billValidator

  if (_.isNil(billValidator) || billValidator.name !== 'GSR50') {
    console.log(`Received an emptyUnit request, but ${_.isNil(billValidator) ? `no bill validator is instanced` : `the bill validator is not GSR50`}. This request will be ignored`)
    return
  }

  this._transitionState('maintenance')
  const returnCall = isRetry
    ? pify(fs.readFile)(lockfilePath, { encoding: 'utf8' }).then(JSON.parse)
    : this.billValidator.emptyUnit()
  console.log('GSR50: Empty Unit running, isRetry?', isRetry)
  return returnCall
    .then(r => {
      if (!isRetry) fs.writeFile(lockfilePath, JSON.stringify(r), () => {})
      return this.trader.emptyUnit(r)
        .then(() => fs.unlink(lockfilePath, () => {}))
        .then(() => this.billValidator.updateCounts(r.units))
    })
    .catch(console.error)
    .finally(() => this._idle())
}

Brain.prototype._refillUnit = function _refillUnit (isRetry = false) {
  const lockfilePath = path.resolve(this.dataPath, 'refill-unit')
  // Using the bill validator instance, as that is the one available 100% of the time (cash-out can be disabled, losing the bill dispenser reference)
  const billValidator = this.billValidator

  if (_.isNil(billValidator) || billValidator.name !== 'GSR50') {
    console.log(`Received a refillUnit request, but ${_.isNil(billValidator) ? `no bill validator is instanced` : `the bill validator is not GSR50`}. This request will be ignored`)
    return
  }

  this._transitionState('maintenance')
  const returnCall = isRetry
    ? pify(fs.readFile)(lockfilePath, { encoding: 'utf8' }).then(JSON.parse)
    : this.billValidator.refillUnit()
  console.log('GSR50: Refill Unit running, isRetry?', isRetry)
  return returnCall
    .then(r => {
      if (!isRetry) fs.writeFile(lockfilePath, JSON.stringify(r), () => {})
      return this.trader.refillUnit(r)
        .then(() => fs.unlink(lockfilePath, () => {}))
        .then(() => this.billValidator.updateCounts(r.units))
    })
    .catch(console.error)
    .finally(() => this._idle())
}

Brain.prototype._unpair = function _unpair () {
  if (!pairing.isPaired(this.connectionInfoPath)) return

  console.log('Unpairing')
  this.stop()
  pairing.unpair(this.connectionInfoPath)

  console.log('Unpaired. Rebooting...')
  this._setState('unpaired')
  this.browser().send({ action: 'unpaired' })
  db.clean(this.dbRoot)
  setTimeout(() => this._restartServices('Unpair'), 2000)
}

Brain.prototype._billValidatorErr = function _billValidatorErr (err) {
  if (this.billValidatorErrorFlag) return // Already being handled

  if (this.tx && this.tx.bills.length > 0) {
    this.billValidatorErrorFlag = true
    this.disableBillValidator() // Just in case. If error, will get throttled.
    this.browser().send({ credit: this._uiCredit(), sendOnly: true, reason: 'validatorError' })
    return
  }

  this.billValidatorErrorFlag = true
}

Brain.prototype._getFiatButtonResponse = function _getFiatButtonResponse () {
  const tx = this.tx
  const cassettes = this.trader.cassettes
  const virtualCassettes = this.trader.virtualCassettes
  const recyclers = this.trader.recyclers
  const virtualRecyclers = this.trader.virtualRecyclers

  const units = [...cassettes, ...recyclers]
  const virtualUnits = [...virtualCassettes, ...virtualRecyclers]

  const txLimit = getAmountToHardLimit(this.trader.triggers, this.customerTxHistory, tx)
  const activeDenominations = Tx.computeCashOut(tx, units, virtualUnits, txLimit)

  return { tx, activeDenominations }
}

Brain.prototype._chooseFiat = function _chooseFiat () {
  // Show networkDown screen now if it's been delayed
  if (this.networkDown) return this._forceNetworkDown()

  const amount = this.complianceAmount()
  const triggerTx = { fiat: amount, direction: 'cashOut' }

  const response = this._getFiatButtonResponse()
  if (response.activeDenominations.isEmpty) return this._timedState('outOfCash')

  const nonCompliantTiers = this.nonCompliantTiers(this.trader.triggers, this.customerTxHistory, triggerTx)
  const isCompliant = _.isEmpty(nonCompliantTiers)

  if (!isCompliant) {
    return this.authCompliance()
  }

  const txId = this.tx.id
  const cryptoCode = this.tx.cryptoCode
  const coin = _.find(['cryptoCode', cryptoCode], this.trader.coins)

  const updateRec = {
    direction: 'cashOut',
    fiatCode: this.fiatCode,
    cashOutFee: coin.cashOutFee,
    commissionPercentage: BN(coin.cashOutCommission).div(100),
    rawTickerPrice: BN(coin.rates.bid)
  }

  const update = _.assignAll([this.tx, updateRec])

  this.tx = Tx.update(this.tx, update)

  this._transitionState('chooseFiat', {
    chooseFiat: response,
    isCashInOnlyCoin: coin.isCashInOnly,
    receiptStatus: this.trader.receiptPrintingActive ? 'available' : 'disabled',
    automaticPrint: this.isAutomaticPrintActive()
  })
  const self = this
  this.dirtyScreen = false
  const interval = setInterval(function () {
    const doClear = self.state !== 'chooseFiat' ||
      self.tx.id !== txId
    if (doClear) return clearInterval(interval)

    const isDirty = self.dirtyScreen
    self.dirtyScreen = false
    if (isDirty) return
    clearInterval(interval)
    self._idle()
  }, 120000)
}

Brain.prototype._chooseFiatCancel = function _chooseFiatCancel () {
  this._idle()
}

Brain.prototype._fiatButtonResponse = function _fiatButtonResponse () {
  this.dirtyScreen = true
  const response = this._getFiatButtonResponse()
  this.browser().send({ fiatCredit: response })
}

Brain.prototype._fiatButton = function _fiatButton (data) {
  const denomination = parseInt(data.denomination, 10)

  const buttons = this._getFiatButtonResponse()

  // We should always have enough available if the button could be pressed,
  // just double-checking

  if (buttons.activeDenominations.activeMap[denomination]) {
    this.tx = Tx.addCash(denomination, this.tx)
  }

  this._fiatButtonResponse()
}

Brain.prototype._clearFiat = function _clearFiat () {
  const tx = this.tx

  tx.fiat = BN(0)
  tx.cryptoAtoms = BN(0)

  this._fiatButtonResponse()
}

Brain.prototype.exceedsZeroConf = function exceedsZeroConf (tx) {
  // ETH zeroConfLimit should always be 0, and as such always exceeds
  if (tx.cryptoCode === 'ETH') return true
  const coin = coinUtils.getCryptoCurrency(tx.cryptoCode)

  if (!coin) throw new Error('Fatal: unsupported coin: ' + tx.cryptoCode)
  return coin.zeroConf && tx.fiat.gte(this.trader.zeroConfLimits[tx.cryptoCode])
}

Brain.prototype._cashOut = function _cashOut () {
  const tx = this.tx
  const amount = tx.fiat
  const triggerTx = { fiat: amount, direction: tx.direction }

  const nonCompliantTiers = this.nonCompliantTiers(this.trader.triggers, this.customerTxHistory, triggerTx)
  const isCompliant = _.isEmpty(nonCompliantTiers)
  const doCompliance = (this.exceedsZeroConf(tx) && !this._isCustomerAuthenticated()) || !isCompliant || this.txBlockedByTrigger

  if (doCompliance) {
    return this.authCompliance({ returnState: this.state })
  }

  return this.toDeposit()
}

Brain.prototype.toDeposit = function toDeposit () {
  const tx = this.tx
  this._transitionState('deposit', { tx })
  return this.commitCashOutTx()
}

Brain.prototype.toCryptoUnits = function toCryptoUnits (cryptoAtoms, cryptoCode) {
  const unitScale = coinUtils.getCryptoCurrency(cryptoCode).unitScale
  return cryptoAtoms.shift(-unitScale)
}

// User has deposited cryptos but we haven't received them after waiting
Brain.prototype._depositTimeout = function _depositTimeout () {
  this.tx.started = true
  const isEmailAuth = this.trader.customerAuthentication === CUSTOMER_AUTHENTICATION.EMAIL
  const complianceData = isEmailAuth ? this.tx.email : this.tx.phone

  if (complianceData) {
    return this._redeemLater()
  }

  this.authCompliance({ returnState: 'redeemLater', noCode: this.networkDown, reason: 'deposit_timeout' })
}

Brain.prototype.depositTimeoutNotSent = function depositTimeoutNotSent () {
  if (this.networkDown) return this._timedState('depositNetworkDown')
  this._cashOut()
}

Brain.prototype._redeemLater = function _redeemLater () {
  const updateP = this.networkDown
    ? this.fastUpdateTx({ redeem: true })
    : this.updateTx({ redeem: true })

  return updateP
    .then(() => this._timedState('redeemLater'))
    .catch(e => this._fiatError(e))
}

Brain.prototype._waitForDispense = function _waitForDispense (status) {
  const originalTx = this.tx
  return this.trader.waitForDispense(this.tx, status)
    .then(tx => {
      if (!tx) return
      if (this.tx.id !== tx.id) return

      return this._dispenseUpdate(tx)
    })
    .catch(err => {
      if (err.networkDown) this._networkDown()

      // prevent doing a fastupdateTx of the wrong tx
      if (originalTx.id !== this.tx.id) {
        return this._timedState('depositTimeout')
      }

      return this.fastUpdateTx({timedout: true})
        .then(() => {
          if (this.state !== 'areYouSure')
            this._timedState('depositTimeout')
        })
    })
}

Brain.prototype._fiatError = function _fiatError (err) {
  console.log('fiatError', err)
  const state = this.tx.started ? 'fiatTransactionError' : 'fiatError'
  this._timedState(state)
  return Promise.reject(err)
}

Brain.prototype._dispense = function _dispense () {
  if (commandLine.debugLogs)
    console.log('DEBUG: Attempting to dispense:', this.tx)
  return Promise.resolve()
    .then(() => {
      // safeguard against dispensing a broken tx record
      if (this.tx.cryptoAtoms.lte(0)) {
        throw new Error('Tried to dispense with 0 cryptoAtoms')
      }

      // check if dispense was already done
      if (this.tx.dispense || this.tx.dispenseConfirmed) {
        throw new Error('Already dispensed')
      }

      // mark this tx as dispense started
      return this.updateTx({ dispense: true })
    })

    // actual dispense
    .then(() => this._physicalDispense())

    // shit happens
    .catch(err => {
      console.log('_dispense error', err.stack)
      if (!this.billDispenser.initialized) {
        const cassettes = this.trader.cassettes
        const recyclers = this.trader.recyclers ?? []
        const originalCassettes = this.trader.originalCassettes
        const originalRecyclers = this.trader.originalRecyclers ?? []

        // puloonrs232 port closing code waits 100ms before closing
        setTimeout(() => {
          return this.billDispenser.init({
            cassettes,
            fiatCode: this.trader.locale.fiatCode,
            recyclers,
            originalCassettes,
            originalRecyclers
          })
        }, 200)
      }
      if (err.statusCode === INSUFFICIENT_FUNDS_CODE) return this._timedState('outOfCash')
      if (err.statusCode === SCORE_THRESHOLD_REACHED_CODE || err.statusCode === CIPHERTRACE_ERROR_CODE) return this.showBlockedCustomer()
      return this._fiatError(err)
    })
}

Brain.prototype._batchDispense = function _batchDispense (notesToDispense, { batchAmount, dispenseRecords, currentBatch, error }) {
  console.trace("notesToDispense", notesToDispense)
  // short circuit out if a error is found
  if (error) {
    return { dispenseRecords, error }
  }

  this.browser().send({ action: 'dispensing', dispenseBatch: { current: currentBatch, of: batchAmount } })
  const addDispensed = _.zipWith((a, b) => ({ dispensed: _.sumBy('dispensed', [a, b]), rejected: _.sumBy('rejected', [a, b]) }))

  return this.billDispenser.dispense(notesToDispense, currentBatch, batchAmount)
    .then(({ value, error }) => {
      const response = {
        batchAmount,
        batch: value,
        dispenseRecords: addDispensed(value, dispenseRecords),
        error,
        currentBatch: currentBatch + 1
      }

      // single batch dispense or error don't need to deal with other screens
      if (batchAmount === 1 || error) {
        return response
      }

      const screen = currentBatch === batchAmount ? 'dispensingCollect' : 'dispensingPartialCollect'
      this.browser().send({ action: screen, dispenseBatch: { current: currentBatch, of: batchAmount } })

      return this.billDispenser.waitForBillsRemoved()
        .then(() => response)
        .catch(error => _.assign(response, { error }))
    })
    .catch(error => ({ dispenseRecords, error }))
}

// handler that runs after all batches are dispensed
Brain.prototype._batchesFinished = function _batchesFinished ({ dispenseRecords, error }) {
  const tx = this.tx
  const bills = _.toArray(_.merge(tx.bills, dispenseRecords))
  console.trace("bills:", bills)

  const dispenseConfirmed = tx.fiat.eq(_.sumBy(it => it.denomination * it.dispensed, bills))
  if (dispenseConfirmed) emit({ action: 'billDispenserDispensed' })

  const fastUpdateTxEventDataErr = {
    error: error && _.join(' ', _.reject(_.isEmpty, [error.name, error.message, error.err, error.error, error.statusCode]))
  }

  const fastUpdateTxEventData = _.assign({ bills, dispenseConfirmed }, !dispenseConfirmed ? fastUpdateTxEventDataErr : {})
  this.fastUpdateTx(fastUpdateTxEventData)

  if (!dispenseConfirmed) {
    return this._timedState('outOfCash')
  }

  const toAddress = coinUtils.formatAddress(tx.cryptoCode, tx.toAddress)
  const displayTx = _.assign({ toAddress }, tx)

  this._transitionState('fiatComplete', { tx: displayTx, smsReceiptStatus: this.trader.smsReceiptActive && this.customer ? 'available' : 'disabled' })

  if (this.isAutomaticPrintActive()) this._startPrintReceipt()

  pDelay(COMPLETED_TIMEOUT).then(() => {
    emit({ action: 'billDispenserCollected' })
    if (tx.id !== _.get('id')(this.tx)) {
      return
    }
    return this._completed(tx.id)
  })
}

Brain.prototype._physicalDispense = function _physicalDispense () {
  const fiatCode = this.tx.fiatCode

  const notes = _.map(
    i => _.flow(
      _.get([i, 'provisioned']),
      _.defaultTo(0)
    )(this.tx.bills),
    _.range(0, this.trader.machineInfo.numberOfCassettes + this.trader.machineInfo.numberOfRecyclers)
  )

  if (fiatCode !== this.billDispenser.fiatCode) {
    console.log('Wrong dispenser currency; dispenser: %s, tx: %s',
      this.billDispenser.fiatCode, fiatCode)
    return this._timedState('wrongDispenserCurrency')
  }

  this._transitionState('dispensing')
  emit('billDispenserDispensing')

  const notesToDispense = optimizeDispense(notes, this.billDispenser.dispenseLimit)
  const batchAmount = notesToDispense.length

  const initialParams = {
    notesToDispense,
    batchAmount,
    currentBatch: 1,
    dispenseRecords: _.map(() => ({ dispensed: 0, rejected: 0 }), _.times(_.identity(), this.trader.machineInfo.numberOfCassettes + this.trader.machineInfo.numberOfRecyclers))
  }

  // creates a promise array that runs in waterfall mode (sequentially passing response down)
  // batchAmount of dispenses (batchDispense) plus a final handler (batchesFinished)
  const batches = notesToDispense.reduce((acc, notes) => acc.then(it => this._batchDispense(notes, it)), Promise.resolve(initialParams))

  // use anonymous function to pass down scope
  batches.then(it => this._batchesFinished(it))
    .catch(err => {
      console.log(err)
      return this._idle()
    })
}
/*
* 這個函式是用來處理發錢的更新狀態
* 
* 主要功能:
* 1. 先檢查交易金額是否超過零確認限制(zero confirmation limit)
* 2. 如果超過限制且沒有驗證資料(email或手機),就需要等待贖回(redeem)
* 3. 根據交易狀態(status)決定下一步:
*   - rejected: 交易被拒絕,進入合規驗證流程
*   - published: 交易已發布,等待發錢
*   - authorized/instant/confirmed: 可以直接發錢
*
* 參數說明:
* @param tx: 交易資料物件,包含:
*   - status: 交易狀態
*   - email: 使用者email(如果有的話)
*   - phone: 使用者手機(如果有的話)
*
* 重要變數說明:
* - overZeroConf: 是否超過零確認限制
* - needToRedeem: 是否需要等待贖回
* - isEmailAuth: 是否使用email驗證(不然就是手機驗證)
* - complianceData: 驗證資料(email或手機號碼)
*/

Brain.prototype._dispenseUpdate = function _dispenseUpdate (tx) {
  const overZeroConf = this.exceedsZeroConf(tx)
  const status = tx.status
  const needToRedeem = !_.includes(status, ['instant', 'confirmed']) && overZeroConf

  const isEmailAuth = this.trader.customerAuthentication === CUSTOMER_AUTHENTICATION.EMAIL
  const complianceData = isEmailAuth ? tx.email : tx.phone
  if (needToRedeem && complianceData) return this._redeemLater()

  if (needToRedeem) {
    console.log('WARNING: This shouldn\'t happen; over zero-conf limit and not secured')
    return this._idle()
  }

  switch (status) {
    case 'rejected':
      this.authCompliance({ returnState: 'redeemLater', reason: 'rejected_zero_conf' })
      break
    case 'published':
      this._transitionState('pendingDeposit')
      this._waitForDispense('published')
      break
    case 'authorized':
    case 'instant':
    case 'confirmed':
      this._dispense()
      break
  }
}

Brain.prototype._redeem = function _redeem () {
  this.redeem = true
  this.authCompliance()
}

Brain.prototype._fiatReceipt = function _fiatReceipt () {
  const tx = this.tx
  const toAddress = coinUtils.formatAddress(tx.cryptoCode, tx.toAddress)
  const displayTx = _.set('toAddress', toAddress, tx)

  this._timedState('fiatReceipt', {
    data: { tx: displayTx },
    timeout: 120000
  })
}
/**
 * 檢查某個動作是否需要"你確定要這樣做嗎?"的確認視窗
 * 
 * @param {string} action - 要檢查的動作名稱
 * @returns {boolean} - 如果需要確認視窗就回傳 true,不需要就回傳 false
 *
 * 這個函式會檢查兩種情況:
 * 1. 動作是否在 ARE_YOU_SURE_HANDLED 清單中
 * 2. 如果動作在 ARE_YOU_SURE_SMS_HANDLED 清單中,且目前的 complianceReason 
 *    也在 ARE_YOU_SURE_HANDLED_SMS_COMPLIANCE 清單中
 * 
 * 舉例來說:
 * - 如果使用者要取消交易,就會跳出確認視窗問"你確定要取消嗎?"
 * - 如果使用者要取消輸入手機號碼,也會跳出確認視窗
 */
Brain.prototype.areYouSureHandled = function areYouSureHandled (action) {
  return _.includes(action, ARE_YOU_SURE_HANDLED) ||
    (_.includes(action, ARE_YOU_SURE_SMS_HANDLED) &&
      _.includes(this.complianceReason, ARE_YOU_SURE_HANDLED_SMS_COMPLIANCE))
}

/**
 * 當使用者要做一些重要的動作時(例如取消交易),會跳出"你確定嗎?"的確認視窗
 * 
 * 這個函式會:
 * 1. 記住目前的狀態(currentState)
 * 2. 設定一個計時器,如果使用者沒有回應,就會自動取消交易
 * 3. 把畫面切換到 areYouSure 的確認視窗
 * 
 * 舉例:
 * - 使用者按下取消交易按鈕
 * - 系統會記住目前在哪個畫面
 * - 跳出"你確定要取消嗎?"的視窗
 * - 如果使用者沒有回應,就會自動取消交易
 * - 如果使用者點選確定或取消,就會根據選擇執行對應的動作
 */
Brain.prototype.areYouSure = function areYouSure () {
  const currentState = this.state
  const timeoutHandler = () => this.cancelTransaction(currentState)
  this._timedState('areYouSure', { timeoutHandler })
}

Brain.prototype.continueTransaction = function continueTransaction (previousState) {
  if (previousState === 'deposit') return this.toDeposit()
  this._timedState(previousState)
}

Brain.prototype.cancelTransaction = function cancelTransaction (previousState) {
  switch (previousState) {
    case 'deposit':
      this.trader.cancelDispense(this.tx)
      this._idle()
      break
    case 'security_code':
    case 'register_phone':
      if (this.flow) {
        this.returnState = null
        this.flow.handle('cancelPhoneNumber')
      }
      break
    default :
      this.trader.cancelDispense(this.tx)
      this._idle()
  }
}

Brain.prototype.ratesScreen = function () {
  const coins = _.map(it => it.cryptoCode, this.trader.coins)
  const rates = _.reduce((acc, value) => Object.assign({ [value]: _.mapValues(it => it.toString(), this.trader.rates(value)) }, acc), {}, coins)

  this._transitionState('rates', { allRates: rates, ratesFiat: this.trader.locale.fiatCode })
}

Brain.prototype.browser = function browser () {
  return this.browserObj
}

Brain.prototype.setBrowser = function setBrowser (obj) {
  this.browserObj = obj
}

function startsWithUSB (file) {
  return file.indexOf('ttyUSB') === 0
}

// 這個函數用來將 USB 設備的系統路徑轉換成實際的設備路徑
// 例如: 將 /sys/bus/usb/devices/1-1 轉換成 /dev/ttyUSB0
// 
// 參數說明:
// path: USB 設備的系統路徑，通常以 /sys/ 開頭
//
// 回傳值:
// - 如果轉換成功，回傳實際的設備路徑 (例如: /dev/ttyUSB0)
// - 如果轉換失敗，回傳 null
// - 如果輸入的不是系統路徑，直接回傳原本的路徑
function determineDevicePath (path) {
  if (!path || path.indexOf('/sys/') !== 0) return path
  try {
    const files = fs.readdirSync(path)
    const device = _.find(startsWithUSB, files)
    return device ? '/dev/' + device : null
  } catch (e) {
    console.log('hub path not connected: ' + path)
    return null
  }
}

function uuid4Validate(uuidString) {
  return uuid.validate(uuidString) && uuid.version(uuidString) === 4
}

module.exports = Brain
