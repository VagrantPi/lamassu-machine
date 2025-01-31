import { expect, test } from 'vitest'
import { check, model, solve } from './coin-change'

test.each([
  [765, [[50, 123], [10, 456], [5, 789]]],
  [4320, [[5, 999], [10, 998], [20, 997], [50, 996]]],
  [20, [[20, 10], [50, 10]]],
  [50, [[20, 10], [50, 10]]],
  [70, [[20, 10], [50, 10]]],
  [100, [[20, 10], [50, 10]]],
  [110, [[20, 10], [50, 10]]],
  [120, [[20, 10], [50, 10]]],
  [150, [[20, 10], [50, 10]]],
  [170, [[20, 10], [50, 10]]],
  [20, [[50, 10], [20, 10]]],
  [50, [[50, 10], [20, 10]]],
  [70, [[50, 10], [20, 10]]],
  [100, [[50, 10], [20, 10]]],
  [110, [[50, 10], [20, 10]]],
  [120, [[50, 10], [20, 10]]],
  [150, [[50, 10], [20, 10]]],
  [170, [[50, 10], [20, 10]]],
])("should solve %i with %o", (target, denominations) => {
    const M = model(denominations)
    const solution = solve(M, target)
    expect(check(solution, target)).toBe(true)
    expect(!!solution).toBe(true)
})

test.each([
  [767, [[50, 123], [10, 456], [5, 789]]],
  [1000, [[50, 1], [10, 2], [5, 3]]],
  [10, [[20, 10], [50, 10]]],
  [10, [[50, 10], [20, 10]]],
])("should not solve %i with %o", (target, denominations) => {
    const M = model(denominations)
    const solution = solve(M, target)
    expect(check(solution, target)).toBe(true)
    expect(!!solution).toBe(false)
})
