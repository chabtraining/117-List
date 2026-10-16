// Staff sign-in for the 117-List site on Cloudflare Pages.
// Every request passes through here, so nobody gets a page or a file without a valid session.
// Accounts and sessions live in the D1 database bound as DB; SETUP_KEY (an encrypted variable)
// guards the one-time page that creates the first admin.

const COOKIE = '__Host-sid';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// One hash costs about 4 ms of CPU; the free plan allows 10 ms per request and a password change needs two.
const PBKDF2_ITER = 20000;
const PUBLIC_FILES = new Set(['/chairatchakarn-group-logo.png']);
const DAY = 86400000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    pass TEXT NOT NULL,
    must_change INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    fails INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)',
  'CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires)',
];

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Robots-Tag': 'noindex, nofollow',
};
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const enc = new TextEncoder();
const now = () => Date.now();
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array((s.match(/../g) || []).map(h => parseInt(h, 16)));
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const str = v => (typeof v === 'string' ? v : '');
const goodPassword = p => p.length >= 8 && p.length <= 128;
const noTable = e => /no such table/i.test(String(e && e.message));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isPage = p => p.endsWith('/') || p.endsWith('.html') || !/\.[A-Za-z0-9]+$/.test(p.slice(p.lastIndexOf('/')));

function normEmail(v) {
  const e = str(v).trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sha256(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}

async function checkPassword(password, stored) {
  const [, iterations, salt, want] = stored.split('$');
  return safeEqual(await pbkdf2(password, unhex(salt), Number(iterations)), want);
}

// Unknown emails still pay for one hash, so response time does not reveal which emails have accounts.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITER}$${'00'.repeat(16)}$${'00'.repeat(32)}`;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra },
  });
}

function html(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP, ...SEC },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SEC } });
}

const cookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function readCookie(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]*)'));
  return m ? m[1] : '';
}

async function currentUser(db, request) {
  const token = readCookie(request);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  try {
    return await db.prepare(
      'SELECT u.id, u.email, u.name, u.role, u.must_change, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id ' +
      'WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1'
    ).bind(await sha256(token), now()).first();
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

async function needsSetup(db) {
  try {
    return !(await db.prepare('SELECT 1 AS x FROM users LIMIT 1').first());
  } catch (e) {
    if (noTable(e)) return true;
    throw e;
  }
}

async function startSession(db, userId, t, extra = []) {
  const token = randomHex(32);
  await db.batch([
    ...extra,
    db.prepare('DELETE FROM sessions WHERE expires < ?').bind(t),
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').bind(await sha256(token), userId, t + SESSION_DAYS * DAY),
  ]);
  return cookie(token, SESSION_DAYS * 86400);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const page = isPage(path);
  if (PUBLIC_FILES.has(path)) return finish(await context.next(), false);
  const db = env.DB;
  if (!db) return page ? html(notReadyPage(), 503) : text('ระบบยังไม่พร้อมใช้งาน', 503);
  try {
    if (path.startsWith('/api/')) return await api(context, db, url);

    const user = await currentUser(db, request);
    if (!user) {
      if (!page) return text('ต้องเข้าสู่ระบบก่อน', 401);
      return html((await needsSetup(db)) ? setupPage() : loginPage(), 401);
    }
    if (user.must_change) return page ? html(passwordPage(user, true), 403) : text('ต้องเปลี่ยนรหัสผ่านก่อน', 403);
    if (path === '/account') return html(passwordPage(user, false), 200);
    if (/^\/admin(\.html|\/)?$/.test(path) && user.role !== 'admin') return html(forbiddenPage(), 403);
    return finish(await context.next(), page);
  } catch (err) {
    // Never fall through to the files on an error: a broken check must not open the site.
    console.error(err);
    return page ? html(errorPage(), 500) : text('ระบบขัดข้องชั่วคราว', 500);
  }
}

function finish(res, page) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC)) out.headers.set(k, v);
  out.headers.set('Cache-Control', page ? 'no-store' : 'private, max-age=0, must-revalidate');
  return out;
}

async function api(context, db, url) {
  const { request, env } = context;
  const path = url.pathname;
  const post = request.method === 'POST';
  let body = {};
  if (post) {
    // Only this site's own pages may post: blocks forms on other sites from acting with a signed-in cookie.
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'คำขอไม่ถูกต้อง' }, 403);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'คำขอไม่ถูกต้อง' }, 415);
    const parsed = await request.json().catch(() => null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  }

  if (path === '/api/login' && post) return login(db, body);
  if (path === '/api/setup' && post) return setup(db, env, body);

  const user = await currentUser(db, request);
  if (!user) return json({ error: 'ต้องเข้าสู่ระบบก่อน' }, 401);
  if (path === '/api/logout' && post) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (path === '/api/password' && post) return changePassword(db, user, body);
  if (path === '/api/me' && !post) {
    return json({ email: user.email, name: user.name, role: user.role, mustChange: !!user.must_change });
  }
  if (user.must_change) return json({ error: 'ต้องเปลี่ยนรหัสผ่านก่อน' }, 403);
  if (path === '/api/admin/users') {
    if (user.role !== 'admin') return json({ error: 'หน้านี้สำหรับแอดมินเท่านั้น' }, 403);
    if (!post) {
      const rows = await db.prepare(
        'SELECT id, email, name, role, active, must_change, locked_until, created_at, last_login FROM users ORDER BY name COLLATE NOCASE'
      ).all();
      return json({ me: user.id, now: now(), users: rows.results });
    }
    return adminAction(db, user, body);
  }
  return json({ error: 'ไม่พบ' }, 404);
}

async function login(db, body) {
  const email = normEmail(body.email);
  const password = str(body.password);
  const fail = json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }, 401);
  if (!email || !password || password.length > 128) return fail;
  let u;
  try {
    u = await db.prepare('SELECT id, pass, active, fails, locked_until FROM users WHERE email = ?').bind(email).first();
  } catch (e) {
    if (noTable(e)) return fail;
    throw e;
  }
  if (!u) {
    await checkPassword(password, DUMMY_HASH);
    return fail;
  }
  const t = now();
  if (u.locked_until > t) {
    return json({ error: `ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว ลองใหม่ในอีก ${Math.ceil((u.locked_until - t) / 60000)} นาที` }, 429);
  }
  if (!(await checkPassword(password, u.pass))) {
    const fails = u.fails + 1;
    if (fails >= MAX_FAILS) {
      await db.prepare('UPDATE users SET fails = 0, locked_until = ? WHERE id = ?').bind(t + LOCK_MINUTES * 60000, u.id).run();
      return json({ error: `ใส่รหัสผ่านผิด ${MAX_FAILS} ครั้ง บัญชีถูกล็อก ${LOCK_MINUTES} นาที` }, 429);
    }
    await db.prepare('UPDATE users SET fails = ? WHERE id = ?').bind(fails, u.id).run();
    return fail;
  }
  if (!u.active) return json({ error: 'บัญชีนี้ถูกปิดใช้งาน ติดต่อแอดมิน' }, 403);
  const setCookie = await startSession(db, u.id, t, [
    db.prepare('UPDATE users SET fails = 0, locked_until = 0, last_login = ? WHERE id = ?').bind(t, u.id),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie });
}

async function setup(db, env, body) {
  const key = str(env.SETUP_KEY);
  if (!key) return json({ error: 'ยังไม่ได้ตั้งค่า SETUP_KEY ใน Cloudflare' }, 503);
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  if (!(await needsSetup(db))) return json({ error: 'ตั้งค่าไปแล้ว ให้เข้าสู่ระบบได้เลย' }, 409);
  if (!safeEqual(await sha256(str(body.key)), await sha256(key))) return json({ error: 'รหัสตั้งค่าไม่ถูกต้อง' }, 403);
  const name = str(body.name).trim();
  const email = normEmail(body.email);
  const password = str(body.password);
  if (!name || name.length > 100) return json({ error: 'กรอกชื่อ-นามสกุล' }, 400);
  if (!email) return json({ error: 'อีเมลไม่ถูกต้อง' }, 400);
  if (!goodPassword(password)) return json({ error: 'รหัสผ่านต้องยาว 8 ตัวอักษรขึ้นไป' }, 400);
  const t = now();
  await db.prepare("INSERT INTO users (email, name, role, pass, must_change, created_at, last_login) VALUES (?, ?, 'admin', ?, 0, ?, ?)")
    .bind(email, name, await hashPassword(password), t, t).run();
  const u = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  return json({ ok: true }, 200, { 'Set-Cookie': await startSession(db, u.id, t) });
}

async function changePassword(db, user, body) {
  const current = str(body.current);
  const next = str(body.password);
  if (!goodPassword(next)) return json({ error: 'รหัสผ่านใหม่ต้องยาว 8 ตัวอักษรขึ้นไป' }, 400);
  if (next === current) return json({ error: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม' }, 400);
  const u = await db.prepare('SELECT pass FROM users WHERE id = ?').bind(user.id).first();
  if (!current || current.length > 128 || !(await checkPassword(current, u.pass))) {
    return json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' }, 400);
  }
  // Signs out every other device; this one keeps its session.
  await db.batch([
    db.prepare('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?').bind(await hashPassword(next), user.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(user.id, user.token_hash),
  ]);
  return json({ ok: true });
}

async function adminAction(db, user, body) {
  const action = str(body.action);
  if (action === 'create') {
    const name = str(body.name).trim();
    const email = normEmail(body.email);
    const password = str(body.password);
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!name || name.length > 100) return json({ error: 'กรอกชื่อ-นามสกุล' }, 400);
    if (!email) return json({ error: 'อีเมลไม่ถูกต้อง' }, 400);
    if (!goodPassword(password)) return json({ error: 'รหัสผ่านเริ่มต้นต้องยาว 8 ตัวอักษรขึ้นไป' }, 400);
    if (await db.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) {
      return json({ error: 'อีเมลนี้มีบัญชีอยู่แล้ว' }, 409);
    }
    await db.prepare('INSERT INTO users (email, name, role, pass, must_change, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .bind(email, name, role, await hashPassword(password), now()).run();
    return json({ ok: true });
  }

  const id = Number(body.id);
  const target = Number.isInteger(id) ? await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first() : null;
  if (!target) return json({ error: 'ไม่พบผู้ใช้' }, 404);
  if (id === user.id) return json({ error: 'แก้บัญชีของตัวเองที่หน้านี้ไม่ได้ ใช้เมนูเปลี่ยนรหัสผ่านแทน' }, 400);
  const signOut = db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id);

  if (action === 'reset') {
    const password = str(body.password);
    if (!goodPassword(password)) return json({ error: 'รหัสผ่านเริ่มต้นต้องยาว 8 ตัวอักษรขึ้นไป' }, 400);
    await db.batch([
      db.prepare('UPDATE users SET pass = ?, must_change = 1, fails = 0, locked_until = 0 WHERE id = ?').bind(await hashPassword(password), id),
      signOut,
    ]);
    return json({ ok: true });
  }
  if (action === 'unlock') {
    await db.prepare('UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (action === 'active') {
    const active = body.active ? 1 : 0;
    const update = db.prepare('UPDATE users SET active = ? WHERE id = ?').bind(active, id);
    await db.batch(active ? [update] : [update, signOut]);
    return json({ ok: true });
  }
  if (action === 'role') {
    await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role === 'admin' ? 'admin' : 'user', id).run();
    return json({ ok: true });
  }
  if (action === 'delete') {
    await db.batch([db.prepare('DELETE FROM users WHERE id = ?').bind(id), signOut]);
    return json({ ok: true });
  }
  return json({ error: 'คำสั่งไม่ถูกต้อง' }, 400);
}

// Pages served by this file. They show at whatever address was asked for, so after signing in
// a reload opens the page the person wanted in the first place.
function shell(title, body, script = '') {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${title} - ตรวจเช็ก 117 รายการ</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 28px 16px;
    background: linear-gradient(180deg, #FFFFFF 0, #F6F6F4 230px, #FFFFFF 100%);
    color: #111110; font-family: 'IBM Plex Sans Thai', system-ui, sans-serif;
  }
  body::before { content: ""; position: fixed; inset: 0 0 auto 0; height: 4px; background: #C8102E; }
  .card {
    width: 100%; max-width: 400px; padding: 26px 24px; background: #FFFFFF;
    border: 1px solid #E3E3DF; border-top: 4px solid #C8102E; border-radius: 8px;
    box-shadow: 0 10px 26px rgba(17, 17, 16, 0.06);
  }
  .logo { display: block; width: 200px; max-width: 70%; height: auto; margin-bottom: 18px; }
  h1 { font-size: 24px; font-weight: 700; line-height: 1.3; margin-bottom: 4px; }
  .sub { font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
  label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 14px; }
  input {
    display: block; width: 100%; margin-top: 6px; padding: 11px 12px; font: inherit; font-size: 16px; font-weight: 400;
    color: #111110; background: #FFFFFF; border: 1px solid #CBCBC6; border-radius: 8px;
  }
  input:focus { outline: none; border-color: #C8102E; box-shadow: 0 0 0 3px #F3E6E9; }
  button {
    width: 100%; margin-top: 4px; padding: 12px; font: inherit; font-size: 16px; font-weight: 700;
    color: #FFFFFF; background: #C8102E; border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #980C22; }
  button:disabled { opacity: 0.6; cursor: wait; }
  .msg { min-height: 20px; margin: -4px 0 8px; color: #DC2626; font-size: 14px; }
  .foot { margin-top: 18px; font-size: 14px; line-height: 1.6; }
  .foot a { color: #980C22; font-weight: 600; }
</style>
</head>
<body>
<main class="card">
<img class="logo" src="/chairatchakarn-group-logo.png" alt="กลุ่มบริษัทชัยรัชการ CHAIRATCHAKARN GROUP">
${body}
</main>
<script>
function send(url, data) {
  return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, data: j }; }); });
}
function wire(form, url, check, done) {
  var msg = form.querySelector('.msg');
  var btn = form.querySelector('button');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form));
    var problem = check(data);
    if (problem) { msg.textContent = problem; return; }
    btn.disabled = true;
    msg.textContent = '';
    send(url, data).then(function (res) {
      if (res.ok) return done();
      msg.textContent = res.data.error || 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง';
      btn.disabled = false;
    }).catch(function () {
      msg.textContent = 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
      btn.disabled = false;
    });
  });
}
function logout() {
  var clear = window.caches ? caches.keys().then(function (k) { return Promise.all(k.map(function (n) { return caches.delete(n); })); }) : Promise.resolve();
  clear.catch(function () {}).then(function () { return send('/api/logout', {}); }).catch(function () {}).then(function () { location.href = '/'; });
}
${script}
</script>
</body>
</html>`;
}

const loginPage = () => shell('เข้าสู่ระบบ', `
<h1>เข้าสู่ระบบ</h1>
<p class="sub">ระบบตรวจเช็ก 117 รายการ สำหรับพนักงาน</p>
<form id="f" method="post" novalidate>
  <label>อีเมล<input name="email" type="email" autocomplete="username" required></label>
  <label>รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label>
  <p class="msg" role="alert"></p>
  <button type="submit">เข้าสู่ระบบ</button>
</form>
<p class="foot">ลืมรหัสผ่าน ติดต่อแอดมินเพื่อรีเซ็ตรหัส</p>`, `
wire(document.getElementById('f'), '/api/login', function (d) {
  return d.email && d.password ? '' : 'กรอกอีเมลและรหัสผ่านให้ครบ';
}, function () { location.reload(); });`);

const setupPage = () => shell('ตั้งค่าครั้งแรก', `
<h1>ตั้งค่าครั้งแรก</h1>
<p class="sub">สร้างบัญชีแอดมินคนแรก หน้านี้ใช้ได้ครั้งเดียว</p>
<form id="f" method="post" novalidate>
  <label>รหัสตั้งค่า SETUP_KEY<input name="key" type="password" autocomplete="off" required></label>
  <label>ชื่อ-นามสกุล<input name="name" autocomplete="name" maxlength="100" required></label>
  <label>อีเมล<input name="email" type="email" autocomplete="username" required></label>
  <label>รหัสผ่าน 8 ตัวอักษรขึ้นไป<input name="password" type="password" autocomplete="new-password" required></label>
  <label>ยืนยันรหัสผ่าน<input name="confirm" type="password" autocomplete="new-password" required></label>
  <p class="msg" role="alert"></p>
  <button type="submit">สร้างบัญชีแอดมิน</button>
</form>`, `
wire(document.getElementById('f'), '/api/setup', function (d) {
  if (!d.key || !d.name.trim() || !d.email || !d.password) return 'กรอกข้อมูลให้ครบทุกช่อง';
  if (d.password.length < 8) return 'รหัสผ่านต้องยาว 8 ตัวอักษรขึ้นไป';
  if (d.password !== d.confirm) return 'ยืนยันรหัสผ่านไม่ตรงกัน';
  return '';
}, function () { location.reload(); });`);

const passwordPage = (user, forced) => shell('เปลี่ยนรหัสผ่าน', `
<h1>เปลี่ยนรหัสผ่าน</h1>
<p class="sub">${forced ? `สวัสดีคุณ ${esc(user.name)} เข้าใช้ครั้งแรกต้องตั้งรหัสผ่านใหม่ของตัวเองก่อน` : esc(user.name)}</p>
<form id="f" method="post" novalidate>
  <label>${forced ? 'รหัสผ่านเริ่มต้นที่ได้จากแอดมิน' : 'รหัสผ่านปัจจุบัน'}<input name="current" type="password" autocomplete="current-password" required></label>
  <label>รหัสผ่านใหม่ 8 ตัวอักษรขึ้นไป<input name="password" type="password" autocomplete="new-password" required></label>
  <label>ยืนยันรหัสผ่านใหม่<input name="confirm" type="password" autocomplete="new-password" required></label>
  <p class="msg" role="alert"></p>
  <button type="submit">บันทึกรหัสผ่านใหม่</button>
</form>
<p class="foot">${forced ? '' : '<a href="/">กลับหน้าหลัก</a> · '}<a href="#" id="out">ออกจากระบบ</a></p>`, `
wire(document.getElementById('f'), '/api/password', function (d) {
  if (!d.current || !d.password) return 'กรอกรหัสผ่านให้ครบ';
  if (d.password.length < 8) return 'รหัสผ่านใหม่ต้องยาว 8 ตัวอักษรขึ้นไป';
  if (d.password !== d.confirm) return 'ยืนยันรหัสผ่านใหม่ไม่ตรงกัน';
  return '';
}, function () { ${forced ? 'location.reload();' : "location.href = '/';"} });
document.getElementById('out').addEventListener('click', function (e) { e.preventDefault(); logout(); });`);

const forbiddenPage = () => shell('ไม่มีสิทธิ์', `
<h1>ไม่มีสิทธิ์เข้าหน้านี้</h1>
<p class="sub">หน้านี้สำหรับแอดมินเท่านั้น</p>
<p class="foot"><a href="/">กลับหน้าหลัก</a></p>`);

const errorPage = () => shell('ระบบขัดข้อง', `
<h1>ระบบขัดข้องชั่วคราว</h1>
<p class="sub">ลองเปิดใหม่อีกครั้งในอีกสักครู่</p>`);

const notReadyPage = () => shell('ระบบยังไม่พร้อม', `
<h1>ระบบยังไม่พร้อมใช้งาน</h1>
<p class="sub">ยังไม่ได้เชื่อมฐานข้อมูล DB กับเว็บใน Cloudflare</p>`);
