const crypto = require('crypto')
const QRCode = require('qrcode')
const { accumulateCookies, fetchOrders } = require('./taobao')

const BASE = 'https://login.m.taobao.com'
const UA = 'Mozilla/5.0 (Linux; Android 12; M2102K1C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Mobile Safari/537.36'
const TIMEOUT = 20000
const SESSION_TTL = 5 * 60 * 1000

/**
 * 淘宝扫码登录（服务端纯 HTTP，无需浏览器）。
 *
 * 凭证来源：实测 bundle 内没有任何 cookie2/unb 的 JS 赋值，
 * 说明登录态完全由 HTTP Set-Cookie 下发 —— 因此策略是「累积整段会话的所有 Set-Cookie」，
 * 而不是猜哪个字段是凭证。generate 阶段就已下发 cookie2/t/XSRF-TOKEN。
 *
 * 状态机（扒自 havana-nlogin bundle）：NEW → SCANED → CONFIRMED；EXPIRED / CANCELED 为失败。
 */
const sessions = new Map()

function sweep() {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id)
  }
}

function jarOf(resp) {
  return accumulateCookies('', resp.headers)
}

/** 生成二维码，返回会话 id 与图片 dataURL */
async function createQr() {
  sweep()
  const url = `${BASE}/havanaone/loginLegacy/qrCode/generate.do?bizEntrance=taobao_h5&bizName=taobao`
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/login.htm?loginFrom=wap_tb`,
      Accept: 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!resp.ok) throw new Error(`获取二维码失败：HTTP ${resp.status}`)

  const jar = jarOf(resp)
  const body = await resp.json()
  const data = body && body.content && body.content.data
  if (!data || !data.ck || !data.codeContent) {
    throw new Error('淘宝未返回二维码数据，请稍后重试')
  }

  const sessionId = crypto.randomUUID()
  sessions.set(sessionId, {
    jar,
    ck: data.ck,
    t: String(data.t || ''),
    createdAt: Date.now(),
  })

  const qr = await QRCode.toDataURL(data.codeContent, { width: 260, margin: 1 })
  return { session_id: sessionId, qr, expires_in: Math.floor(SESSION_TTL / 1000) }
}

/** 轮询扫码状态；CONFIRMED 时返回累积到的 cookie 串 */
async function pollStatus(sessionId) {
  sweep()
  const s = sessions.get(sessionId)
  if (!s) throw new Error('二维码会话已过期，请刷新重试')

  const form = new URLSearchParams({
    t: s.t,
    ck: s.ck,
    ua: UA,
    umidToken: '',
    umidTag: '',
    navlanguage: 'zh-CN',
    navUserAgent: UA,
    navPlatform: 'Linux x86_64',
    bizEntrance: 'taobao_h5',
    bizName: 'taobao',
  })

  const resp = await fetch(`${BASE}/havanaone/loginLegacy/qrCode/query.do`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/login.htm?loginFrom=wap_tb`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: s.jar,
    },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT),
  })

  // 登录成功后淘宝在本响应下发凭证 Cookie —— 必须先累积再判断
  s.jar = accumulateCookies(s.jar, resp.headers)

  if (!resp.ok) throw new Error(`轮询失败：HTTP ${resp.status}`)
  const body = await resp.json()
  const data = body && body.content && body.content.data
  const status = (data && data.qrCodeStatus) || 'UNKNOWN'

  if (status === 'CONFIRMED') {
    sessions.delete(sessionId)
    return { status: 'CONFIRMED', cookie: s.jar }
  }
  if (status === 'EXPIRED') {
    sessions.delete(sessionId)
    return { status: 'EXPIRED' }
  }
  if (status === 'CANCELED') {
    sessions.delete(sessionId)
    return { status: 'CANCELED' }
  }
  return { status }
}

/** 扫码成功后验证登录态真的可用（避免失败静默） */
async function verifyLogin(cookie) {
  try {
    await fetchOrders(cookie, 1)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = { createQr, pollStatus, verifyLogin }
