/** Synthetic business records with checkable answers; no external side effects. */
export const CLAUDE_SCENARIO_VERSION = 'business-v1'

const TEXT_CASES = [
  {
    id: 'order-total',
    prompt: '请核对一张采购订单：键盘 2 件，单价 19900 分；鼠标 1 件，单价 4500 分；运费 1200 分；整单优惠 2000 分。请计算商品小计和应付总额，返回 JSON，字段为 itemSubtotalCents、amountDueCents，金额使用整数分。',
    expected: { itemSubtotalCents: 44300, amountDueCents: 43500 },
  },
  {
    id: 'support-triage',
    prompt: '请按规则整理客服工单。规则：付款后未生成订单归为 payment 类；客户已扣款且无法使用服务时优先级为 high；下一步动作为 reconcile_payment。工单：客户反馈支付成功、银行卡已扣款，但订单列表为空，服务也无法使用。返回 JSON，字段为 category、priority、nextAction。',
    expected: { category: 'payment', priority: 'high', nextAction: 'reconcile_payment' },
  },
  {
    id: 'replenishment-plan',
    prompt: '请计算仓库的补货建议：当前库存 57 件，已预留 9 件；日均销量 12 件，采购提前期 7 天，安全库存 15 件。可用库存为当前库存减预留，目标库存为日均销量乘提前期加安全库存，补货量为目标库存减可用库存（最小为零）。返回 JSON，字段为 availableUnits、reorderUnits。',
    expected: { availableUnits: 48, reorderUnits: 51 },
  },
]

const STOCK = [
  { sku: 'KB-87', onHand: 42, reserved: 7, requested: 50 },
  { sku: 'MS-24', onHand: 16, reserved: 4, requested: 8 },
  { sku: 'USB-C-2M', onHand: 63, reserved: 12, requested: 70 },
]
/** DSH's plan-mode exit tool, as the plan-mode plugin registers it. */
export const EXIT_PLAN_TOOL = {
  name: 'exit_plan_mode', description: "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode.",
  parameters: { type: 'object', properties: { plan: { type: 'string', description: 'The complete plan, as markdown, starting with a # heading that names it.' } }, required: ['plan'], additionalProperties: false },
}
/** The guidance DSH's plan mode adds to the system prompt while it is active. */
export const PLAN_POLICY = 'Plan mode is active. Explore read-only with the available tools, do not change anything, then present the complete implementation plan with exit_plan_mode. Implementation starts only after the user approves.'
const INVENTORY_TOOL = {
  name: 'lookup_inventory', description: '查询商品库存及已预留数量。只读操作，不修改库存。',
  parameters: { type: 'object', properties: { sku: { type: 'string', description: '商品 SKU' } }, required: ['sku'], additionalProperties: false },
}

export function createBusinessScenario(kind, variant = 0) {
  if (!Number.isSafeInteger(variant) || variant < 0) throw new Error('Business scenario variant must be a nonnegative integer')
  if (kind === 'text') return { ...TEXT_CASES[variant % TEXT_CASES.length] }
  if (kind === 'tool') {
    const stock = STOCK[variant % STOCK.length]
    const available = stock.onHand - stock.reserved
    return {
      id: `stock-fulfillment-${stock.sku}`,
      prompt: `请查询商品 ${stock.sku} 的库存，计算一张 ${stock.requested} 件订单的缺货量。库存必须以 lookup_inventory 的查询结果为准；可用量为库存减已预留量。返回 JSON，字段为 sku、availableUnits、shortageUnits，缺货量最小为零。`,
      tools: [INVENTORY_TOOL], toolArguments: { sku: stock.sku },
      toolResult: { sku: stock.sku, onHand: stock.onHand, reserved: stock.reserved },
      expected: { sku: stock.sku, availableUnits: available, shortageUnits: Math.max(0, stock.requested - available) },
    }
  }
  if (kind === 'image') return {
    id: 'catalog-color-label',
    prompt: '素材库需要给这张商品色卡添加颜色标签。请读取图片，返回 JSON，包含 color（英文小写颜色名）和 label（中文颜色名）。',
    expected: { color: 'red', label: '红色' },
  }
  if (kind === 'plan') {
    const stock = STOCK[variant % STOCK.length]
    return {
      id: `stockout-alert-plan-${stock.sku}`,
      prompt: `我们要给订单系统加一个缺货预警：订单量超过可用库存时提醒采购。先用 lookup_inventory 查询 ${stock.sku} 的库存了解现状，然后用 exit_plan_mode 提交实施计划（以 # 标题开头），不要直接实施。`,
      tools: [INVENTORY_TOOL, EXIT_PLAN_TOOL], toolArguments: { sku: stock.sku },
      toolResult: { sku: stock.sku, onHand: stock.onHand, reserved: stock.reserved },
    }
  }
  if (kind === 'title') return {
    id: 'fulfillment-session-title',
    prompt: '请整理今天的仓库发货安排：核对待发订单与可用库存，把缺货订单单独列出，汇总需要采购补货的商品，并给客服准备延迟发货说明。',
  }
  throw new Error('Unknown business scenario kind')
}

/** A submitted plan: a markdown heading, and about the requested feature. */
export function matchesPlan(plan) {
  return typeof plan === 'string' && /^#{1,6}\s+\S/u.test(plan.trim()) && /缺货|预警|库存|stock/iu.test(plan)
}

export function matchesBusinessAnswer(scenario, answer) {
  if (scenario.expected === undefined) return /[\u4e00-\u9fff]/u.test(answer) && /订单|库存|发货|补货|仓库/u.test(answer) && answer.length <= 60 && !/[\n{}]/u.test(answer)
  try {
    // Business replies may explain their calculation after a JSON block.
    // Read one unambiguous structured result; never accept a wrong value.
    const blocks = [...answer.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/giu)]
    if (blocks.length > 1) return false
    const value = JSON.parse((blocks.length === 1 ? blocks[0][1] : answer).trim())
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.entries(scenario.expected).every(([key, expected]) => value[key] === expected)
  } catch { return false }
}
