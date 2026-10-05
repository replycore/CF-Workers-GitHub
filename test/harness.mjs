// Behavioural regression suite for _worker.js.
//
// Zero dependencies, stubs globalThis.fetch and exercises the Worker's fetch
// handler directly. Run it from the repository root:
//
//     node test/harness.mjs [path/to/_worker.js]
//
// Exits non-zero if any case fails.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modPath = path.resolve(process.cwd(), process.argv[2] ?? path.join(repoRoot, '_worker.js'))

// ---- stub fetch ------------------------------------------------------------
// `calls` 只记录被代理出去的上游请求；首页多出来的那次 Bing 壁纸请求单独记在
// `bingCalls` 里，免得把代理相关的调用次数断言全部污染掉。
const BING_API = 'https://www.bing.com/HPImageArchive.aspx'
const calls = []
// 全局计数、不清零：Worker 端对壁纸结果做了模块级缓存，清零会让"只回源一次"的断言失去意义。
const bingCalls = []
let bingMode = 'ok' // 'ok'(8 张) | 'fail' | 'empty'(0 张) | 'one'(1 张)
let nextResponse = null

const bingImages = (n) => ({
  images: Array.from({ length: n }, (_, i) => ({
    url: `/th?id=OHR.Day${i}_1920x1080.jpg&rf=Lang1_1920x1080.jpg&pid=hp`,
    copyright: `Day ${i} (c) harness`,
  })),
})

function defaultFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url
  if (url.startsWith(BING_API)) {
    bingCalls.push(url)
    if (bingMode === 'fail') return Promise.reject(new Error('bing unreachable'))
    const n = bingMode === 'empty' ? 0 : bingMode === 'one' ? 1 : 8
    return new Response(JSON.stringify(bingImages(n)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  calls.push({ url, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), init })
  if (typeof nextResponse === 'function') return nextResponse(url, init)
  if (nextResponse) return nextResponse.clone()
  return new Response('upstream-ok', { status: 200 })
}
globalThis.fetch = defaultFetch
const respond = (r) => { nextResponse = r }
// 注意：不清理 bingCalls，见上面的说明
const reset = () => { calls.length = 0; nextResponse = null }

const worker = (await import(modPath)).default
const run = (path, { env = {}, headers = {}, method = 'GET', body } = {}) => {
  const init = { method, headers }
  if (body !== undefined) init.body = body
  return worker.fetch(new Request('https://demo.example' + path, init), env, {})
}

// Worker 端对壁纸结果做了模块级缓存（成功 30min / 失败 60s），
// 要覆盖另一种 Bing 返回就得重新加载一个干净的模块实例（带 query 的 import 不命中模块缓存）。
// 注意：这里只负责切换 bingMode 并加载，调用方要自己在 finally 里改回 'ok'。
let freshSeq = 0
const loadFreshWorker = async (mode) => {
  bingMode = mode
  const sep = modPath.includes('?') ? '&' : '?'
  return (await import(`${modPath}${sep}fresh=${freshSeq++}`)).default
}

// 从首页 HTML 里读出注入的壁纸数组；未注入（失败 / 0 张图）时返回 null
const readWallpapers = (html) => {
  const line = html.split('\n').find(l => l.includes('const WALLPAPERS ='))
  if (!line) throw new Error('WALLPAPERS 声明没找到')
  let value = line.slice(line.indexOf('const WALLPAPERS =') + 'const WALLPAPERS ='.length).trim()
  if (value.endsWith(';')) value = value.slice(0, -1)
  if (value.startsWith('/*')) return null // 占位表达式原样保留，说明没有注入数据
  return JSON.parse(value)
}

// 同上，读背景配置（BG_INTERVAL / BG_OPACITY）
const readWallpaperCfg = (html) => {
  const line = html.split('\n').find(l => l.includes('const WALLPAPER_CFG ='))
  if (!line) throw new Error('WALLPAPER_CFG 声明没找到')
  let value = line.slice(line.indexOf('const WALLPAPER_CFG =') + 'const WALLPAPER_CFG ='.length).trim()
  if (value.endsWith(';')) value = value.slice(0, -1)
  if (value.startsWith('/*')) return null
  return JSON.parse(value)
}

const results = []
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name, e.message]) }
}

// 1. homepage
await test('GET / returns HTML homepage', async () => {
  reset()
  const r = await run('/')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/html/)
  assert.match(await r.text(), /GitHub 文件加速/)
  assert.equal(calls.length, 0, 'homepage must not hit a GitHub upstream')
})

// 2. favicon
await test('GET /favicon.ico returns cached png', async () => {
  reset()
  const r = await run('/favicon.ico')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.match(r.headers.get('cache-control') ?? '', /max-age=86400/)
  const buf = new Uint8Array(await r.arrayBuffer())
  assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'png magic')
})

// 3. ?q= redirect
await test('?q= redirects to prefixed path', async () => {
  reset()
  const r = await run('/?q=https://github.com/a/b/archive/main.zip')
  assert.equal(r.status, 301)
  assert.equal(r.headers.get('location'), 'https://demo.example/https://github.com/a/b/archive/main.zip')
})

// 4. releases proxy
await test('release url is proxied (manual redirect)', async () => {
  reset()
  const r = await run('/https://github.com/a/b/releases/download/v1/x.zip')
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://github.com/a/b/releases/download/v1/x.zip')
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.equal(r.headers.get('access-control-expose-headers'), '*')
  assert.equal(r.headers.get('content-security-policy'), null)
})

// 5. no-protocol input
await test('protocol-less url gets https:// prefix', async () => {
  reset()
  await run('/github.com/a/b/archive/main.zip')
  assert.equal(calls[0].url, 'https://github.com/a/b/archive/main.zip')
})

// 6. blob -> raw
await test('blob path rewritten to raw', async () => {
  reset()
  await run('/https://github.com/a/b/blob/main/src/index.js')
  assert.equal(calls[0].url, 'https://github.com/a/b/raw/main/src/index.js')
})

// 7. info/refs (git smart http)
await test('info/refs (exp3) proxied', async () => {
  reset()
  await run('/https://github.com/a/b/info/refs?service=git-upload-pack')
  assert.equal(calls[0].url, 'https://github.com/a/b/info/refs?service=git-upload-pack')
})

// 8. raw + gist
await test('raw.githubusercontent proxied', async () => {
  reset()
  await run('/https://raw.githubusercontent.com/a/b/main/f.txt')
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/a/b/main/f.txt')
})
await test('gist proxied', async () => {
  reset()
  await run('/https://gist.githubusercontent.com/u/123/raw/x.py')
  assert.equal(calls[0].url, 'https://gist.githubusercontent.com/u/123/raw/x.py')
})

// 9. tags
await test('tags path proxied (exp6)', async () => {
  reset()
  await run('/https://github.com/a/b/tags')
  assert.equal(calls[0].url, 'https://github.com/a/b/tags')
})

// 10. crawler UA cloaking
await test('blocked UA gets nginx camouflage page', async () => {
  reset()
  const r = await run('/', { headers: { 'User-Agent': 'Mozilla/5.0 Netcraft' } })
  assert.equal(r.status, 200)
  assert.match(await r.text(), /Welcome to nginx!/)
  assert.equal(calls.length, 0)
})

// 11. env.UA extends blocklist
await test('env.UA extends crawler blocklist', async () => {
  reset()
  const r = await run('/', { headers: { 'User-Agent': 'MyBadBot/1.0' }, env: { UA: 'MyBadBot' } })
  assert.match(await r.text(), /Welcome to nginx!/)
})

// 12. CORS preflight
await test('OPTIONS preflight returns 204 + CORS', async () => {
  reset()
  const r = await run('/https://github.com/a/b/archive/main.zip', {
    method: 'OPTIONS',
    headers: { 'access-control-request-headers': 'x-custom' },
  })
  assert.equal(r.status, 204)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.match(r.headers.get('access-control-allow-methods') ?? '', /GET/)
  assert.ok(r.headers.get('access-control-allow-headers'), 'must allow request headers')
})

// 13. URL302 camouflage
await test('URL302 env redirects homepage', async () => {
  reset()
  const r = await run('/', { env: { URL302: 'https://example.org/' } })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), 'https://example.org/')
})

// 14. URL=nginx
await test('URL=nginx serves camouflage page', async () => {
  reset()
  const r = await run('/', { env: { URL: 'nginx' } })
  assert.match(await r.text(), /Welcome to nginx!/)
})

// 15. URL passthrough
await test('URL env proxies homepage to custom origin', async () => {
  reset()
  respond(new Response('masked', { status: 200 }))
  const r = await run('/', { env: { URL: 'https://mask.example/home' } })
  assert.equal(r.status, 200)
  assert.equal(calls[0].url, 'https://mask.example/home')
})

// 16. upstream 3xx rewritten through the proxy
await test('github 302 location rewritten to prefixed path', async () => {
  reset()
  respond(new Response(null, { status: 302, headers: { location: 'https://github.com/a/b/releases/download/v1/x.zip' } }))
  const r = await run('/https://github.com/a/b/archive/main.zip')
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/https://github.com/a/b/releases/download/v1/x.zip')
})

// 17. relative upstream location must not crash  <--- known bug
await test('relative upstream location does not crash', async () => {
  reset()
  respond(new Response(null, { status: 302, headers: { location: '/login?return_to=%2Ffoo' } }))
  const r = await run('/https://github.com/a/b/archive/main.zip')
  assert.ok(r.status < 500, 'expected non-5xx, got ' + r.status)
})

// 18. redirect loop must terminate <--- known bug
await test('redirect loop terminates with a response', async () => {
  reset()
  let n = 0
  respond(() => (n++ < 60
    ? new Response(null, { status: 302, headers: { location: 'https://evil.example/' + n } })
    : new Response('too many', { status: 508 })))
  const r = await run('/https://github.com/a/b/archive/main.zip')
  assert.ok(r, 'no response returned')
  assert.ok(n <= 20, 'unbounded redirect recursion: ' + n + ' hops')
})

// 19. unknown path falls back to homepage
await test('unknown path falls back to homepage', async () => {
  reset()
  const r = await run('/some/random/path')
  assert.equal(r.status, 200)
  assert.match(await r.text(), /GitHub 文件加速/)
})

// 20. no upstream header leakage of client IP forwarding headers
await test('hop-by-hop / client IP headers stripped before upstream', async () => {
  reset()
  await run('/https://github.com/a/b/archive/main.zip', {
    headers: {
      'user-agent': 'curl/8',
      'x-forwarded-for': '1.2.3.4',
      'cf-connecting-ip': '1.2.3.4',
      'cookie': 'session=abc',
      connection: 'keep-alive',
      te: 'trailers',
    },
  })
  const h = calls[0].init.headers
  assert.equal(h.get('x-forwarded-for'), null, 'x-forwarded-for must be stripped')
  assert.equal(h.get('cf-connecting-ip'), null, 'cf-connecting-ip must be stripped')
  assert.equal(h.get('te'), null, 'hop-by-hop te must be stripped')
})

// 21. URL host-spoofing is rejected (SSRF-ish guard)
await test('non-github host is not proxied', async () => {
  reset()
  const r = await run('/https://evil.example/secret.txt')
  assert.equal(calls.length, 0, 'must not fetch arbitrary host: ' + calls.map(c => c.url))
  assert.equal(r.status, 200)
  assert.match(await r.text(), /GitHub 文件加速/)
})

// 22. env.UA must not accumulate across requests (isolate state leak)
await test('env.UA does not grow module state across requests', async () => {
  reset()
  // Count String#includes calls that the crawler check performs.
  const orig = String.prototype.includes
  let counted = 0
  String.prototype.includes = function (...a) {
    if (String(this) === 'mycrawler/1.0') counted++
    return orig.apply(this, a)
  }
  try {
    const env = { UA: 'crawlerA' }
    const hdrs = { 'User-Agent': 'MyCrawler/1.0' }
    for (let i = 0; i < 400; i++) await run('/', { env, headers: hdrs })
    const after400 = counted
    for (let i = 0; i < 400; i++) await run('/', { env, headers: hdrs })
    const after800 = counted
    const per1 = after400 / 400
    const per2 = (after800 - after400) / 400
    assert.ok(
      per2 <= per1 * 1.2 + 1,
      `UA blocklist grows per request: first 400 avg=${per1.toFixed(1)} includes/req, next 400 avg=${per2.toFixed(1)} includes/req`
    )
  } finally {
    String.prototype.includes = orig
  }
})

// 23. duplicate / redundant URL parsing
await test('request URL parsed at most twice per request', async () => {
  reset()
  const req = new Request('https://demo.example/https://github.com/a/b/archive/main.zip')
  const orig = globalThis.URL
  let n = 0
  globalThis.URL = class extends orig { constructor(...a) { super(...a); n++ } }
  try {
    await worker.fetch(req, {}, {})
    assert.ok(n <= 2, 'URL parsed ' + n + ' times per request')
  } finally {
    globalThis.URL = orig
  }
})

// 24. favicon cache returns a valid PNG on every request
await test('favicon decoding is cached but stays valid on repeat calls', async () => {
  reset()
  for (let i = 0; i < 3; i++) {
    const r = await run('/favicon.ico')
    const buf = new Uint8Array(await r.arrayBuffer())
    assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `png magic (call ${i})`)
    assert.ok(buf.length > 1000, `png size (call ${i}): ${buf.length}`)
  }
})

// 25. ?q= must not hijack a proxied url that carries its own query string
await test('?q= does not hijack proxied urls carrying a query string', async () => {
  reset()
  const r = await run('/https://github.com/a/b/releases/download/v1/x.zip?q=https://evil.example/')
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://github.com/a/b/releases/download/v1/x.zip?q=https://evil.example/')
})

// 26. POST (git-upload-pack) body is forwarded
await test('POST body is forwarded upstream', async () => {
  reset()
  const payload = '006egit-upload-pack a/b' + String.fromCharCode(0) + 'host=x' + String.fromCharCode(0)
  const r = await run('/https://github.com/a/b/git-upload-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request' },
    body: payload,
  })
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://github.com/a/b/git-upload-pack')
  assert.equal(calls[0].method, 'POST')
  assert.ok(
    calls[0].init.body && typeof calls[0].init.body.getReader === 'function',
    'request body must be passed through'
  )
})

// 27. upstream network failure surfaces as 502, not a rejected promise
await test('upstream network failure returns 502', async () => {
  reset()
  globalThis.fetch = async () => { throw new Error('ECONNRESET') }
  try {
    const r = await run('/https://github.com/a/b/archive/main.zip')
    assert.equal(r.status, 502)
  } finally {
    globalThis.fetch = defaultFetch
  }
})

// 28. credentials are not forwarded across an origin change
await test('cross-origin redirect drops authorization/cookie', async () => {
  reset()
  let seen = null
  respond(() => {
    if (!seen) { seen = 'first'; return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }) }
    return new Response('ok', { status: 200 })
  })
  await run('/https://github.com/a/b/archive/main.zip', {
    headers: { authorization: 'token SECRET', cookie: 'sid=1' },
  })
  const cross = calls.find(c => c.url.startsWith('https://evil.example'))
  assert.ok(cross, 'expected a follow-up fetch to the cross-origin location')
  const h = cross.init.headers
  assert.equal(h.get('authorization'), null, 'authorization leaked cross-origin')
  assert.equal(h.get('cookie'), null, 'cookie leaked cross-origin')
})

// 29. same-origin redirect keeps credentials (private repo clone must keep working)
await test('same-origin redirect keeps authorization', async () => {
  reset()
  let seen = null
  respond(() => {
    if (!seen) { seen = 'first'; return new Response(null, { status: 302, headers: { location: 'https://github.com/login' } }) }
    return new Response('ok', { status: 200 })
  })
  await run('/https://github.com/a/b/archive/main.zip', { headers: { authorization: 'token SECRET' } })
  const same = calls.find(c => c.url === 'https://github.com/login')
  assert.ok(same, 'expected a follow-up same-origin fetch, got ' + JSON.stringify(calls.map(c => c.url)))
  assert.equal(same.init.headers.get('authorization'), 'token SECRET', 'same-origin authorization must be kept')
})

// 30. template literal must not eat the backslashes of the inline regex / css
await test('homepage keeps regex escaping and valid CSS in the template literal', async () => {
  reset()
  const html = await (await run('/')).text()
  assert.ok(html.includes('github\\.com\\/'), 'pattern backslashes were eaten by the template literal')
  assert.ok(!html.includes('!重要;'), 'CSS uses !重要 instead of !important')
  const m = html.match(/pattern="([^"]+)"/)
  assert.ok(m, 'input pattern attribute missing')
  assert.doesNotThrow(() => new RegExp(m[1]), 'served pattern is not a valid regex: ' + m[1])
})

// ---- Bing 每日壁纸 ---------------------------------------------------------
// 31. 首页注入壁纸数据，且同一份数据只回源一次 Bing
await test('homepage injects Bing wallpapers and reuses the cached result', async () => {
  reset()
  const before = bingCalls.length
  const html1 = await (await run('/')).text()
  const html2 = await (await run('/')).text()
  const list = readWallpapers(html1)
  assert.ok(Array.isArray(list) && list.length === 8, 'expected 8 wallpapers, got ' + JSON.stringify(list && list.length))
  assert.ok(list[0].url.startsWith('https://www.bing.com/'), '壁纸 url 没有补全域名: ' + list[0].url)
  assert.ok(list[0].copyright.length > 0, '缺少 copyright 文案')
  assert.equal(html2, html1, '两次首页响应应一致（命中模块缓存）')
  // 这两次请求最多只允许回源一次（缓存命中时是 0 次）；缓存彻底失效会变成 2 次
  const fetched = bingCalls.length - before
  assert.ok(fetched <= 1, `两次首页请求回源了 ${fetched} 次 Bing，期望 <= 1`)
  assert.equal(calls.length, 0, '首页不该请求 GitHub 上游')
})

// 32. 壁纸视觉所需的结构 / CSS / 轮播参数都在
await test('homepage contains wallpaper markup, CSS and carousel logic', async () => {
  reset()
  const html = await (await run('/')).text()
  assert.match(html, /GitHub 文件加速/)
  for (const needle of [
    'id="wallpaper"',
    'id="wallpaper-a"',
    'id="wallpaper-b"',
    'id="wallpaper-credit"',
    'wallpaper-mask',
    'background-size: cover',
    'background-position: center',
    'transition: opacity 1.6s',
    'const WALLPAPER_CFG',        // 背景配置注入点
    'setInterval(tick, INTERVAL)',
    'WALLPAPERS.length < 2',     // 0/1 张不轮播
    'preload',                   // 切换前预加载，避免闪白
    'toSubmit',                  // 原有的提交逻辑不能丢
    // Ken Burns：图层展示期间缓慢推近
    'transform: scale(1);',
    'transform: scale(1.045);',
    'transform var(--wallpaper-zoom-ms',
    'var(--wallpaper-opacity, 1)',
  ]) {
    assert.ok(html.includes(needle), '缺少 ' + needle)
  }
  // 遮罩和说明文字必须压在图层（z-index 1/2）之上，否则会被壁纸盖住
  assert.match(html, /\.wallpaper-mask \{[^}]*z-index: 3;/s)
  assert.match(html, /\.wallpaper-credit \{[^}]*z-index: 4;/s)
  assert.match(html, /\.container \{[^}]*z-index: 2;/s)
})

// 33. Bing 挂了 → 静默降级，返回未改动的静态首页
await test('Bing failure falls back to the static homepage', async () => {
  const fresh = await loadFreshWorker('fail')
  try {
    const html = await (await fresh.fetch(new Request('https://demo.example/'), {}, {})).text()
    assert.equal(readWallpapers(html), null, '降级时应原样返回 HOMEPAGE_HTML')
    assert.match(html, /GitHub 文件加速/)
    assert.ok(html.includes('id="wallpaper"'), '结构保留，由脚本自行隐藏整块')
    // 失败路径必须快：模块级负缓存，第二次不再回源
    const before = bingCalls.length
    await fresh.fetch(new Request('https://demo.example/'), {}, {})
    assert.equal(bingCalls.length, before, '失败后负缓存有效期内不应再回源 Bing')
  } finally {
    bingMode = 'ok'
  }
})

// 34. 0 张图 → 不注入、不报错
await test('Bing returning 0 images renders the homepage unchanged', async () => {
  const fresh = await loadFreshWorker('empty')
  try {
    const html = await (await fresh.fetch(new Request('https://demo.example/'), {}, {})).text()
    assert.equal(readWallpapers(html), null, '0 张图时应保持空数组占位')
    assert.match(html, /GitHub 文件加速/)
    assert.ok(html.includes('const WALLPAPERS = /*__WALLPAPERS__*/[];'), '占位表达式必须是合法 JS')
  } finally {
    bingMode = 'ok'
  }
})

// 35. 1 张图 → 注入成功，但轮播分支要求 length >= 2 才启动
await test('Bing returning a single image injects it and never carousels', async () => {
  const fresh = await loadFreshWorker('one')
  try {
    const html = await (await fresh.fetch(new Request('https://demo.example/'), {}, {})).text()
    const list = readWallpapers(html)
    assert.equal(list.length, 1, 'expected exactly 1 wallpaper')
    assert.ok(list[0].url.startsWith('https://www.bing.com/'))
    assert.ok(html.includes('if (WALLPAPERS.length < 2) return;'), '单图不轮播的保护丢失')
    assert.match(html, /GitHub 文件加速/)
  } finally {
    bingMode = 'ok'
  }
})

// 36. 代理 / 伪装页路径完全不受壁纸影响
await test('proxy and camouflage paths never call the Bing api', async () => {
  reset()
  const before = bingCalls.length
  await run('/https://github.com/a/b/archive/main.zip')
  await run('/favicon.ico')
  await run('/', { headers: { 'User-Agent': 'SomeBadCrawler' }, env: { UA: 'SomeBadCrawler' } })
  await run('/', { env: { URL302: 'https://example.org/' } })
  await run('/', { env: { URL: 'nginx' } })
  assert.equal(bingCalls.length, before, '只有默认首页才会请求 Bing')
  assert.equal(calls.length, 1, '只有代理那条路径打到上游')
})

// 37. 默认背景配置
await test('homepage carries the default background config', async () => {
  reset()
  assert.deepEqual(readWallpaperCfg(await (await run('/')).text()), { interval: 12000, opacity: 1 })
})

// 38. BG_INTERVAL / BG_OPACITY 生效
await test('BG_INTERVAL and BG_OPACITY are injected into the homepage', async () => {
  reset()
  const html = await (await run('/', { env: { BG_INTERVAL: '5000', BG_OPACITY: '0.6' } })).text()
  assert.deepEqual(readWallpaperCfg(html), { interval: 5000, opacity: 0.6 })
  // 脚本侧也要读这两个值并下发给 CSS
  assert.ok(html.includes('num(cfg.interval, 12000, 3000, 600000)'), '脚本未读取 interval')
  assert.ok(html.includes("setProperty('--wallpaper-opacity'"), '透明度未下发给 CSS')
  assert.ok(html.includes("setProperty('--wallpaper-zoom-ms'"), '缩放时长未下发给 CSS')
})

// 39. 非法 / 越界的配置要被夹到安全范围
await test('invalid BG_INTERVAL and BG_OPACITY fall back to safe values', async () => {
  reset()
  const cases = [
    [{ BG_INTERVAL: '100' }, { interval: 3000, opacity: 1 }],       // 低于下限 -> 3000
    [{ BG_INTERVAL: '99999999' }, { interval: 600000, opacity: 1 }], // 超过上限 -> 600000
    [{ BG_INTERVAL: 'abc' }, { interval: 12000, opacity: 1 }],      // 非数字 -> 默认
    [{ BG_INTERVAL: '' }, { interval: 12000, opacity: 1 }],         // 空串 -> 默认
    [{ BG_OPACITY: '99' }, { interval: 12000, opacity: 1 }],        // 超范围 -> 1
    [{ BG_OPACITY: 'oops' }, { interval: 12000, opacity: 1 }],      // 非数字 -> 默认
    [{ BG_OPACITY: '-5' }, { interval: 12000, opacity: 0 }],        // 负数 -> 0
  ]
  for (const [env, expected] of cases) {
    const html = await (await run('/', { env })).text()
    assert.deepEqual(readWallpaperCfg(html), expected, JSON.stringify(env))
  }
})

// 40. 降级路径不注入任何配置（返回的就是原封不动的 HOMEPAGE_HTML）
await test('Bing failure leaves the config placeholder untouched even with BG_* set', async () => {
  const fresh = await loadFreshWorker('fail')
  try {
    const html = await (await fresh.fetch(new Request('https://demo.example/'), {
      BG_INTERVAL: '5000', BG_OPACITY: '0.6',
    }, {})).text()
    assert.equal(readWallpapers(html), null)
    assert.equal(readWallpaperCfg(html), null, '降级时不该注入配置')
    assert.ok(html.includes('/*__WALLPAPER_CFG__*/{"interval":12000,"opacity":1};'), '占位表达式必须仍是合法 JS')
    assert.match(html, /GitHub 文件加速/)
  } finally {
    bingMode = 'ok'
  }
})

// 41. 背景配置不影响代理 / 伪装页
await test('BG_* env vars never affect proxy or camouflage paths', async () => {
  reset()
  const env = { BG_INTERVAL: '4000', BG_OPACITY: '0.2' }
  const before = bingCalls.length
  await run('/https://github.com/a/b/archive/main.zip', { env })
  await run('/favicon.ico', { env })
  await run('/', { env: { ...env, UA: 'SomeBadCrawler' }, headers: { 'User-Agent': 'SomeBadCrawler' } })
  await run('/', { env: { ...env, URL302: 'https://example.org/' } })
  assert.equal(bingCalls.length, before, '只有默认首页才会请求 Bing')
  assert.equal(calls.length, 1, '只有代理那条路径打到上游')
})

// ---- report ----------------------------------------------------------------
let failed = 0
for (const [st, name, msg] of results) {
  if (st === 'FAIL') failed++
  console.log(`${st}  ${name}${msg ? '\n      -> ' + msg : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
