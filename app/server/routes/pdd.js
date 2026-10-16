const { Router } = require('express')
const { stmts } = require('../db')
const { broadcast } = require('../sse')
const pdd = require('../pdd')
const accounts = require('../accounts')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

// 与淘宝渠道同构：状态只前进，已取件为终态
const STATUS_RANK = { to_ship: 1, shipping: 2, pending: 3, picked_up: 4 }

function isCompleted(order) {
  const prompt = String(order.order_status_prompt || '')
  return Number(order.shipping_status) >= 2
    || Number(order.status) >= 4
    || Number(order.receive_time) > 0
    || /已签收|交易成功|待评价|已评价|已完成|退款|交易关闭/.test(prompt)
}

function dedupePddPackages() {
  const rows = stmts.all.all().filter(r => r.source_platform === 'pdd')
  const seen = new Map()
  for (const row of rows) {
    const keys = [row.order_id, row.mail_no].filter(Boolean).map(String)
    const duplicate = keys.some(k => seen.has(k))
    if (duplicate) {
      stmts.remove.run(row.id)
      broadcast('delete', row)
      continue
    }
    keys.forEach(k => seen.set(k, row.id))
  }
}

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授权' })
  next()
}

function getAccount(id) { return id ? accounts.get('pdd', id) : null }

/** 命中已有记录（订单号优先、运单号兜底）则刷新字段，否则插入 */
function upsertPackage(p) {
  let existing = p.order_id ? stmts.getByOrderId.get(p.order_id) : null
  if (!existing && p.mail_no) existing = stmts.getByMailNo.get(p.mail_no)

  if (!existing) {
    const info = stmts.insertExpress.run(p)
    return { id: info.lastInsertRowid, created: true, promoted: false }
  }

  stmts.updateExpressInfo.run({ ...p, id: existing.id })
  const advanced = existing.status !== 'picked_up'
    && (STATUS_RANK[p.status] || 0) > (STATUS_RANK[existing.status] || 0)
  if (advanced) stmts.promoteStatus.run({ id: existing.id, status: p.status })
  return { id: existing.id, created: false, promoted: advanced }
}

module.exports = function (app) {
  const router = Router()

  router.get('/pdd/status', requireAuth, (req, res) => {
    const list = accounts.list('pdd')
    res.json({ cookie_set: list.length > 0, accounts: list.map(a => ({ id: a.id, name: a.name, cookie_set: !!a.cookie })) })
  })

  router.post('/pdd/cookie', requireAuth, (req, res) => {
    const { cookie, account_id, name } = req.body
    if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie 不能为空' })
    if (!/PDDAccessToken=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 PDDAccessToken，请登录 mobile.yangkeduo.com 后完整复制' })
    }
    if (!/pdd_user_id=|pdduid=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 pdd_user_id，请确认已登录' })
    }
    const normalized = cookie.replace(/\s+/g, ' ').trim()
    const existing = getAccount(account_id)
    const account = { id: existing ? existing.id : accounts.normalizeId(account_id), name: name || (existing && existing.name) || `拼多多账号 ${accounts.list('pdd').length + 1}`, cookie: normalized, created_at: existing?.created_at || new Date().toISOString() }
    accounts.save('pdd', account)
    res.json({ ok: true, id: account.id, name: account.name })
  })

  /** 删除账号：清除已保存的拼多多 Cookie */
  router.delete('/pdd/cookie', requireAuth, (req, res) => {
    const id = req.query.account_id || req.body?.account_id
    if (id) accounts.remove('pdd', id)
    else accounts.list('pdd').forEach(a => accounts.remove('pdd', a.id))
    res.json({ ok: true })
  })

  router.post('/pdd/sync', requireAuth, async (req, res) => {
    const selected = req.body?.account_id || req.query.account_id
    const targets = selected ? [getAccount(selected)].filter(Boolean) : accounts.list('pdd')
    if (!targets.length) return res.status(400).json({ error: '请先添加拼多多账号' })

    const created = []
    const skipped = []
    const seen = new Set()
    dedupePddPackages()

    try {
      for (const account of targets) {
      let offset = ''
      for (let page = 1; page <= 5; page++) {
        const orders = await pdd.fetchOrders(account.cookie, { page, offset })
        if (orders.length === 0) break

        for (const o of orders) {
          if (!o.order_sn || seen.has(o.order_sn)) continue
          seen.add(o.order_sn)

          if (isCompleted(o)) {
            const existing = stmts.getByOrderId.get(o.order_sn)
            if (existing && existing.source_platform === 'pdd' && existing.status !== 'picked_up') {
              stmts.remove.run(existing.id)
              broadcast('delete', existing)
            }
            skipped.push({ order_id: o.order_sn, reason: o.order_status_prompt || '已签收/已完成' })
            continue
          }

          // 有取件码时进入待取件；只有运单号时先进入运输中，后续刷新可补取件码。
          const pick = await pdd.fetchPickupCode(account.cookie, o)
          if (!pick.code && !o.tracking_number) {
            skipped.push({ order_id: o.order_sn, reason: '尚未发货或未生成取件码' })
            continue
          }

          const r = upsertPackage({
            order_id: o.order_sn,
            mail_no: o.tracking_number || '',
            status: pick.code ? 'pending' : 'shipping',
            pickup_code: pick.code,
            company: '',
            recipient: '',
            phone: '',
            address: '',
            goods_name: pdd.goodsNameOf(o),
            source_platform: 'pdd',
          })
          if (r.created || r.promoted) {
            const row = stmts.getById.get(r.id)
            broadcast(r.created ? 'create' : 'update', row)
            if (r.created) created.push(row)
          }
        }

        const last = orders[orders.length - 1]
        if (!last || !last.offset || orders.length < 10) break
        offset = String(last.offset)
      }
      }
    } catch (e) {
      stmts.logSync.run({ source: 'pdd', status: 'error', detail: e.message })
      return res.status(502).json({ error: e.message })
    }

    const detail = `新增 ${created.length} / 跳过 ${skipped.length}`
    stmts.logSync.run({ source: 'pdd', status: 'ok', detail })
    res.json({ ok: true, created, skipped, summary: detail })
  })

  app.use('/api', router)
}
