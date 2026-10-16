import assert from 'node:assert/strict'
import test from 'node:test'
import { createBusinessScenario, matchesBusinessAnswer } from '../scripts/claude-scenarios.mjs'

test('a correct business JSON result may include calculation notes outside its single code block', () => {
  const scenario = createBusinessScenario('text')
  const response = '```json\n{"itemSubtotalCents":44300,"amountDueCents":43500}\n```\n\n商品小计为 44300 分，加运费后减去优惠，应付 43500 分。'
  assert.equal(matchesBusinessAnswer(scenario, response), true)
  assert.equal(matchesBusinessAnswer(scenario, response.replace('"amountDueCents":43500', '"amountDueCents":45500')), false)
  assert.equal(matchesBusinessAnswer(scenario, `${response}\n\n${response}`), false)
})

test('business checks validate record values and a relevant Chinese title, not just a completed response', () => {
  assert.equal(matchesBusinessAnswer(createBusinessScenario('text', 1), '{"category":"payment","priority":"high","nextAction":"reconcile_payment"}'), true)
  assert.equal(matchesBusinessAnswer(createBusinessScenario('text', 2), '{"availableUnits":48,"reorderUnits":51}'), true)
  assert.equal(matchesBusinessAnswer(createBusinessScenario('image'), '{"color":"red","label":"红色"}'), true)
  assert.equal(matchesBusinessAnswer(createBusinessScenario('image'), '{"color":"blue","label":"蓝色"}'), false)
  assert.equal(matchesBusinessAnswer(createBusinessScenario('title'), '仓库发货与缺货补货安排'), true)
  assert.equal(matchesBusinessAnswer(createBusinessScenario('title'), '你好'), false)
})
