/*
* @param { import("knex").Knex } knex
* @returns { Promise<void> }
*
*/
exports.up = function (knex) {
  return knex.schema
    .createTable('staticConfig', function (table) {
      table.integer('version').notNullable()
      table.boolean('enablePaperWalletOnly').notNullable()
      table.boolean('hasLightning').notNullable()
      table.text('serverVersion').notNullable()
      table.timestamp('timezone').notNullable()
      table.boolean('twoWayMode').notNullable()
      table.text('customerAuthentication')
        .checkIn(['EMAIL', 'SMS'])
        .notNullable()

      // LocaleInfo
      table.text('country').notNullable()
      table.text('fiatCode').notNullable()
      table.text('primaryLocale').notNullable()

      // MachineInfo
      table.text('deviceName').notNullable()
      table.integer('numberOfCassettes').notNullable()
      table.integer('numberOfRecyclers').notNullable()

      // ReceiptInfo
      table.boolean('paperReceipt').notNullable()
      table.boolean('smsReceipt').notNullable()
    })
    .createTable('urlsToPing', function (table) {
      table.text('url').notNullable()
    })
    .createTable('speedtestFiles', function (table) {
      table.text('url').notNullable()
      table.integer('size').notNullable()
    })
    .createTable('terms', function (table) {
      table.text('hash').primary().notNullable()
      table.text('title').notNullable()
      table.text('text').notNullable()
      table.text('accept').notNullable()
      table.text('cancel').notNullable()
      table.boolean('active').notNullable()
      table.boolean('tcPhoto').notNullable()
      table.boolean('delay').notNullable()
    })
    .createTable('triggersAutomation', function (table) {
      table.text('triggerType').primary().notNullable()
      table.text('automationType')
        .checkIn(['Automatic', 'Manual'])
        .notNullable()
    })
    .createTable('locales', function (table) {
      table.text('locale').primary().notNullable()
    })
    .createTable('coins', function (table) {
      table.text('cryptoCode').primary().notNullable()
      table.text('cryptoCodeDisplay').notNullable()
      table.text('display').notNullable()
      table.text('minimumTx').notNullable()
      table.text('cashInFee').notNullable()
      table.text('cashInCommission').notNullable()
      table.text('cashOutCommission').notNullable()
      table.text('cryptoNetwork').notNullable()
      table.text('cryptoUnits').notNullable()
      table.boolean('batchable').notNullable()
      table.boolean('isCashInOnly').notNullable()
    })
    .createTable('operatorInfo', function (table) {
      table.text('name').notNullable()
      table.text('phone').notNullable()
      table.text('email').notNullable()
      table.text('website').notNullable()
      table.text('companyNumber').notNullable()
    })
    .createTable('receiptOptions', function (table) {
      table.text('field').notNullable()
      table.boolean('enabled').notNullable()
    })
    .createTable('customInputs', function (table) {
      table.integer('rowid').primary()
      table.text('type').notNullable()
      table.text('constraintType').notNullable()
      table.text('label1')
      table.text('label2')
    })
    .createTable('customInputChoiceList', function (table) {
      table.integer('customInput').notNullable()
      table.text('choiceText').notNullable()
      table.foreign('customInput')
        .references('customInputs.rowid')
        .onDelete('CASCADE')
    })
    .createTable('customScreen', function (table) {
      table.integer('rowid').primary()
      table.text('text').notNullable()
      table.text('title').notNullable()
    })
    .createTable('customRequests', function (table) {
      table.integer('rowid').primary()
      table.text('name').notNullable()
      table.integer('input').notNullable()
      table.integer('screen1').notNullable()
      table.integer('screen2').notNullable()
      table.foreign('input')
        .references('customInputs.rowid')
        .onDelete('CASCADE')
      table.foreign('screen1')
        .references('customScreen.rowid')
        .onDelete('CASCADE')
      table.foreign('screen2')
        .references('customScreen.rowid')
        .onDelete('CASCADE')
    })
    .createTable('customInfoRequests', function (table) {
      table.text('id').primary().notNullable()
      table.boolean('enabled').notNullable()
      table.integer('customRequest').notNullable()
      table.foreign('customRequest')
        .references('customRequests.rowid')
        .onDelete('CASCADE')
    })
    .createTable('triggers', function (table) {
      table.text('id').primary().notNullable()
      table.text('direction').notNullable()
      table.text('requirement').notNullable()
      table.text('triggerType').notNullable()

      table.float('suspensionDays')
      table.integer('threshold')
      table.integer('thresholdDays')
      table.text('customInfoRequest')
      table.text('externalService')

      table.foreign('customInfoRequest')
        .references('customInfoRequests.id')
        .onDelete('CASCADE')
    })
}

/*
* @param { import("knex").Knex } knex
* @returns { Promise<void> }
*/
exports.down = function (knex) {
  knex.schema
    .dropTable('staticConfig')
    .dropTable('urlsToPing')
    .dropTable('speedtestFiles')
    .dropTable('terms')
    .dropTable('triggersAutomation')
    .dropTable('locales')
    .dropTable('coins')
    .dropTable('operatorInfo')
    .dropTable('receiptOptions')
    .dropTable('customInputs')
    .dropTable('customInputChoiceList')
    .dropTable('customScreen')
    .dropTable('customRequests')
    .dropTable('customInfoRequests')
    .dropTable('triggers')
}