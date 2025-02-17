const pickClass = ({ deviceType }, mock) => {
  if (mock) {
    switch (deviceType) {
      case 'hcm2': return require('./mocks/hcm2/hcm2')
      case 'gsr50': return require('./mocks/gsr50/gsr50')
      default: return require('./mocks/id003')
    }
  }

  switch (deviceType) {
    case 'genmega': return require('./genmega/genmega-validator/genmega-validator')
    case 'cashflowSc': return require('./mei/cashflow_sc')
    case 'bnrAdvance': return require('./mei/bnr_advance')
    case 'ccnet': return require('./ccnet/ccnet')
    case 'hcm2': return require('./hcm2/hcm2')
    case 'gsr50': return require('./gsr50/gsr50')
    default: return require('./id003/id003')
  }
}

const load = (deviceConfig, mock = false) => {
  const validatorClass = pickClass(deviceConfig, mock)
  return validatorClass.factory(deviceConfig)
}

module.exports = { load }
