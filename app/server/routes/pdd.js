const { Router } = require('express')
const { stmts } = require('../db')
const { broadcast } = require('../sse')
const pdd = require('../pdd')
const accounts = require('../accounts')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

// 与淘宝渠道同构：状态只前进，已取件为终态
const STATUS_RANK = { to_ship: 1, shipping: 2, pending: 3, picked_up: 4 }

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

    try {
      for (const account of targets) {
      let offset = ''
      for (let page = 1; page <= 5; page++) {
        const orders = await pdd.fetchOrders(account.cookie, { page, offset })
        if (orders.length === 0) break

        for (const o of orders) {
          if (!o.order_sn || seen.has(o.order_sn)) continue
          seen.add(o.order_sn)

          // 只有真正拿到取件码才入库（与淘宝渠道同规则：避免占位噪音）
          const pick = await pdd.fetchPickupCode(account.cookie, o)
          if (!pick.code) {
            skipped.push({ order_id: o.order_sn, reason: '尚未生成取件码' })
            continue
          }

          const r = upsertPackage({
            order_id: o.order_sn,
            mail_no: o.tracking_number || '',
            status: 'pending',
            pickup_code: pick.code,
            company: '',
            recipient: '',
            phone: '',
            address: '',
            goods_name: pdd.goodsNameOf(o),
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
