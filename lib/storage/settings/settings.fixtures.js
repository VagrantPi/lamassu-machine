const timezone = new Date()

const dbFormat = {
  coins: [{
    cryptoCode: 'BTC',
    cryptoCodeDisplay: 'BTC',
    display: 'BTC',
    minimumTx: '0.0001',
    cashInFee: '0.01',
    cashInCommission: '0.01',
    cashOutCommission: '0.01',
    cryptoNetwork: 'BTC',
    cryptoUnits: 'BTC',
    batchable: true,
    isCashInOnly: false
  }],
  locales: ['en'],
  operatorInfo: {
    active: true,
    name: 'name',
    phone: 'phone',
    email: 'email',
    website: 'website',
    companyNumber: 'companyNumber'
  },
  receiptOptions: { random: true, field: true },
  speedtestFiles: [{ url: 'url', size: 1 }],
  staticConfig: {
    version: 1,
    enablePaperWalletOnly: true,
    hasLightning: true,
    serverVersion: '1.0.0',
    timezone: timezone.getTime(),
    twoWayMode: true,
    customerAuthentication: 'EMAIL',
    country: 'Portugal',
    fiatCode: 'EUR',
    primaryLocale: 'en-EN',
    deviceName: 'deviceName',
    numberOfCassettes: 1,
    numberOfRecyclers: 1,
    paperReceipt: true,
    smsReceipt: true
  },
  terms: {
    hash: 'hash',
    title: 'title',
    text: 'text',
    accept: 'accept',
    cancel: 'cancel',
    active: true,
    tcPhoto: true,
    delay: true
  },
  triggersAutomation: { test: 'Automatic', otherTest: 'Manual' },
  triggers: [{
    id: '1',
    direction: 'direction',
    requirement: 'requirement',
    triggerType: 'triggerType',
    suspensionDays: 1,
    threshold: 1,
    thresholdDays: 1,
    externalService: 'test',
    customInfoRequest: null,
  }],
  urlsToPing: ['url']
}

const save = {
  terms: {
    active: true,
    text: 'text',
    hash: 'hash',
    title: 'title',
    accept: 'accept',
    cancel: 'cancel',
    tcPhoto: true,
    delay: true
  },
  coins: dbFormat.coins,
  operatorInfo: {
    name: 'name',
    phone: 'phone',
    email: 'email',
    website: 'website',
    companyNumber: 'companyNumber'
  },
  locales: {
    country: 'Portugal',
    locales: ['en'],
    fiatCode: 'EUR',
    primaryLocale: 'en-EN'
  },
  staticConfig: {
    version: 1,
    enablePaperWalletOnly: true,
    hasLightning: true,
    serverVersion: '1.0.0',
    timezone,
    twoWayMode: true,
    customerAuthentication: 'EMAIL',
    paperReceipt: true,
    smsReceipt: true
  },
  machineInfo: {
    deviceName: 'deviceName',
    numberOfCassettes: 1,
    numberOfRecyclers: 1
  },
  receiptOptions: { random: true, field: true },
  speedtestFiles: [{ url: 'url', size: 1 }],
  triggers: dbFormat.triggers,
  triggersAutomation: { test: 'Automatic', otherTest: 'Manual' },
  urlsToPing: ['url']
}

const triggerWithCustomInfo = {
  ...dbFormat.triggers[0],
  customInfoRequest: {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    enabled: true,
    customRequest: {
      name: 'ID Verification',
      input: {
        type: 'text',
        constraintType: 'ssn',
        label1: 'Please enter your SSN',
        label2: 'SSN format: XXX-XX-XXXX',
        choiceList: ['Option 1', 'Option 2', 'Option 3']
      },
      screen1: {
        title: 'ID Verification Required',
        text: 'Please provide your identification'
      },
      screen2: {
        title: 'Verification Complete',
        text: 'Thank you for verifying your identity'
      }
    }
  }
}

export { dbFormat, save, triggerWithCustomInfo }