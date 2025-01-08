import { expect, test as _test, describe, beforeAll } from 'vitest'
import { dbFormat, save, triggerWithCustomInfo } from './settings.fixtures'

import { loadConfig, loadMachineInfo, saveTerms, saveConfig } from './settings'

// db has to required because require and import use different caches
// if import db here it will be a different instance than the one in settings.js
const db = require('./db')

const test = _test.extend({
  dbFormat,
  save,
  triggerWithCustomInfo
})

beforeAll(async () => {
  await db.migrate.latest()
})

describe('on empty db', () => {
  test('load config should return null', async () => {
    const config = await loadConfig()
    expect(config).toBeNull()
  })

  describe('load machine info', () => {
    test('should be inactive by default', async () => {
      const machineInfo = await loadMachineInfo()
      expect(machineInfo).toEqual({ active: false })
    })
  })
})

describe('terms and conditions', () => {
  test('should fail without static config', async ({ save: { terms } }) => {
    await saveTerms(terms)
    const config = await loadConfig() 
    expect(config).toBeNull()
  })

  test('should work with static config', async ({ save: { terms, ...config } }) => {
    await saveConfig(config)
    await saveTerms(terms)
    const newConfig = await loadConfig()
    expect(newConfig.terms).toEqual(terms)
  })
  test('should insert terms', async ({ save: { terms } }) => {
    await saveTerms(terms)
    const { terms: dbTerms } = await loadConfig()
    expect(dbTerms).toEqual(terms)
  })
  test('should override terms', async ({ save: { terms }}) => {
    const newTerms = { ...terms, hash: 'hash2' }
    await saveTerms(newTerms)
    const { terms: dbTerms } = await loadConfig()
    expect(dbTerms).toEqual(newTerms)
  })
  test('should disable terms', async () => {
    await saveTerms({ active: false })
    const { terms: dbTerms } = await loadConfig()
    expect(dbTerms).toEqual({ active: false })
  })
  test('should delete terms', async () => {
    await saveTerms(null)
    const { terms: dbTerms } = await loadConfig()
    expect(dbTerms).toEqual({ active: false })
  })
})

describe('filled db', () => {
  test('should save config', async ({ save, dbFormat }) => {
    await saveConfig(save)
    const config = await loadConfig()
    expect(config).toEqual(dbFormat)
  })
})

describe('triggers', () => {
  test('should save triggers with custom info requests', async ({ save }) => {

    await saveConfig({ ...save, triggers: [triggerWithCustomInfo] })
    const { triggers } = await loadConfig()

    expect(triggers[0]).toMatchObject(triggerWithCustomInfo)
  })

  test('should update existing triggers', async ({ save }) => {
    await saveConfig(save)
    const updatedTriggers = [{
      ...save.triggers[0],
      threshold: 2000,
      suspensionDays: 60
    }]

    await saveConfig({ ...save, triggers: updatedTriggers })
    const { triggers } = await loadConfig()
    expect(triggers[0].threshold).toBe(2000)
    expect(triggers[0].suspensionDays).toBe(60)
  })

  test('should delete all triggers when empty array provided', async ({ save }) => {
    await saveConfig(save)
    await saveConfig({ ...save, triggers: [] })
    const { triggers } = await loadConfig()
    expect(triggers).toHaveLength(0)
  })
})

describe('locales', () => {
  test('should handle multiple locales', async ({ save }) => {
    const multiLocales = {
      ...save.locales,
      locales: ['en', 'es', 'fr']
    }

    await saveConfig({ ...save, locales: multiLocales })
    const { locales } = await loadConfig()
    expect(locales).toHaveLength(3)
    expect(locales).toContain('en')
    expect(locales).toContain('es')
    expect(locales).toContain('fr')
  })

  test('should update primary locale in static config', async ({ save }) => {
    const newLocales = {
      ...save.locales,
      primaryLocale: 'fr-FR'
    }

    await saveConfig({ ...save, locales: newLocales })
    const { staticConfig } = await loadConfig()
    expect(staticConfig.primaryLocale).toBe('fr-FR')
  })
})

describe('operator info', () => {
  test('should update existing operator info', async ({ save }) => {
    await saveConfig(save)
    const updatedInfo = {
      ...save.operatorInfo,
      name: 'Updated Name',
      email: 'new@email.com'
    }

    await saveConfig({ ...save, operatorInfo: updatedInfo })
    const { operatorInfo } = await loadConfig()
    expect(operatorInfo.name).toBe('Updated Name')
    expect(operatorInfo.email).toBe('new@email.com')
  })
})

describe('coins', () => {
  test('should update commission rates', async ({ save }) => {
    const updatedCoins = [{
      ...save.coins[0],
      cashInCommission: '0.02',
      cashOutCommission: '0.03'
    }]

    await saveConfig({ ...save, coins: updatedCoins })
    const { coins } = await loadConfig()
    expect(coins[0].cashInCommission).toBe('0.02')
    expect(coins[0].cashOutCommission).toBe('0.03')
  })
})

describe('machine info', () => {
  test('should update machine configuration', async ({ save }) => {
    const newMachineInfo = {
      ...save.machineInfo,
      numberOfCassettes: 2,
      numberOfRecyclers: 1
    }

    await saveConfig({ ...save, machineInfo: newMachineInfo })
    const machineInfo = await loadMachineInfo()
    expect(machineInfo.numberOfCassettes).toBe(2)
    expect(machineInfo.numberOfRecyclers).toBe(1)
  })

  test('should handle device name updates', async ({ save }) => {
    const newMachineInfo = {
      ...save.machineInfo,
      deviceName: 'ATM-001'
    }

    await saveConfig({ ...save, machineInfo: newMachineInfo })
    const machineInfo = await loadMachineInfo()
    expect(machineInfo.deviceName).toBe('ATM-001')
  })
})

describe('receipt options', () => {
  test('should toggle multiple receipt options', async ({ save }) => {
    const newReceiptOptions = {
      random: false,
      field: true,
      newOption: true
    }

    await saveConfig({ ...save, receiptOptions: newReceiptOptions })
    const { receiptOptions } = await loadConfig()
    expect(receiptOptions.random).toBe(false)
    expect(receiptOptions.field).toBe(true)
    expect(receiptOptions.newOption).toBe(true)
  })

  test('should handle empty receipt options', async ({ save }) => {
    await saveConfig({ ...save, receiptOptions: {} })
    const { receiptOptions } = await loadConfig()
    expect(receiptOptions).toEqual({})
  })
})

describe('error handling', () => {
  test('should rollback transaction on error', async ({ save }) => {
    const invalidConfig = {
      ...save,
      coins: [
        save.coins[0],
        {
        invalidField: 'value'
      }]
    }

    await expect(saveConfig(invalidConfig)).rejects.toThrow()
    const config = await loadConfig()
    expect(config.coins).toHaveLength(1)
  })
})
