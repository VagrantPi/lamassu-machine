'use strict';

const cp = require('child_process');
const fs = require('fs');
const { mkdir, writeFile } = require('fs/promises');
const path = require('path');
const async = require('./async');
const report = require('./report').report;

const hardwareCode = process.argv[2];
const machineCode = process.argv[3];
const newPath = process.argv[4];

const basePath = newPath ? '/opt/lamassu-updates/extract' : '/tmp/extract'
const packagePath = `${basePath}/package/subpackage`

const machineWithMultipleCodes = ['upboard', 'up4000', 'coincloud', 'generalbytes', 'genmega']

const hardwarePath = machineWithMultipleCodes.includes(hardwareCode) ?
  `${packagePath}/hardware/${hardwareCode}/${machineCode}` :
  `${packagePath}/hardware/${hardwareCode}`

const supervisorPath = machineWithMultipleCodes.includes(hardwareCode) ?
  `${packagePath}/supervisor/${hardwareCode}/${machineCode}` :
  `${packagePath}/supervisor/${hardwareCode}`

const udevPath = `${packagePath}/udev/aaeon`

const TIMEOUT = 600000;
const applicationParentFolder = hardwareCode === 'aaeon' ? '/opt/apps/machine' : '/opt'

const LOG = msg => report(null, msg, () => {})
const ERROR = err => report(err, null, () => {})

function command(cmd, cb) {
  LOG(`Running command \`${cmd}\``)
  cp.exec(cmd, {timeout: TIMEOUT}, function(err) {
    cb(err);
  });
}

const isLMX = () =>
  fs.readFileSync('/etc/os-release', { encoding: 'utf8' })
    .split('\n')
    .includes('IMAGE_ID=lamassu-machine-xubuntu')

const getOSUser = () => {
  try {
    return (!machineWithMultipleCodes.includes(hardwareCode) || isLMX()) ? 'lamassu' : 'ubilinux'
  } catch (err) {
    return 'ubilinux'
  }
}

function updateUdev (cb) {
  LOG("Updating udev rules")
  if (hardwareCode !== 'aaeon') return cb()
  return async.series([
    async.apply(command, `cp ${udevPath}/* /etc/udev/rules.d/`),
    async.apply(command, 'udevadm control --reload-rules'),
    async.apply(command, 'udevadm trigger'),
  ], (err) => {
    if (err) throw err;
    cb()
  })
}

function updateSupervisor (cb) {
  LOG("Updating Supervisor services")
  if (hardwareCode === 'aaeon') return cb()

  const getServices = () => {
    const extractServices = stdout => {
      const services = stdout
        .split('\n')
        .flatMap(line => {
          const service = line.split(' ', 1)?.[0]
          return (!service || service === 'lamassu-watchdog') ? [] : [service]
        })
        .join(' ')
      /*
       * NOTE: Keep old behavior in case we don't get the expected output:
       * update and restart all services. result:finished won't work.
       */
      return services.length > 0 ? services : 'all'
    }

    try {
      const stdout = cp.execFileSync("supervisorctl", ["status"], { encoding: 'utf8', timeout: 10000 })
      return extractServices(stdout)
    } catch (err) {
      return err.status === 3 ?
        extractServices(err.stdout) :
        'all' /* NOTE: see note above */
    }
  }

  const osuser = getOSUser()
  const services = getServices()

  async.series([
    async.apply(command, `cp ${supervisorPath}/* /etc/supervisor/conf.d/`),
    async.apply(command, `sed -i 's|^user=.*\$|user=${osuser}|;' /etc/supervisor/conf.d/lamassu-browser.conf || true`),
    async.apply(command, `supervisorctl update ${services}`),
    async.apply(command, `supervisorctl restart ${services}`),
  ], err => {
    if (err) throw err;
    cb()
  })
}

const updateSystemd = cb => {
  LOG("Make Supervisor start after X")
  const override = dm => `[Unit]\nAfter=${dm}.service\nWants=${dm}.service\n`
  const SUPERVISOR_OVERRIDE = "/etc/systemd/system/supervisor.service.d/override.conf"
  return mkdir(path.dirname(SUPERVISOR_OVERRIDE), { recursive: true })
    .then(() => isLMX() ? 'lightdm' : 'sddm') // Assume Ubilinux if not l-m-x
    .then(dm => writeFile(SUPERVISOR_OVERRIDE, override(dm), { mode: 0o600, flush: true }))
    .then(() => new Promise((resolve, reject) =>
      cp.execFile('systemctl', ['daemon-reload'], { timeout: 10000 },
        (error, _stdout, _stderr) => error ? reject(error) : resolve()
      )
    ))
    .then(() => cb())
    .catch(err => cb(err))
}

function restartWatchdogService (cb) {
  async.series([
    async.apply(command, 'supervisorctl update lamassu-watchdog'),
    async.apply(command, 'supervisorctl restart lamassu-watchdog'),
  ], err => {
    if (err) throw err;
    cb()
  })
}

function updateAcpChromium (cb) {
  LOG("Updating ACP Chromium")
  if (hardwareCode !== 'aaeon') return cb()
  return async.series([
    async.apply(command, `cp ${hardwarePath}/sencha-chrome.conf /home/iva/.config/upstart/`),
    async.apply(command, `cp ${hardwarePath}/start-chrome /home/iva/`),
  ], function(err) {
    if (err) throw err;
    cb()
  });
}

function installDeviceConfig (cb) {
  LOG("Installing `device_config.json`")
  try {
    const currentDeviceConfigPath = `${applicationParentFolder}/lamassu-machine/device_config.json`
    const newDeviceConfigPath = `${hardwarePath}/device_config.json`

    // Updates don't necessarily need to carry a device_config.json file
    if (!fs.existsSync(newDeviceConfigPath)) return cb()

    const currentDeviceConfig = require(currentDeviceConfigPath)
    const newDeviceConfig = require(newDeviceConfigPath)

    if (currentDeviceConfig.frontFacingCamera) {
      newDeviceConfig.frontFacingCamera = currentDeviceConfig.frontFacingCamera
    }
    if (currentDeviceConfig.scanner) {
      newDeviceConfig.scanner = currentDeviceConfig.scanner
    }
    if (currentDeviceConfig.machineLocation) {
      newDeviceConfig.machineLocation = currentDeviceConfig.machineLocation
    }
    if (currentDeviceConfig.cryptomatModel) {
      newDeviceConfig.cryptomatModel = currentDeviceConfig.cryptomatModel
    }
    if (currentDeviceConfig.billDispenser && newDeviceConfig.billDispenser) {
      newDeviceConfig.billDispenser.model = currentDeviceConfig.billDispenser.model
      newDeviceConfig.billDispenser.device = currentDeviceConfig.billDispenser.device
      newDeviceConfig.billDispenser.cassettes = currentDeviceConfig.billDispenser.cassettes
    }
    if (currentDeviceConfig.billValidator) {
      newDeviceConfig.billValidator.deviceType = currentDeviceConfig.billValidator.deviceType
      if (currentDeviceConfig.billValidator.rs232) {
        newDeviceConfig.billValidator.rs232.device = currentDeviceConfig.billValidator.rs232.device
      }
    }
    if (currentDeviceConfig.kioskPrinter) {
      newDeviceConfig.kioskPrinter.model = currentDeviceConfig.kioskPrinter.model
      newDeviceConfig.kioskPrinter.address = currentDeviceConfig.kioskPrinter.address

      if (currentDeviceConfig.kioskPrinter.maker) {
        newDeviceConfig.kioskPrinter.maker = currentDeviceConfig.kioskPrinter.maker
      }

      if (currentDeviceConfig.kioskPrinter.protocol) {
        newDeviceConfig.kioskPrinter.protocol = currentDeviceConfig.kioskPrinter.protocol
      }
    }
    if (currentDeviceConfig.compliance) {
      newDeviceConfig.compliance = currentDeviceConfig.compliance
    }

    // Pretty-printing the new configuration to retain its usual form.
    const adjustedDeviceConfig = JSON.stringify(newDeviceConfig, null, 2)
    fs.writeFileSync(currentDeviceConfigPath, adjustedDeviceConfig)

    return cb()
  } catch (err) {
    return cb(err)
  }
}

const upgrade = () => {
  const arch = hardwareCode === 'aaeon' ? '386' :
    hardwareCode === 'ssuboard' ? 'arm32' :
    'amd64'

  const commands = [
    async.apply(command, `tar zxf ${basePath}/package/subpackage.tgz -C ${basePath}/package/`),
    async.apply(command, `rm -rf ${applicationParentFolder}/lamassu-machine/node_modules/`),
    async.apply(command, `cp -PR ${basePath}/package/subpackage/lamassu-machine ${applicationParentFolder}`),
    async.apply(command, `cp -PR ${basePath}/package/subpackage/hardware/${hardwareCode}/node_modules ${applicationParentFolder}/lamassu-machine/`),
    async.apply(command, `mv ${applicationParentFolder}/lamassu-machine/verify/verify.${arch} ${applicationParentFolder}/lamassu-machine/verify/verify`),
    async.apply(command, `mv ${applicationParentFolder}/lamassu-machine/camera-streamer/camera-streamer.${arch} ${applicationParentFolder}/lamassu-machine/camera-streamer/camera-streamer`),
    async.apply(installDeviceConfig),
    async.apply(updateSupervisor),
    async.apply(updateSystemd),
    async.apply(updateUdev),
    async.apply(updateAcpChromium),
    async.apply(report, null, 'finished.'),
    async.apply(restartWatchdogService),
  ]

  return new Promise((resolve, reject) => {
    async.series(commands, function(err) {
      if (err) {
        ERROR(err)
        return reject(err)
      } else {
        return resolve()
      }
    });
  })
}

module.exports = { upgrade }
