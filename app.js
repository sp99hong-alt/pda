'use strict';
/* PDA 입고·빈병합 - 오프라인 우선 웹앱
 * 기록은 PDA(IndexedDB)에 먼저 저장하고, 와이파이 구역에서 [업로드]하면 Google 시트로 전송합니다. */

const APP_VERSION = '1.0.0';
const CFG = window.PDA_CONFIG || {};
const $ = id => document.getElementById(id);
const TYPES_INBOUND = ['국내입고', '해외입고'];

const S = {
  user: null, center: null, master: null, bcMap: new Map(), deviceId: '', deviceSalt: '',
  mode: null, ibItem: null, lastExp: {},
  bin: { step: 1, job: null, scanMode: '단건', basket: [], pending: null, item: null },
  syncing: false, rcTab: 'local', serverRecs: [], screen: 'login'
};

/* ============================== 공용 도우미 ============================== */

const pad = n => String(n).padStart(2, '0');
const norm = v => String(v == null ? '' : v).trim();
const normCell = v => norm(v).toUpperCase();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const intVal = el => { const s = String(el.value).replace(/[^0-9]/g, ''); return s === '' ? 0 : parseInt(s, 10); };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtTime = iso => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const apiUrl = () => localStorage.getItem('pda.apiUrl') || CFG.API_URL || '';

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function randHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');
}

let actx = null;
function beep(ok) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square';
    o.frequency.value = ok ? 1800 : 280;
    g.gain.value = 0.07;
    o.connect(g); g.connect(actx.destination);
    o.start();
    o.stop(actx.currentTime + (ok ? 0.08 : 0.35));
  } catch (e) { /* 소리 미지원 */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 40 : [120, 60, 120]);
}

let toastTimer = null;
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (type === 'err' ? ' err' : type === 'warn' ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), type === 'err' ? 3500 : 2200);
}

function fail(el, msg) {
  beep(false);
  toast(msg, 'err');
  if (el) {
    el.classList.add('err');
    el.focus();
    if (el.select) el.select();
  }
  return false;
}

function modal({ title, body = '', html = false, buttons, onOpen }) {
  buttons = buttons || [{ label: '확인', value: true, cls: 'primary' }];
  return new Promise(resolve => {
    $('modal-title').textContent = title;
    const b = $('modal-body');
    if (html) b.innerHTML = body; else b.textContent = body;
    const bw = $('modal-btns');
    bw.innerHTML = '';
    const close = v => {
      $('modal').classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = e => {
      if ((e.key === 'Enter' || e.keyCode === 13) && e.target.tagName === 'INPUT') {
        e.preventDefault();
        e.stopPropagation();
        const p = bw.querySelector('[data-primary]');
        if (p) p.click();
      }
    };
    // Enter 키로 누를 버튼: primary 지정 버튼, 없으면 마지막 색상 버튼
    let pIdx = buttons.findIndex(b => b.primary);
    if (pIdx < 0) buttons.forEach((b, i) => { if (b.cls && b.value !== false && b.value !== null) pIdx = i; });
    buttons.forEach((btn, i) => {
      const e = document.createElement('button');
      e.type = 'button';
      e.className = 'btn ' + (btn.cls || '');
      e.textContent = btn.label;
      if (i === pIdx) e.dataset.primary = '1';
      e.onclick = async () => {
        if (btn.validate) { const ok = await btn.validate(); if (!ok) return; }
        close(typeof btn.value === 'function' ? btn.value() : btn.value);
      };
      bw.appendChild(e);
    });
    document.addEventListener('keydown', onKey, true);
    $('modal').classList.remove('hidden');
    if (onOpen) onOpen(b);
  });
}

const confirmBox = (title, msg, okLabel = '확인', cls = 'primary') =>
  modal({ title, body: msg, buttons: [{ label: '취소', value: false }, { label: okLabel, value: true, cls }] });

function promptBox(title, msg, opt = {}) {
  const id = 'pb-' + Date.now();
  return modal({
    title, html: true,
    body: `${esc(msg)}<input id="${id}" type="${opt.type || 'text'}" inputmode="${opt.inputmode || 'text'}" value="${esc(opt.value || '')}" placeholder="${esc(opt.placeholder || '')}" autocomplete="off">`,
    buttons: [{ label: '취소', value: null }, { label: opt.okLabel || '확인', cls: 'primary', value: () => $(id).value }],
    onOpen: () => setTimeout(() => { $(id).focus(); $(id).select(); }, 50)
  });
}

function onEnter(el, fn) {
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); fn(); }
  });
  el.addEventListener('input', () => el.classList.remove('err'));
}

function focusSel(el) {
  setTimeout(() => { el.focus(); if (el.select) el.select(); }, 30);
}

function parseExp(v) {
  const s = String(v || '').replace(/\D/g, '');
  if (!s) return { ok: false, empty: true, msg: '' };
  let y, m, d;
  if (s.length === 6) { y = 2000 + Number(s.slice(0, 2)); m = Number(s.slice(2, 4)); d = Number(s.slice(4, 6)); }
  else if (s.length === 8) { y = Number(s.slice(0, 4)); m = Number(s.slice(4, 6)); d = Number(s.slice(6, 8)); }
  else return { ok: false, msg: '6자리(YYMMDD) 또는 8자리(YYYYMMDD)로 입력하세요' };
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return { ok: false, msg: '없는 날짜입니다' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((dt - today) / 86400000);
  if (days > 365 * 15) return { ok: false, msg: '유통기한이 너무 먼 날짜입니다' };
  if (days < -365 * 5) return { ok: false, msg: '유통기한이 너무 지난 날짜입니다' };
  return { ok: true, date: `${y}-${pad(m)}-${pad(d)}`, days, past: days < 0, raw: s };
}

function showExp(input, view) {
  const p = parseExp(input.value);
  view.className = 'hint';
  if (p.ok) {
    view.textContent = p.past ? `${p.date} · 유통기한 경과 ${-p.days}일` : `${p.date} · D-${p.days}`;
    if (p.past) view.className = 'hint bad';
    else if (p.days <= 30) view.className = 'hint warn';
  } else {
    view.textContent = p.msg || '';
    if (p.msg) view.className = 'hint bad';
  }
  return p;
}

function totalOf(box, loose, ipsu) {
  if (box > 0 && !(ipsu > 0)) return '';
  return box * (ipsu || 0) + loose;
}

function qtyText(r) {
  if (r.type === '빈병합') return `${r.loose} EA`;
  const t = r.total === '' || r.total == null ? '' : ` = ${r.total} EA`;
  return `${r.box}박스 ${r.loose}낱개${t}`;
}

/* ============================== 마스터 ============================== */

const EMPTY_MASTER = { centers: [], barcodes: [], locations: {}, activeUsers: [], config: {}, syncedAt: '' };

function buildMaps() {
  S.bcMap = new Map();
  const items = new Map();
  for (const [barcode, item, name, ipsu] of (S.master.barcodes || [])) {
    const o = { barcode, item, name, ipsu: Number(ipsu) || 0 };
    S.bcMap.set(barcode.toUpperCase(), o);
    if (item && !items.has(item.toUpperCase())) items.set(item.toUpperCase(), o);
  }
  for (const [k, o] of items) if (!S.bcMap.has(k)) S.bcMap.set(k, o);
}

function lookup(code) {
  return S.bcMap.get(norm(code).toUpperCase()) || null;
}

function validCell(cell) {
  const list = (S.master.locations || {})[S.center ? S.center.code : ''] || [];
  return !list.length || list.includes(cell);
}

async function saveMaster(m) {
  S.master = Object.assign({}, EMPTY_MASTER, m);
  await DB.kvSet('master', S.master);
  buildMaps();
  // 사용 중지된 사용자의 오프라인 로그인 정보 삭제, 이름·역할·센터 갱신
  const vers = await DB.kvGet('verifiers', {});
  const active = new Map((S.master.activeUsers || []).map(u => [u.s, u]));
  for (const sab of Object.keys(vers)) {
    const a = active.get(sab);
    if (!a) delete vers[sab];
    else Object.assign(vers[sab].profile, { name: a.n, role: a.r, center: a.c });
  }
  await DB.kvSet('verifiers', vers);
  if (S.user && !active.has(S.user.sabun) && (S.master.activeUsers || []).length) {
    toast('사용이 중지된 사용자입니다. 로그아웃합니다.', 'err');
    await logout(true);
  } else if (S.user && active.has(S.user.sabun)) {
    const a = active.get(S.user.sabun);
    const roleChanged = a.r !== S.user.role;
    Object.assign(S.user, { name: a.n, role: a.r, center: a.c });
    if (roleChanged) { toast('역할이 변경되어 화면을 다시 엽니다.', 'warn'); applyRoleUI(); }
  }
}

/* ============================== 서버 통신 ============================== */

async function api(action, payload = {}, timeout = 30000) {
  const url = apiUrl();
  if (!url) throw Object.assign(new Error('서버 주소가 설정되지 않았습니다. (config.js 또는 로그인 화면의 서버 설정)'), { code: 'NOURL' });
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload)), signal: ctl.signal, redirect: 'follow'
    });
  } catch (e) {
    throw Object.assign(new Error('서버에 연결할 수 없습니다. 와이파이를 확인하세요.'), { code: 'NET' });
  } finally {
    clearTimeout(tm);
  }
  let data;
  try { data = await res.json(); } catch (e) {
    throw Object.assign(new Error(`서버 응답 오류 (${res.status})`), { code: 'NET' });
  }
  if (!data.ok) {
    if (data.code === 'TOKEN' && S.user) await clearToken(S.user.sabun);
    throw Object.assign(new Error(data.error || '서버 오류'), { code: data.code });
  }
  return data;
}

async function getToken(sabun) {
  const toks = await DB.kvGet('tokens', {});
  const t = toks[sabun];
  return t && t.exp > Date.now() + 60000 ? t.token : null;
}

async function saveToken(sabun, token, exp) {
  const toks = await DB.kvGet('tokens', {});
  toks[sabun] = { token, exp };
  await DB.kvSet('tokens', toks);
}

async function clearToken(sabun) {
  const toks = await DB.kvGet('tokens', {});
  delete toks[sabun];
  await DB.kvSet('tokens', toks);
}

// 업로드·조회용 토큰. 없거나 만료되면 (interactive일 때) PIN을 다시 받아 온라인 로그인
async function ensureToken(interactive) {
  const t = await getToken(S.user.sabun);
  if (t) return t;
  if (!interactive) return null;
  const pin = await promptBox('PIN 확인', `서버 접속을 위해 ${S.user.name}(${S.user.sabun}) 님의 PIN을 입력하세요.`, { type: 'password', inputmode: 'numeric' });
  if (!pin) return null;
  const res = await api('login', { sabun: S.user.sabun, pin });
  await afterOnlineLogin(res, pin);
  return res.token;
}

async function afterOnlineLogin(res, pin) {
  await saveToken(res.user.sabun, res.token, res.tokenExp);
  const vers = await DB.kvGet('verifiers', {});
  vers[res.user.sabun] = { hash: await pinVerifier(res.user.sabun, pin), profile: res.user, at: Date.now() };
  await DB.kvSet('verifiers', vers);
  await saveMaster(res.master);
}

async function pinVerifier(sabun, pin) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(S.deviceSalt + ':' + sabun), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============================== 업로드(동기화) ============================== */

const toServer = r => ({
  id: r.id, time: r.time, center: r.center, type: r.type, sabun: r.sabun, name: r.name, device: r.device,
  jobId: r.jobId, from: r.from, barcode: r.barcode, item: r.item, itemName: r.itemName, box: r.box,
  loose: r.loose, ipsu: r.ipsu, total: r.total, expiry: r.expiry, to: r.to, scanMode: r.scanMode, note: r.note
});
const jobToServer = j => ({
  id: j.id, center: j.center, from: j.from, sabun: j.sabun, name: j.name, start: j.start, end: j.end,
  emptyConfirmed: j.emptyConfirmed, count: j.count, total: j.total, device: j.device
});

async function sync(interactive) {
  if (S.syncing || !S.user) return;
  S.syncing = true;
  $('tb-sync').innerHTML = '전송 중…';
  try {
    const token = await ensureToken(interactive);
    if (!token) return;
    let ok = 0, bad = 0;
    if (S.user.role !== '조회자') {
      const pend = (await DB.all('records')).filter(r => r.syncStatus === 'pending').sort((a, b) => a.time.localeCompare(b.time));
      const jobs = (await DB.all('jobs')).filter(j => j.closed && !j.uploaded);
      const batch = CFG.UPLOAD_BATCH || 200;
      for (let i = 0; i === 0 || i < pend.length; i += batch) {
        const chunk = pend.slice(i, i + batch);
        const jchunk = i === 0 ? jobs : [];
        if (!chunk.length && !jchunk.length) break;
        const res = await api('upload', { token, device: S.deviceId, records: chunk.map(toServer), jobs: jchunk.map(jobToServer) }, 60000);
        const acc = new Set(res.accepted);
        const rej = new Map(res.rejected.map(x => [x.id, x.error]));
        for (const r of chunk) {
          if (acc.has(r.id)) { r.syncStatus = 'uploaded'; r.uploadedAt = Date.now(); delete r.error; ok++; }
          else if (rej.has(r.id)) { r.syncStatus = 'rejected'; r.error = rej.get(r.id); bad++; }
        }
        if (chunk.length) await DB.putMany('records', chunk);
        const jacc = new Set(res.jobsAccepted);
        jchunk.forEach(j => { if (jacc.has(j.id)) { j.uploaded = true; j.uploadedAt = Date.now(); } });
        if (jchunk.length) await DB.putMany('jobs', jchunk);
      }
    }
    const m = await api('master', { token });
    await saveMaster(m.master);
    await purgeOld();
    await DB.kvSet('lastSync', Date.now());
    if (bad) toast(`업로드 ${ok}건 완료, ${bad}건 거부 (기록 조회에서 확인)`, 'warn');
    else if (interactive || ok) toast(ok ? `업로드 ${ok}건 완료 · 마스터 갱신` : '보낼 기록 없음 · 마스터 갱신 완료');
    if (S.screen === 'records') renderRecords();
  } catch (e) {
    if (interactive) toast(e.message, 'err');
  } finally {
    S.syncing = false;
    refreshPending();
    renderRecent();
  }
}

let syncTimer = null;
function trySyncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if (navigator.onLine && S.user && apiUrl() && await getToken(S.user.sabun)) sync(false);
  }, 3000);
}

async function purgeOld() {
  const keep = (CFG.KEEP_UPLOADED_DAYS || 7) * 86400000;
  const cut = Date.now() - keep;
  for (const r of await DB.all('records')) if (r.syncStatus === 'uploaded' && (r.uploadedAt || 0) < cut) await DB.del('records', r.id);
  for (const j of await DB.all('jobs')) if (j.uploaded && (j.uploadedAt || 0) < cut) await DB.del('jobs', j.id);
}

async function refreshPending() {
  const all = await DB.all('records');
  const n = all.filter(r => r.syncStatus === 'pending').length;
  const rj = all.filter(r => r.syncStatus === 'rejected').length;
  $('tb-sync').innerHTML = `미전송 <b id="tb-pending">${n}</b>` + (rj ? ` · 거부 ${rj}` : '');
  $('tb-sync').classList.toggle('has', n + rj > 0);
  const lc = $('rc-local-count');
  if (lc) lc.textContent = all.filter(r => r.syncStatus !== 'uploaded' && visibleLocal(r)).length;
}

function updateNet() {
  const on = navigator.onLine;
  $('tb-net').className = 'net ' + (on ? 'on' : 'off');
  $('tb-net').title = on ? '네트워크 연결됨' : '오프라인';
  $('lg-net').textContent = on ? '● 온라인' : '○ 오프라인';
}

/* ============================== 로그인 ============================== */

async function doLogin() {
  const sabun = norm($('lg-sabun').value), pin = norm($('lg-pin').value);
  const msg = $('lg-msg');
  msg.className = 'msg';
  if (!sabun || !pin) { msg.textContent = '사번과 PIN을 입력하세요.'; return; }
  const lockKey = 'pda.fail.' + sabun;
  const lock = JSON.parse(localStorage.getItem(lockKey) || '{"n":0,"until":0}');
  if (lock.until > Date.now()) { msg.textContent = `PIN을 여러 번 틀렸습니다. ${Math.ceil((lock.until - Date.now()) / 60000)}분 뒤 다시 시도하세요.`; return; }

  $('lg-btn').disabled = true;
  msg.textContent = '로그인 중…';
  let profile = null;
  try {
    if (apiUrl() && navigator.onLine) {
      try {
        const res = await api('login', { sabun, pin }, 15000);
        await afterOnlineLogin(res, pin);
        profile = res.user;
      } catch (e) {
        if (e.code !== 'NET' && e.code !== 'NOURL') throw e; // PIN 오류·잠금은 그대로 표시
      }
    }
    if (!profile) {
      const vers = await DB.kvGet('verifiers', {});
      const v = vers[sabun];
      if (!v) throw new Error('이 기기에서 처음 로그인하는 사용자입니다. 와이파이 구역에서 로그인하세요.');
      if (await pinVerifier(sabun, pin) !== v.hash) {
        lock.n += 1;
        if (lock.n >= 5) { lock.until = Date.now() + 5 * 60000; lock.n = 0; }
        localStorage.setItem(lockKey, JSON.stringify(lock));
        throw new Error('사번 또는 PIN이 맞지 않습니다.');
      }
      profile = v.profile;
    }
    localStorage.removeItem(lockKey);
    $('lg-pin').value = '';
    msg.textContent = '';
    await startSession(profile);
  } catch (e) {
    msg.textContent = e.message;
    beep(false);
  } finally {
    $('lg-btn').disabled = false;
  }
}

async function startSession(profile, centerCode) {
  S.user = Object.assign({}, profile);
  S.center = null;
  if (S.user.role !== '조회자') {
    const centers = S.master.centers || [];
    const allowed = !S.user.center || S.user.center === '전체' ? centers
      : centers.filter(c => S.user.center.split(',').map(s => s.trim()).includes(c.code));
    if (!allowed.length) {
      S.user = null;
      throw new Error('센터 정보가 없습니다. 관리자에게 [센터]·[사용자] 시트 설정을 요청하거나 와이파이 구역에서 다시 로그인하세요.');
    }
    let c = centerCode ? allowed.find(x => x.code === centerCode) : null;
    if (!c && allowed.length === 1) c = allowed[0];
    if (!c) {
      const btns = allowed.map(x => ({ label: x.name || x.code, value: x.code, cls: 'primary' }));
      const code = await modal({ title: '센터 선택', body: '작업할 센터를 선택하세요.', buttons: btns });
      c = allowed.find(x => x.code === code);
    }
    S.center = c;
  }
  localStorage.setItem('pda.session', JSON.stringify({ sabun: S.user.sabun, center: S.center ? S.center.code : '', lastActive: Date.now() }));
  await closeStaleJobs();
  applyRoleUI();
  trySyncSoon();
}

function applyRoleUI() {
  const u = S.user;
  $('topbar').classList.remove('hidden');
  $('tb-user').textContent = `${u.name} (${u.role})`;
  $('tb-center').textContent = S.center ? (S.center.name || S.center.code) : '전체';
  $('menu-user').innerHTML = `<b>${esc(u.name)}</b> · ${esc(u.sabun)}<br><span class="muted">${esc(u.role)} · ${esc(S.center ? S.center.name : '전체')}</span>`;
  const canWork = u.role !== '조회자';
  $('menu-work').classList.toggle('hidden', !canWork);
  $('rc-worker-wrap').classList.toggle('hidden', u.role === '작업자');
  $('rc-deleted-wrap').classList.toggle('hidden', u.role !== '관리자');
  $('rc-csv').classList.toggle('hidden', u.role !== '관리자');
  refreshPending();
  if (canWork) {
    showScreen('work');
    setMode(localStorage.getItem('pda.mode') || '국내입고');
  } else {
    S.rcTab = 'server';
    showScreen('records');
  }
}

async function logout(force) {
  if (!force && S.bin.job && (S.bin.basket.length || S.bin.pending)) {
    if (!await confirmBox('로그아웃', '저장하지 않은 빈병합 상품이 있습니다. 그래도 로그아웃할까요?', '로그아웃', 'red')) return;
  }
  localStorage.removeItem('pda.session');
  S.user = null; S.center = null;
  S.bin = { step: 1, job: null, scanMode: '단건', basket: [], pending: null, item: null };
  $('topbar').classList.add('hidden');
  $('menu').classList.add('hidden');
  showScreen('login');
  focusSel($('lg-sabun'));
}

let lastTouch = 0;
function touchActive() {
  const now = Date.now();
  if (now - lastTouch < 20000) return;
  lastTouch = now;
  const s = JSON.parse(localStorage.getItem('pda.session') || 'null');
  if (s) { s.lastActive = now; localStorage.setItem('pda.session', JSON.stringify(s)); }
}

function idleCheck() {
  const s = JSON.parse(localStorage.getItem('pda.session') || 'null');
  if (S.user && s && Date.now() - s.lastActive > (CFG.IDLE_LOGOUT_MIN || 120) * 60000) {
    logout(true);
    toast('오랫동안 사용하지 않아 로그아웃되었습니다.', 'warn');
  }
}

/* ============================== 화면 전환 ============================== */

function showScreen(name) {
  S.screen = name;
  ['login', 'work', 'records'].forEach(n => $('scr-' + n).classList.toggle('hidden', n !== name));
  if (name === 'records') initRecords();
}

function setMode(mode) {
  if (!['국내입고', '해외입고', '빈병합'].includes(mode)) mode = '국내입고';
  S.mode = mode;
  document.body.dataset.mode = mode;
  localStorage.setItem('pda.mode', mode);
  document.querySelectorAll('.mode-tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const inbound = TYPES_INBOUND.includes(mode);
  $('pane-inbound').classList.toggle('hidden', !inbound);
  $('pane-bin').classList.toggle('hidden', inbound);
  if (inbound) ibEnter(); else binEnter();
}

function fixedCell() {
  if (!S.center) return '';
  return normCell(S.mode === '국내입고' ? S.center.domestic : S.center.overseas);
}

/* ============================== 국내/해외입고 ============================== */

function ibEnter() {
  $('ib-title').textContent = S.mode;
  const fc = fixedCell();
  $('ib-fixed').textContent = fc || '(미설정)';
  if (!fc) toast(`[센터] 시트에 ${S.mode} 고정셀이 없습니다. 관리자에게 요청하세요.`, 'err');
  renderRecent();
  focusSel($('ib-barcode'));
}

function ibLookup() {
  const code = norm($('ib-barcode').value);
  const info = $('ib-item');
  S.ibItem = null;
  if (!code) { info.textContent = ''; return false; }
  const it = lookup(code);
  if (it) {
    S.ibItem = Object.assign({}, it, { barcode: code });
    info.className = 'iteminfo';
    info.textContent = `${it.item} · ${it.name}` + (it.ipsu ? ` · 입수 ${it.ipsu}` : ' · 입수 미등록');
  } else if (S.master.config && S.master.config.allowUnknownBarcode) {
    S.ibItem = { barcode: code, item: '', name: '', ipsu: 0, unknown: true };
    info.className = 'iteminfo bad';
    info.textContent = '미등록 바코드 (저장은 가능, 비고에 표시됨)';
  } else {
    info.className = 'iteminfo bad';
    info.textContent = '바코드마스터에 없는 바코드입니다.';
    return false;
  }
  ibTotal();
  return true;
}

function ibTotal() {
  const box = intVal($('ib-box')), loose = intVal($('ib-loose'));
  const ipsu = S.ibItem ? S.ibItem.ipsu : 0;
  const t = totalOf(box, loose, ipsu);
  $('ib-total').textContent = !S.ibItem ? '' : t === '' ? `입수 미등록 · 박스 ${box}, 낱개 ${loose}` : `총 ${t} EA (${box}박스 × ${ipsu} + ${loose})`;
}

async function ibSave() {
  const fc = fixedCell();
  if (!fc) return fail(null, `[센터] 시트에 ${S.mode} 고정셀이 설정되지 않았습니다.`);
  const bcEl = $('ib-barcode'), boxEl = $('ib-box'), looseEl = $('ib-loose'), expEl = $('ib-exp'), toEl = $('ib-to');
  if (!S.ibItem || S.ibItem.barcode !== norm(bcEl.value)) {
    if (!ibLookup()) return fail(bcEl, norm(bcEl.value) ? '바코드마스터에 없는 바코드입니다.' : '상품 바코드를 스캔하세요.');
  }
  const box = intVal(boxEl), loose = intVal(looseEl);
  if (box + loose <= 0) return fail(boxEl, '수량을 입력하세요.');
  if (box > 99999 || loose > 99999) return fail(boxEl, '수량이 너무 큽니다.');
  const exp = parseExp(expEl.value);
  if (!exp.ok && !exp.empty) return fail(expEl, exp.msg);   // 비대상 품목은 비워 두고 저장
  const to = normCell(toEl.value);
  if (!to) return fail(toEl, '적치빈을 스캔하세요.');
  if (to === fc) return fail(toEl, '적치빈이 고정 이동셀과 같습니다.');
  if (!validCell(to)) return fail(toEl, `등록되지 않은 셀입니다: ${to}`);
  if (exp.past && !await confirmBox('유통기한 경과', `유통기한(${exp.date})이 이미 지났습니다. 그래도 저장할까요?`, '저장', 'red')) { focusSel(expEl); return; }

  const it = S.ibItem;
  const rec = makeRecord({
    type: S.mode, from: fc, barcode: it.barcode, item: it.item, itemName: it.name, box, loose, ipsu: it.ipsu,
    expiry: exp.ok ? exp.date : '', to, scanMode: '', note: it.unknown ? '미등록바코드' : ''
  });
  await DB.put('records', rec);
  if (exp.ok) S.lastExp[it.barcode] = exp.raw;
  beep(true);
  toast(`저장 완료: ${it.name || it.barcode} → ${to}`);
  bcEl.value = ''; boxEl.value = '1'; looseEl.value = '0'; expEl.value = ''; toEl.value = '';
  $('ib-item').textContent = ''; $('ib-total').textContent = ''; $('ib-exp-view').textContent = '';
  S.ibItem = null;
  refreshPending();
  renderRecent();
  focusSel(bcEl);
  trySyncSoon();
}

function makeRecord(o) {
  const ipsu = Number(o.ipsu) || 0;
  return Object.assign({
    id: uid(), time: new Date().toISOString(), center: S.center.code, sabun: S.user.sabun, name: S.user.name,
    device: S.deviceId, jobId: '', syncStatus: 'pending', createdAt: Date.now()
  }, o, { ipsu, total: totalOf(o.box, o.loose, ipsu) });
}

/* ============================== 빈병합 ============================== */

async function binEnter() {
  if (!S.bin.job) {
    const open = (await DB.all('jobs')).filter(j => !j.closed && j.sabun === S.user.sabun && j.center === S.center.code)
      .sort((a, b) => b.start.localeCompare(a.start));
    if (open.length) {
      S.bin.job = open[0];
      S.bin.step = 2;
      toast(`진행 중이던 셀 [${open[0].from}] 작업을 이어갑니다.`, 'warn');
    } else {
      S.bin.step = 1;
    }
  }
  binRender();
  renderRecent();
}

function binRender() {
  const b = S.bin;
  document.querySelectorAll('.step').forEach(el => {
    const n = Number(el.dataset.step);
    el.classList.toggle('on', n === b.step);
    el.classList.toggle('done', n < b.step);
  });
  $('bin-s1').classList.toggle('hidden', b.step !== 1);
  $('bin-s2').classList.toggle('hidden', b.step !== 2);
  $('bin-s3').classList.toggle('hidden', b.step !== 3);
  $('bin-job').classList.toggle('hidden', !b.job);
  if (b.job) {
    $('bin-from-view').textContent = b.job.from;
    $('bin-job-count').textContent = b.job.count;
    $('bin-job-total').textContent = b.job.total;
  }
  document.querySelectorAll('#bin-s2 .seg button').forEach(el => el.classList.toggle('on', el.dataset.scan === b.scanMode));
  const batch = b.scanMode === '다건';
  $('bin-single-act').classList.toggle('hidden', batch);
  $('bin-batch-act').classList.toggle('hidden', !batch);
  $('bin-bc-label').textContent = batch ? '상품 바코드 연속 스캔' : '상품 바코드 스캔';
  const req = S.master.config && S.master.config.binExpiryRequired;
  $('bin-exp-opt').textContent = req ? '(필수)' : '(선택)';
  renderBasket();
  if (b.step === 3) renderSummary();
  const focusId = b.step === 1 ? 'bin-from' : b.step === 2 ? 'bin-barcode' : 'bin-to';
  focusSel($(focusId));
}

async function binFixFrom() {
  const el = $('bin-from');
  const cell = normCell(el.value);
  if (!cell) return fail(el, '출발 이동셀을 스캔하세요.');
  if (!validCell(cell)) return fail(el, `등록되지 않은 셀입니다: ${cell}`);
  const job = {
    id: uid(), center: S.center.code, from: cell, sabun: S.user.sabun, name: S.user.name,
    start: new Date().toISOString(), end: '', emptyConfirmed: 'N', count: 0, total: 0,
    device: S.deviceId, closed: false, uploaded: false
  };
  await DB.put('jobs', job);
  S.bin.job = job;
  S.bin.step = 2;
  el.value = '';
  beep(true);
  toast(`이동셀 [${cell}] 고정 완료`);
  binRender();
}

function binLookup() {
  const code = norm($('bin-barcode').value);
  const info = $('bin-item');
  S.bin.item = null;
  if (!code) { info.textContent = ''; return null; }
  const it = lookup(code);
  if (it) {
    S.bin.item = Object.assign({}, it, { barcode: code });
    info.className = 'iteminfo';
    info.textContent = `${it.item} · ${it.name}`;
  } else if (S.master.config && S.master.config.allowUnknownBarcode) {
    S.bin.item = { barcode: code, item: '', name: '', ipsu: 0, unknown: true };
    info.className = 'iteminfo bad';
    info.textContent = '미등록 바코드 (저장은 가능, 비고에 표시됨)';
  } else {
    info.className = 'iteminfo bad';
    info.textContent = '바코드마스터에 없는 바코드입니다.';
  }
  return S.bin.item;
}

// 빈병합 유통기한 확인. 반환: {ok, date} / 실패 시 null
async function binExpCheck() {
  const el = $('bin-exp');
  const p = parseExp(el.value);
  const req = S.master.config && S.master.config.binExpiryRequired;
  if (p.empty) {
    if (req) { fail(el, '유통기한을 입력하세요. (YYMMDD)'); return null; }
    return { ok: true, date: '' };
  }
  if (!p.ok) { fail(el, p.msg); return null; }
  if (p.past && !await confirmBox('유통기한 경과', `유통기한(${p.date})이 이미 지났습니다. 계속할까요?`, '계속', 'red')) { focusSel(el); return null; }
  return p;
}

async function binToStep3() {
  const b = S.bin;
  if (b.scanMode === '다건') {
    if (!b.basket.length) return fail($('bin-barcode'), '장바구니가 비었습니다. 상품을 스캔하세요.');
  } else {
    const bcEl = $('bin-barcode');
    if (!b.item || b.item.barcode !== norm(bcEl.value)) {
      if (!binLookup()) return fail(bcEl, norm(bcEl.value) ? '바코드마스터에 없는 바코드입니다.' : '상품 바코드를 스캔하세요.');
    }
    const qty = intVal($('bin-qty'));
    if (qty <= 0) return fail($('bin-qty'), '수량을 입력하세요.');
    if (qty > 99999) return fail($('bin-qty'), '수량이 너무 큽니다.');
    const p = await binExpCheck();
    if (!p) return;
    b.pending = Object.assign({}, b.item, { qty, expiry: p.date });
  }
  b.step = 3;
  binRender();
}

async function binAddBasket() {
  const bcEl = $('bin-barcode');
  const it = binLookup();
  if (!it) return fail(bcEl, norm(bcEl.value) ? '바코드마스터에 없는 바코드입니다.' : '상품 바코드를 스캔하세요.');
  const qty = intVal($('bin-qty')) || 1;
  const p = await binExpCheck();
  if (!p) return;
  const same = S.bin.basket.find(x => x.barcode === it.barcode && x.expiry === p.date);
  if (same) same.qty += qty;
  else S.bin.basket.push(Object.assign({}, it, { qty, expiry: p.date }));
  beep(true);
  bcEl.value = '';
  $('bin-qty').value = '1';
  $('bin-item').textContent = `담김: ${it.name || it.barcode} +${qty}`;
  S.bin.item = null;
  renderBasket();
  focusSel(bcEl);
}

function renderBasket() {
  const box = $('bin-basket');
  const list = S.bin.basket;
  $('bin-basket-count').textContent = `${list.length}개 품목 / ${list.reduce((a, x) => a + x.qty, 0)} EA`;
  if (!list.length) { box.innerHTML = '<div class="empty">담긴 상품이 없습니다.</div>'; return; }
  box.innerHTML = list.map((x, i) => `<div class="bi"><div><div>${esc(x.name || x.barcode)}</div><div class="bi-sub">${esc(x.item || x.barcode)}${x.expiry ? ' · ' + esc(x.expiry) : ''}</div></div>` +
    `<div class="bi-act"><button type="button" data-q="${i}">수량</button><span class="q">${x.qty}</span><button type="button" data-d="${i}">삭제</button></div></div>`).join('');
}

function renderSummary() {
  const b = S.bin;
  const items = b.scanMode === '다건' ? b.basket : (b.pending ? [b.pending] : []);
  $('bin-summary').innerHTML = `FROM <span class="from">${esc(b.job ? b.job.from : '')}</span> →<br>` +
    items.map(x => `· ${esc(x.name || x.barcode)} <b>${x.qty} EA</b>${x.expiry ? ' <span class="muted">(' + esc(x.expiry) + ')</span>' : ''}`).join('<br>');
}

async function binSave() {
  const b = S.bin;
  const toEl = $('bin-to');
  const to = normCell(toEl.value);
  if (!to) return fail(toEl, '적치셀을 스캔하세요.');
  if (to === b.job.from) return fail(toEl, '이동셀과 적치셀이 같습니다.');
  if (!validCell(to)) return fail(toEl, `등록되지 않은 셀입니다: ${to}`);
  const items = b.scanMode === '다건' ? b.basket : (b.pending ? [b.pending] : []);
  if (!items.length) { b.step = 2; binRender(); return; }

  // 같은 적치셀에 같은 상품·다른 유통기한이 있으면 경고 (이 기기 기록 기준)
  const local = (await DB.all('records')).filter(r => r.to === to && r.center === S.center.code);
  const mixed = [];
  for (const x of items) {
    if (!x.expiry) continue;
    const others = new Set(local.filter(r => r.barcode === x.barcode && r.expiry && r.expiry !== x.expiry).map(r => r.expiry));
    items.forEach(y => { if (y !== x && y.barcode === x.barcode && y.expiry && y.expiry !== x.expiry) others.add(y.expiry); });
    if (others.size) mixed.push(`${x.name || x.barcode}: ${x.expiry} ↔ ${[...others].join(', ')}`);
  }
  if (mixed.length && !await confirmBox('유통기한 혼적 경고', `[${to}] 셀에 유통기한이 다른 같은 상품이 섞입니다.\n\n${mixed.join('\n')}\n\n그래도 적치할까요?`, '적치', 'red')) { focusSel(toEl); return; }

  const recs = items.map(x => makeRecord({
    type: '빈병합', jobId: b.job.id, from: b.job.from, barcode: x.barcode, item: x.item, itemName: x.name,
    box: 0, loose: x.qty, ipsu: x.ipsu, expiry: x.expiry, to, scanMode: b.scanMode, note: x.unknown ? '미등록바코드' : ''
  }));
  await DB.putMany('records', recs);
  b.job.count += recs.length;
  b.job.total += recs.reduce((a, r) => a + r.loose, 0);
  await DB.put('jobs', b.job);
  beep(true);
  toast(`${recs.length}건 적치 저장 → ${to}`);
  b.pending = null;
  b.basket = [];
  b.item = null;
  toEl.value = '';
  $('bin-barcode').value = '';
  $('bin-qty').value = '1';
  if (b.scanMode === '단건') { $('bin-exp').value = ''; $('bin-exp-view').textContent = ''; }
  $('bin-item').textContent = '';
  b.step = 2;
  binRender();
  refreshPending();
  renderRecent();
}

async function binCloseJob(emptyConfirmed) {
  const b = S.bin;
  if (!b.job) return;
  if (b.basket.length || b.pending) {
    if (!await confirmBox('저장 안 된 상품', '장바구니(또는 적치 대기)에 저장하지 않은 상품이 있습니다. 버리고 진행할까요?', '버리고 진행', 'red')) return;
  }
  if (emptyConfirmed) {
    const warnEmpty = b.job.count === 0 ? '\n\n※ 이 셀에서 스캔한 상품이 없습니다. 실물이 비어 있는 셀이 맞습니까?' : '';
    const ok = await confirmBox('원천셀 공빈 확정',
      `[${b.job.from}] 셀을 공빈(Empty)으로 확정합니다.\n이동 기록 ${b.job.count}건 / ${b.job.total} EA\n\n이 셀에서 스캔하지 않은 전산재고는 이후 정산 때 오차(-)로 처리됩니다.${warnEmpty}`,
      '공빈 확정', 'red');
    if (!ok) return;
  } else {
    const ok = await confirmBox('새 셀 시작', `[${b.job.from}] 셀을 공빈 확정 없이 종료합니다.\n(셀에 재고가 남아 있는 경우)`, '종료', 'primary');
    if (!ok) return;
  }
  const job = b.job;
  if (!emptyConfirmed && job.count === 0) {
    await DB.del('jobs', job.id);
  } else {
    job.end = new Date().toISOString();
    job.emptyConfirmed = emptyConfirmed ? 'Y' : 'N';
    job.closed = true;
    await DB.put('jobs', job);
  }
  S.bin = { step: 1, job: null, scanMode: b.scanMode, basket: [], pending: null, item: null };
  $('bin-barcode').value = ''; $('bin-qty').value = '1'; $('bin-exp').value = ''; $('bin-exp-view').textContent = ''; $('bin-item').textContent = '';
  beep(true);
  toast(emptyConfirmed ? `[${job.from}] 공빈 확정 완료` : `[${job.from}] 작업 종료`);
  binRender();
  trySyncSoon();
}

// 24시간 넘게 열려 있는 셀작업은 공빈 미확정으로 닫음
async function closeStaleJobs() {
  const cut = Date.now() - 86400000;
  for (const j of await DB.all('jobs')) {
    if (!j.closed && new Date(j.start).getTime() < cut) {
      if (j.count === 0) await DB.del('jobs', j.id);
      else { j.closed = true; j.end = new Date().toISOString(); j.emptyConfirmed = 'N'; await DB.put('jobs', j); }
    }
  }
}

/* ============================== 최근 기록 ============================== */

function recCard(r, opts = {}) {
  const st = r.syncStatus;
  const stBadge = st ? `<span class="badge ${st}">${st === 'pending' ? '미전송' : st === 'rejected' ? '거부' : '전송완료'}</span>` : '';
  const svBadge = !st && r.status && r.status !== '정상' ? `<span class="badge ${esc(r.status)}">${esc(r.status)}</span>` : '';
  return `<div class="rec${r.status === '삭제' ? ' del' : ''}" data-id="${esc(r.id)}" data-src="${opts.src || ''}">` +
    `<div class="l1"><span><span class="badge ${esc(r.type)}">${esc(r.type)}</span> <span class="nm">${esc(r.itemName || r.barcode)}</span></span>${stBadge}${svBadge}</div>` +
    `<div class="l2">${esc(fmtTime(r.time))} · ${esc(r.from)} → ${esc(r.to)} · ${esc(qtyText(r))}${r.expiry ? ' · 유통 ' + esc(r.expiry) : ''}` +
    `${opts.showWorker ? ' · ' + esc(r.name || r.sabun) : ''}${r.error ? '<br><span class="rej">거부: ' + esc(r.error) + '</span>' : ''}</div></div>`;
}

async function renderRecent() {
  if (!S.user || S.screen !== 'work') return;
  const inbound = TYPES_INBOUND.includes(S.mode);
  const box = $(inbound ? 'ib-recent' : 'bin-recent');
  const list = (await DB.all('records'))
    .filter(r => r.sabun === S.user.sabun && r.type === S.mode)
    .sort((a, b) => b.time.localeCompare(a.time)).slice(0, 8);
  box.innerHTML = list.length ? list.map(r => recCard(r, { src: 'local' })).join('') : '<div class="empty">저장한 기록이 없습니다.</div>';
}

async function localRecordDialog(id) {
  const r = await DB.get('records', id);
  if (!r) return;
  const canCancel = r.syncStatus !== 'uploaded' && (r.sabun === S.user.sabun || S.user.role === '관리자');
  const body = `${r.type} · ${r.itemName || ''}\n바코드 ${r.barcode}  아이템 ${r.item || '-'}\n${r.from} → ${r.to}\n수량 ${qtyText(r)}\n유통기한 ${r.expiry || '-'}\n작업자 ${r.name} · ${fmtTime(r.time)}\n상태 ${r.syncStatus === 'pending' ? '미전송' : r.syncStatus === 'rejected' ? '거부: ' + r.error : '전송완료'}`;
  const btns = [{ label: '닫기', value: false }];
  if (canCancel) btns.push({ label: '이 기록 취소', value: true, cls: 'red' });
  if (!await modal({ title: '기록 상세 (이 기기)', body, buttons: btns })) return;
  if (!await confirmBox('기록 취소', '이 기록을 PDA에서 삭제합니다. 서버에는 올라가지 않습니다.', '삭제', 'red')) return;
  await DB.del('records', id);
  if (r.jobId) {
    const j = await DB.get('jobs', r.jobId);
    if (j && !j.uploaded) {
      j.count = Math.max(0, j.count - 1);
      j.total = Math.max(0, j.total - (r.loose || 0));
      await DB.put('jobs', j);
      if (S.bin.job && S.bin.job.id === j.id) { S.bin.job = j; binRender(); }
    }
  }
  toast('기록을 취소했습니다.');
  refreshPending();
  renderRecent();
  if (S.screen === 'records') renderRecords();
}

/* ============================== 기록 조회 ============================== */

let rcInited = false;
function initRecords() {
  if (!rcInited) {
    $('rc-from').value = todayStr();
    $('rc-to').value = todayStr();
    rcInited = true;
  }
  document.querySelectorAll('#rc-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.rcTab));
  renderRecords();
}

function visibleLocal(r) {
  return S.user && (S.user.role === '관리자' || r.sabun === S.user.sabun);
}

async function renderRecords() {
  document.querySelectorAll('#rc-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.rcTab));
  const box = $('rc-list');
  refreshPending();
  if (S.rcTab === 'local') {
    const list = (await DB.all('records')).filter(r => r.syncStatus !== 'uploaded' && visibleLocal(r))
      .sort((a, b) => b.time.localeCompare(a.time));
    box.innerHTML = list.length ? list.map(r => recCard(r, { src: 'local', showWorker: true })).join('') : '<div class="empty">미전송 기록이 없습니다.</div>';
  } else {
    const list = S.serverRecs;
    $('rc-server-count').textContent = list.length;
    box.innerHTML = list.length ? list.map(r => recCard(r, { src: 'server', showWorker: S.user.role !== '작업자' })).join('')
      : '<div class="empty">[서버 조회]를 누르면 Google 시트의 기록을 불러옵니다. (와이파이 필요)</div>';
  }
}

async function searchServer() {
  const btn = $('rc-search');
  btn.disabled = true;
  btn.textContent = '조회 중…';
  try {
    const token = await ensureToken(true);
    if (!token) return;
    const res = await api('records', {
      token, from: $('rc-from').value, to: $('rc-to').value, type: $('rc-type').value,
      worker: norm($('rc-worker').value), q: norm($('rc-q').value), includeDeleted: $('rc-deleted').checked
    });
    S.serverRecs = res.records.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    S.rcTab = 'server';
    renderRecords();
    toast(`${res.records.length}건 조회${res.truncated ? ' (최대 건수까지만 표시)' : ''}`, res.truncated ? 'warn' : '');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '서버 조회';
  }
}

async function serverRecordDialog(id) {
  const r = S.serverRecs.find(x => x.id === id);
  if (!r) return;
  const info = `${r.type} · ${r.itemName || ''}\n바코드 ${r.barcode}  아이템 ${r.item || '-'}\n${r.from} → ${r.to}\n수량 ${qtyText(r)}\n유통기한 ${r.expiry || '-'}\n작업자 ${r.name}(${r.sabun}) · ${r.time}\n업로드 ${r.uploadedAt}\n상태 ${r.status}${r.editor ? ' · ' + r.editor + ' ' + r.editedAt : ''}${r.note ? '\n비고 ' + r.note : ''}`;
  if (S.user.role !== '관리자' || r.status === '삭제') {
    await modal({ title: '기록 상세', body: info });
    return;
  }
  const f = (label, key, mode) => `<label>${label}<input id="ed-${key}" inputmode="${mode || 'text'}" value="${esc(r[key])}" autocomplete="off"></label>`;
  const body = `<div class="info-pre">${esc(info)}</div>` +
    `<div class="row2">${f('박스수량', 'box', 'numeric')}${f('낱개수량', 'loose', 'numeric')}</div>` +
    `<div class="row2">${f('입수', 'ipsu', 'numeric')}${f('유통기한(YYYY-MM-DD)', 'expiry', 'numeric')}</div>` +
    `<div class="row2">${f('이동셀', 'from')}${f('적치셀', 'to')}</div>${f('비고', 'note')}`;
  const act = await modal({
    title: '기록 수정 (관리자)', html: true, body,
    buttons: [{ label: '닫기', value: null }, { label: '삭제', value: 'del', cls: 'red' }, { label: '저장', value: 'save', cls: 'primary', primary: true }]
  });
  try {
    if (act === 'save') {
      const token = await ensureToken(true);
      if (!token) return;
      const changes = {};
      for (const k of ['box', 'loose', 'ipsu', 'from', 'to', 'note', 'expiry']) {
        let v = norm($('ed-' + k).value);
        if (k === 'from' || k === 'to') v = v.toUpperCase();
        if (k === 'expiry' && v) { const p = parseExp(v); if (!p.ok) { toast('유통기한: ' + p.msg, 'err'); return; } v = p.date; }
        if (String(r[k] == null ? '' : r[k]) !== v) changes[k] = v;
      }
      if (!Object.keys(changes).length) { toast('바뀐 내용이 없습니다.', 'warn'); return; }
      const res = await api('update', { token, id, changes });
      Object.assign(r, res.record);
      toast(`수정 완료 (${res.changed}개 항목)`);
      renderRecords();
    } else if (act === 'del') {
      const reason = await promptBox('기록 삭제', '삭제 사유를 입력하세요. (변경이력에 남습니다)', { okLabel: '삭제' });
      if (!reason || !norm(reason)) return;
      const token = await ensureToken(true);
      if (!token) return;
      await api('remove', { token, id, reason: norm(reason) });
      r.status = '삭제';
      toast('삭제 처리했습니다.');
      if (!$('rc-deleted').checked) S.serverRecs = S.serverRecs.filter(x => x.id !== id);
      renderRecords();
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

function downloadCsv() {
  const list = S.serverRecs;
  if (!list.length) { toast('먼저 [서버 조회]를 하세요.', 'warn'); return; }
  const cols = [['작업시각', 'time'], ['센터', 'center'], ['구분', 'type'], ['작업자사번', 'sabun'], ['작업자명', 'name'],
    ['이동셀', 'from'], ['바코드', 'barcode'], ['아이템코드', 'item'], ['상품명', 'itemName'], ['박스수량', 'box'],
    ['낱개수량', 'loose'], ['입수', 'ipsu'], ['총수량', 'total'], ['유통기한', 'expiry'], ['적치셀', 'to'],
    ['스캔모드', 'scanMode'], ['비고', 'note'], ['상태', 'status'], ['기록ID', 'id']];
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  // 바코드·셀 코드는 엑셀이 숫자/날짜로 바꾸지 않도록 ="..." 형식
  const textKeys = new Set(['barcode', 'item', 'from', 'to', 'sabun']);
  const lines = [cols.map(c => c[0]).join(',')].concat(list.map(r => cols.map(([, k]) => textKeys.has(k) && r[k] !== '' ? q(`="${r[k]}"`) : q(r[k])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `PDA기록_${$('rc-from').value}_${$('rc-to').value}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ============================== 정보·설정 ============================== */

async function showInfo() {
  const all = await DB.all('records');
  const jobs = await DB.all('jobs');
  const last = await DB.kvGet('lastSync', 0);
  const m = S.master;
  const locCount = Object.values(m.locations || {}).reduce((a, x) => a + x.length, 0);
  await modal({
    title: '기기·마스터 정보',
    body: `앱 버전 ${APP_VERSION}\n기기 ID ${S.deviceId}\n서버 ${apiUrl() ? '설정됨' : '미설정'}\n\n` +
      `마스터 받은 시각 ${m.syncedAt || '-'}\n바코드 ${(m.barcodes || []).length}건 · 센터 ${(m.centers || []).length}곳 · 로케이션 ${locCount}건\n` +
      `미등록 바코드 허용 ${m.config && m.config.allowUnknownBarcode ? 'Y' : 'N'} · 빈병합 유통기한 필수 ${m.config && m.config.binExpiryRequired ? 'Y' : 'N'}\n\n` +
      `마지막 업로드 ${last ? new Date(last).toLocaleString('ko-KR') : '-'}\n` +
      `미전송 ${all.filter(r => r.syncStatus === 'pending').length}건 · 거부 ${all.filter(r => r.syncStatus === 'rejected').length}건 · 전송완료(보관) ${all.filter(r => r.syncStatus === 'uploaded').length}건\n` +
      `셀작업 진행중 ${jobs.filter(j => !j.closed).length} · 미전송 ${jobs.filter(j => j.closed && !j.uploaded).length}`
  });
}

async function serverSettings() {
  const v = await promptBox('서버 설정', 'Apps Script 웹앱 주소(.../exec). 비우면 config.js 값을 사용합니다.', { value: localStorage.getItem('pda.apiUrl') || CFG.API_URL || '' });
  if (v === null) return;
  const url = norm(v);
  if (url && !/^https?:\/\//.test(url) && !url.startsWith('/')) { toast('주소 형식이 올바르지 않습니다.', 'err'); return; }
  if (!url || url === CFG.API_URL) localStorage.removeItem('pda.apiUrl');
  else localStorage.setItem('pda.apiUrl', url);
  toast('서버 주소를 저장했습니다.');
}

/* ============================== 이벤트 연결 ============================== */

function bind() {
  // 로그인
  onEnter($('lg-sabun'), () => focusSel($('lg-pin')));
  onEnter($('lg-pin'), doLogin);
  $('lg-btn').onclick = doLogin;
  $('lg-settings').onclick = serverSettings;

  // 상단바·메뉴
  $('tb-sync').onclick = () => sync(true);
  $('tb-menu').onclick = () => $('menu').classList.remove('hidden');
  $('menu').onclick = e => { if (e.target.id === 'menu') $('menu').classList.add('hidden'); };
  document.querySelectorAll('[data-menu]').forEach(b => b.onclick = () => {
    $('menu').classList.add('hidden');
    const a = b.dataset.menu;
    if (a === 'work') { showScreen('work'); setMode(S.mode); }
    else if (a === 'records') showScreen('records');
    else if (a === 'sync') sync(true);
    else if (a === 'info') showInfo();
    else if (a === 'logout') logout(false);
  });

  // 키보드 토글 (스캔 칸은 기본으로 화면 키보드를 띄우지 않음)
  document.querySelectorAll('.kbd').forEach(k => k.onclick = () => {
    const el = $(k.dataset.for);
    const on = el.getAttribute('inputmode') === 'none';
    el.setAttribute('inputmode', on ? 'text' : 'none');
    k.classList.toggle('on', on);
    el.blur();
    focusSel(el);
  });

  // 모드 탭
  document.querySelectorAll('.mode-tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

  // 입고
  onEnter($('ib-barcode'), () => {
    if (!norm($('ib-barcode').value)) return;
    if (ibLookup()) {
      beep(true);
      const last = S.lastExp[S.ibItem.barcode];
      if (last && !$('ib-exp').value) { $('ib-exp').value = last; showExp($('ib-exp'), $('ib-exp-view')); }
      focusSel($('ib-box'));
    } else fail($('ib-barcode'), '바코드마스터에 없는 바코드입니다.');
  });
  $('ib-barcode').addEventListener('input', () => { S.ibItem = null; $('ib-item').textContent = ''; $('ib-total').textContent = ''; });
  onEnter($('ib-box'), () => focusSel($('ib-loose')));
  onEnter($('ib-loose'), () => focusSel($('ib-exp')));
  onEnter($('ib-exp'), () => { const p = showExp($('ib-exp'), $('ib-exp-view')); if (p.ok || p.empty) focusSel($('ib-to')); else fail($('ib-exp'), p.msg); });
  onEnter($('ib-to'), ibSave);
  ['ib-box', 'ib-loose'].forEach(id => $(id).addEventListener('input', ibTotal));
  $('ib-exp').addEventListener('input', () => showExp($('ib-exp'), $('ib-exp-view')));
  $('ib-save').onclick = ibSave;

  // 빈병합
  onEnter($('bin-from'), binFixFrom);
  $('bin-from-next').onclick = binFixFrom;
  document.querySelectorAll('#bin-s2 .seg button').forEach(b => b.onclick = () => {
    if (S.bin.scanMode === b.dataset.scan) return;
    if (S.bin.basket.length && b.dataset.scan === '단건') { toast('장바구니를 먼저 적치하거나 비우세요.', 'warn'); return; }
    S.bin.scanMode = b.dataset.scan;
    binRender();
  });
  onEnter($('bin-barcode'), () => {
    if (!norm($('bin-barcode').value)) return;
    if (S.bin.scanMode === '다건') { binAddBasket(); return; }
    if (binLookup()) { beep(true); focusSel($('bin-qty')); } else fail($('bin-barcode'), '바코드마스터에 없는 바코드입니다.');
  });
  $('bin-barcode').addEventListener('input', () => { if (S.bin.scanMode === '단건') { S.bin.item = null; $('bin-item').textContent = ''; } });
  onEnter($('bin-qty'), () => focusSel($('bin-exp')));
  onEnter($('bin-exp'), () => { if (S.bin.scanMode === '다건') focusSel($('bin-barcode')); else binToStep3(); });
  $('bin-exp').addEventListener('input', () => showExp($('bin-exp'), $('bin-exp-view')));
  $('bin-to-step3').onclick = binToStep3;
  $('bin-batch-step3').onclick = binToStep3;
  $('bin-basket').onclick = async e => {
    const q = e.target.dataset.q, d = e.target.dataset.d;
    if (q !== undefined) {
      const it = S.bin.basket[Number(q)];
      const v = await promptBox('수량 변경', it.name || it.barcode, { inputmode: 'numeric', value: String(it.qty) });
      const n = parseInt(String(v || '').replace(/\D/g, ''), 10);
      if (n > 0) it.qty = n;
      binRender();
    } else if (d !== undefined) {
      S.bin.basket.splice(Number(d), 1);
      binRender();
    }
  };
  onEnter($('bin-to'), binSave);
  $('bin-save').onclick = binSave;
  $('bin-back').onclick = () => { S.bin.step = 2; S.bin.pending = null; binRender(); };
  $('bin-empty').onclick = () => binCloseJob(true);
  $('bin-newcell').onclick = () => binCloseJob(false);
  $('bin-change').onclick = () => binCloseJob(false);

  // 최근 기록·기록 조회 카드
  document.addEventListener('click', e => {
    const card = e.target.closest('.rec');
    if (!card) return;
    if (card.dataset.src === 'local') localRecordDialog(card.dataset.id);
    else if (card.dataset.src === 'server') serverRecordDialog(card.dataset.id);
  });
  document.querySelectorAll('#rc-tabs button').forEach(b => b.onclick = () => { S.rcTab = b.dataset.tab; renderRecords(); });
  $('rc-search').onclick = searchServer;
  $('rc-csv').onclick = downloadCsv;

  // 네트워크·유휴
  window.addEventListener('online', () => { updateNet(); trySyncSoon(); });
  window.addEventListener('offline', updateNet);
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, touchActive, true));
  setInterval(idleCheck, 60000);
}

/* ============================== 시작 ============================== */

async function init() {
  bind();
  let dev = await DB.kvGet('device', null);
  if (!dev) {
    dev = { id: randHex(3).toUpperCase(), salt: randHex(16) };
    await DB.kvSet('device', dev);
  }
  S.deviceId = dev.id;
  S.deviceSalt = dev.salt;
  $('lg-device').textContent = S.deviceId;
  S.master = Object.assign({}, EMPTY_MASTER, await DB.kvGet('master', {}));
  buildMaps();
  updateNet();
  refreshPending();

  // 세션 복원 (유휴 시간 이내)
  const s = JSON.parse(localStorage.getItem('pda.session') || 'null');
  if (s && Date.now() - s.lastActive < (CFG.IDLE_LOGOUT_MIN || 120) * 60000) {
    const vers = await DB.kvGet('verifiers', {});
    if (vers[s.sabun]) {
      try { await startSession(vers[s.sabun].profile, s.center); return; } catch (e) { /* 로그인 화면으로 */ }
    }
  }
  showScreen('login');
  focusSel($('lg-sabun'));
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
