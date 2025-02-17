'use strict';
const { createHash } = require('crypto')
const { readFile } = require('fs/promises')
const { join } = require('path')

const LAMASSU_MACHINE = "/opt/lamassu-machine"

const computeMachineID = dataPath =>
  readFile(join(LAMASSU_MACHINE, dataPath, "client.pem"), { encoding: 'utf8' })
    .then(cert => cert.split('\r\n'))
    .then(cert => Buffer.from(cert.slice(1, cert.length-2).join(''), 'base64'))
    .then(raw => createHash('sha256').update(raw).digest('hex'))

readFile(join(LAMASSU_MACHINE, "device_config.json"), { encoding: 'utf8' })
.then(JSON.parse)
.then(device_config => device_config?.brain?.dataPath ?? 'data')
.then(computeMachineID)
.then(console.log)
.catch(console.log)
