#!/usr/bin/env node
// aliyun-model-proxy — 纯 Node.js 版，零依赖
// 对外兼容 OpenAI + Anthropic 协议，对内代理阿里云 DashScope

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// ── .env 加载 ──────────────────────────────────────────
function loadEnv(envPath) {
  if (!existsSync(envPath)) return
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    // expand ${VAR} references
    val = val.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv(resolve('.env'))

// ── 配置 ───────────────────────────────────────────────
function requireEnv(name) {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

const PORT = Number(process.env.PORT) || 3300
const PROXY_API_KEY = requireEnv('PROXY_API_KEY')
const DASHSCOPE_API_KEYS = requireEnv('DASHSCOPE_API_KEYS').split(',').map(s => s.trim()).filter(Boolean)
const UPSTREAM_BASE = process.env.UPSTREAM_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/apps/anthropic'
const OPENAI_UPSTREAM_BASE = process.env.OPENAI_UPSTREAM_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODEL_IDS = requireEnv('MODEL_IDS').split(',').map(s => s.trim()).filter(Boolean)
const COOLDOWN_MS = (Number(process.env.MODEL_COOLDOWN_SECONDS) || 2592000) * 1000
const STATE_PATH = resolve(process.env.STATE_PATH?.trim() || './data/proxy-state.json')
const AUTH_MODE = process.env.UPSTREAM_AUTH_MODE?.trim() || 'authorization'
const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim()

// ── StateStore ─────────────────────────────────────────
function ensureDir(p) { mkdirSync(dirname(p), { recursive: true }) }

function loadState() {
  if (!existsSync(STATE_PATH)) return { version: 1, modelState: {}, runtimeState: {} }
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (s.version !== 1) throw new Error('bad version')
    return s
  } catch {
    const bak = STATE_PATH + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(STATE_PATH, bak)
    console.warn(`[state] corrupt state backed up to ${bak}`)
    return { version: 1, modelState: {}, runtimeState: {} }
  }
}

let state = loadState()
ensureDir(STATE_PATH)

function persistState() {
  const tmp = STATE_PATH + '.' + process.pid + '.' + Date.now() + '.tmp'
  const fd = openSync(tmp, 'w')
  try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', 'utf8'); fsyncSync(fd) }
  finally { closeSync(fd) }
  renameSync(tmp, STATE_PATH)
}

function msKey(keyHash, modelId) { return `${keyHash}:${modelId}` }
function getModelState(keyHash, modelId) {
  const k = msKey(keyHash, modelId)
  if (!state.modelState[k]) state.modelState[k] = { keyHash, modelId, cooldownUntil: 0, failureCount: 0, lastError: null, lastUsedAt: null, updatedAt: Date.now() }
  return state.modelState[k]
}
function getRuntimeNumber(name, fallback = 0) {
  const e = state.runtimeState[name]
  if (!e) return fallback
  const v = Number(e.value)
  return Number.isInteger(v) && v >= 0 ? v : fallback
}
function setRuntimeNumber(name, value) {
  state.runtimeState[name] = { value: String(value), updatedAt: Date.now() }
  persistState()
}
function hashKey(k) { return createHash('sha256').update(k).digest('hex') }

// ── Model Pool ─────────────────────────────────────────
const apiKeys = DASHSCOPE_API_KEYS.map((v, i) => ({ value: v, hash: hashKey(v), label: hashKey(v).slice(0, 12), index: i }))
const modelIds = [...new Set(MODEL_IDS)]

for (const key of apiKeys) {
  for (const mid of modelIds) {
    getModelState(key.hash, mid) // ensure entry exists
  }
}
persistState()

function getKeyCursor() { return getRuntimeNumber('key_cursor', 0) % apiKeys.length }
function setKeyCursor(i) { setRuntimeNumber('key_cursor', i % apiKeys.length) }
function getModelCursor(keyHash) { return getRuntimeNumber('mc:' + keyHash, 0) % modelIds.length }
function setModelCursor(keyHash, i) { setRuntimeNumber('mc:' + keyHash, i % modelIds.length) }

function getCandidates() {
  const now = Date.now()
  const result = []
  const startKey = getKeyCursor()
  let firstAvail = null

  for (let off = 0; off < apiKeys.length; off++) {
    const ki = (startKey + off) % apiKeys.length
    const key = apiKeys[ki]
    const startModel = getModelCursor(key.hash)
    let hasAny = false

    for (let moff = 0; moff < modelIds.length; moff++) {
      const mi = (startModel + moff) % modelIds.length
      const mid = modelIds[mi]
      const st = getModelState(key.hash, mid)
      if (st.cooldownUntil > now) continue
      hasAny = true
      result.push({ apiKey: key.value, keyHash: key.hash, keyLabel: key.label, keyIndex: ki, modelId: mid, modelIndex: mi })
    }
    if (hasAny && firstAvail === null) firstAvail = ki
  }
  if (firstAvail !== null && firstAvail !== startKey) setKeyCursor(firstAvail)
  return result
}

function markSuccess(cand) {
  const st = getModelState(cand.keyHash, cand.modelId)
  st.lastError = null; st.lastUsedAt = Date.now(); st.updatedAt = Date.now()
  persistState()
  setKeyCursor(cand.keyIndex)
  setModelCursor(cand.keyHash, cand.modelIndex)
}

function markExhausted(cand, reason) {
  const st = getModelState(cand.keyHash, cand.modelId)
  st.cooldownUntil = Date.now() + COOLDOWN_MS; st.failureCount++; st.lastError = reason; st.updatedAt = Date.now()
  persistState()
}

function snapshot() {
  const now = Date.now()
  const cki = getKeyCursor()
  return apiKeys.flatMap(key => {
    const cmi = getModelCursor(key.hash)
    return modelIds.map((mid, mi) => {
      const st = getModelState(key.hash, mid)
      return {
        keyHash: key.label, keyIndex: key.index, currentKey: key.index === cki,
        currentModel: key.index === cki && mi === cmi, id: mid,
        available: st.cooldownUntil <= now,
        cooldownUntil: st.cooldownUntil > now ? new Date(st.cooldownUntil).toISOString() : null,
        failureCount: st.failureCount, lastError: st.lastError,
        lastUsedAt: st.lastUsedAt ? new Date(st.lastUsedAt).toISOString() : null
      }
    })
  })
}

// ── 请求代理 ───────────────────────────────────────────
const HOP = new Set(['connection','content-length','host','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'])

function buildHeaders(srcHeaders, apiKey, blocked = []) {
  const h = {}
  const blockedSet = new Set(blocked.map(b => b.toLowerCase()))
  for (const [k, v] of Object.entries(srcHeaders)) {
    const lk = k.toLowerCase()
    if (HOP.has(lk) || blockedSet.has(lk) || lk === 'authorization' || lk === 'x-api-key') continue
    h[k] = v
  }
  h['content-type'] = 'application/json'
  if (AUTH_MODE === 'authorization' || AUTH_MODE === 'both') h['authorization'] = `Bearer ${apiKey}`
  if (AUTH_MODE === 'x-api-key' || AUTH_MODE === 'both') h['x-api-key'] = apiKey
  return h
}

function filterRespHeaders(src) {
  const h = {}
  for (const [k, v] of Object.entries(src)) {
    if (HOP.has(k.toLowerCase()) || k.toLowerCase() === 'content-encoding') continue
    h[k] = v
  }
  return h
}

function isFreeTierExhausted(payload) {
  if (!payload || typeof payload !== 'object') return null
  const err = payload.error && typeof payload.error === 'object' ? payload.error : null
  const code = payload.code || err?.code
  const type = payload.type || err?.type
  const msg = payload.message || err?.message || ''
  const exhausted = /free\s+tier/i.test(msg) && /exhausted/i.test(msg)
  const freeTierOnly = code === 'AllocationQuota.FreeTierOnly' || type === 'AllocationQuota.FreeTierOnly'
  if ((code === 'AccessDenied' && exhausted) || freeTierOnly) return { code, message: msg }
  return null
}

async function parseResponseBody(resp) {
  const text = await resp.text()
  const trimmed = text.trim()
  if (!trimmed) return { payload: null, raw: '' }
  if (trimmed.startsWith('{')) {
    try { return { payload: JSON.parse(trimmed), raw: trimmed } } catch { return { payload: null, raw: trimmed } }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim()
    if (!l.startsWith('data:')) continue
    const d = l.slice(5).trim()
    if (!d || d === '[DONE]') continue
    try { return { payload: JSON.parse(d), raw: trimmed } } catch {}
  }
  return { payload: null, raw: trimmed }
}

async function proxyRequest(req, body, pathSearch, upstreamBase, blockedHeaders = []) {
  const candidates = getCandidates()
  if (candidates.length === 0) return jsonResponse(503, { error: { type: 'all_models_in_cooldown', message: 'All models cooling down.' } })

  const attempts = []
  let lastExhaustion = null

  for (const cand of candidates) {
    attempts.push({ keyHash: cand.keyLabel, model: cand.modelId })
    const url = upstreamBase.replace(/\/+$/, '') + (pathSearch.startsWith('/') ? '' : '/') + pathSearch
    const bodyWithModel = JSON.stringify({ ...body, model: cand.modelId })

    try {
      const resp = await fetch(url, { method: 'POST', headers: buildHeaders(req.headers, cand.apiKey, blockedHeaders), body: bodyWithModel })

      if (resp.status === 403) {
        const clone = resp.clone()
        const { payload, raw } = await parseResponseBody(clone)
        const ex = isFreeTierExhausted(payload)
        if (ex) {
          lastExhaustion = ex
          markExhausted(cand, ex.message)
          console.warn(`[proxy] free-tier exhausted; key=${cand.keyLabel} model=${cand.modelId} attempt=${attempts.length}/${candidates.length}`)
          continue
        }
      }

      markSuccess(cand)
      if (attempts.length > 1) console.log(`[proxy] retry success key=${cand.keyLabel} model=${cand.modelId} attempts=${attempts.length}`)

      const respHeaders = { ...filterRespHeaders(Object.fromEntries(resp.headers.entries())), 'x-proxy-key-hash': cand.keyLabel, 'x-proxy-model': cand.modelId, 'x-proxy-attempts': String(attempts.length) }

      // 流式透传
      if (resp.headers.get('content-type')?.includes('text/event-stream')) {
        const { Readable } = await import('node:stream')
        const nodeStream = Readable.fromWeb(resp.body)
        return { status: resp.status, headers: { ...respHeaders, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' }, body: nodeStream, stream: true }
      }

      const respBody = await resp.text()
      return { status: resp.status, headers: respHeaders, body: respBody }

    } catch (err) {
      console.error(`[proxy] fetch error: ${err.message}`)
      lastExhaustion = { message: err.message }
      continue
    }
  }

  return jsonResponse(503, { error: { type: 'all_models_exhausted', message: 'All models exhausted.', lastUpstreamError: lastExhaustion }, attempts })
}

function jsonResponse(status, body) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }
}

// ── HTTP Server ────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function parseCookies(_) { /* placeholder */ }

function sendResponse(res, result) {
  res.writeHead(result.status, result.headers)
  if (result.stream && result.body) {
    result.body.pipe(res)
    result.body.on('error', () => res.end())
  } else {
    res.end(result.body || '')
  }
}

function isAuthorized(headers) {
  const xKey = headers['x-api-key']?.trim()
  if (xKey === PROXY_API_KEY) return true
  const auth = headers['authorization']?.trim()
  if (!auth) return false
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() === PROXY_API_KEY
  return auth === PROXY_API_KEY
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const startedAt = Date.now()

  // CORS
  if (CORS_ORIGIN && CORS_ORIGIN !== 'false') {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta')
    res.setHeader('Access-Control-Expose-Headers', 'x-proxy-key-hash, x-proxy-model, x-proxy-attempts')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    // 首页
    if (url.pathname === '/' && req.method === 'GET') {
      const r = jsonResponse(200, { name: 'dashscope-model-proxy', endpoints: ['/health', '/models/status', '/v1/models', '/v1/messages', '/v1/chat/completions'] })
      sendResponse(res, r); logReq(req, url, r.status, startedAt); return
    }

    // 健康检查
    if (url.pathname === '/health' && req.method === 'GET') {
      const now = Date.now()
      const avail = apiKeys.reduce((n, key) => n + modelIds.filter(mid => getModelState(key.hash, mid).cooldownUntil <= now).length, 0)
      const r = jsonResponse(200, { ok: true, totalKeys: apiKeys.length, modelsPerKey: modelIds.length, totalSlots: apiKeys.length * modelIds.length, availableSlots: avail })
      sendResponse(res, r); logReq(req, url, r.status, startedAt); return
    }

    // 模型状态
    if (url.pathname === '/models/status' && req.method === 'GET') {
      if (!isAuthorized(req.headers)) { const r = jsonResponse(401, { error: { type: 'authentication_error', message: 'Invalid proxy key.' } }); sendResponse(res, r); return }
      const now = Date.now()
      const avail = apiKeys.reduce((n, key) => n + modelIds.filter(mid => getModelState(key.hash, mid).cooldownUntil <= now).length, 0)
      const r = jsonResponse(200, { totalKeys: apiKeys.length, modelsPerKey: modelIds.length, totalSlots: apiKeys.length * modelIds.length, availableSlots: avail, models: snapshot() })
      sendResponse(res, r); logReq(req, url, r.status, startedAt); return
    }

    // /v1/* 需要授权
    if (url.pathname.startsWith('/v1/')) {
      if (!isAuthorized(req.headers)) { const r = jsonResponse(401, { error: { type: 'authentication_error', message: 'Invalid proxy key.' } }); sendResponse(res, r); return }

      // GET /v1/models
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const r = jsonResponse(200, { object: 'list', data: modelIds.map(mid => ({ id: mid, object: 'model', created: 0, owned_by: 'dashscope-model-proxy' })) })
        sendResponse(res, r); logReq(req, url, r.status, startedAt); return
      }

      // POST /v1/chat/completions (OpenAI)
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const raw = await readBody(req)
        let body; try { body = JSON.parse(raw) } catch { sendResponse(res, jsonResponse(400, { error: { type: 'invalid_request_error', message: 'Invalid JSON.' } })); return }
        const pathSearch = url.pathname.replace(/^\/v1/, '') + url.search
        const r = await proxyRequest(req, body, pathSearch, OPENAI_UPSTREAM_BASE, ['anthropic-beta', 'anthropic-version'])
        sendResponse(res, r); logReq(req, url, r.status, startedAt); return
      }

      // POST /v1/* (Anthropic)
      if (req.method === 'POST') {
        const raw = await readBody(req)
        let body; try { body = JSON.parse(raw) } catch { sendResponse(res, jsonResponse(400, { error: { type: 'invalid_request_error', message: 'Invalid JSON.' } })); return }
        const r = await proxyRequest(req, body, url.pathname + url.search, UPSTREAM_BASE)
        sendResponse(res, r); logReq(req, url, r.status, startedAt); return
      }

      sendResponse(res, jsonResponse(405, { error: { type: 'method_not_allowed', message: 'Only POST proxied under /v1/*.' } })); return
    }

    sendResponse(res, jsonResponse(404, { error: { message: 'Not found.' } }))

  } catch (err) {
    console.error('[server] unhandled:', err)
    if (!res.headersSent) sendResponse(res, jsonResponse(500, { error: { message: 'Internal error.' } }))
  }
})

function logReq(req, url, status, startedAt) {
  const ms = Date.now() - startedAt
  console.log(`[request] ${req.method} ${url.pathname}${url.search} status=${status} duration=${ms}ms`)
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] listening on http://localhost:${PORT}`)
  console.log(`[proxy] upstream anthropic: ${UPSTREAM_BASE}`)
  console.log(`[proxy] upstream openai: ${OPENAI_UPSTREAM_BASE}`)
  console.log(`[proxy] keys: ${apiKeys.length}, models: ${modelIds.length}`)
  console.log('[proxy] models:', modelIds.join(', '))
  console.log(`[proxy] state: ${STATE_PATH}`)
  console.log(`[proxy] proxy key: ${PROXY_API_KEY}`)
})
