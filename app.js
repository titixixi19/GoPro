/* GoPro Web — đọc bài + ôn tập, đồng bộ với GoPro trên laptop qua Supabase.
   Dữ liệu: state (ảnh chụp tiến độ GoPro đẩy lên, kèm watermark) + events (mỗi lượt học trên web).
   Tiến độ hiện trên web = ảnh chụp + các lượt sau watermark (trên máy chủ và đang chờ gửi) — cùng thuật toán với GoPro. */
'use strict';

const DAY = 86400000;
const WORD_DAYS = [0, 1, 2, 4, 7, 15, 30]; // = SRS_INTERVALS_DAYS trong GoPro
const PASS = 70; // = CS_PASS_QUIZ

const sb = supabase.createClient(GOPRO_CONFIG.url, GOPRO_CONFIG.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'gopro-web-auth' } });
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabbar');

const S = {
  user: null, row: null, content: null, modules: [], lessons: [], lessonById: new Map(), qa: [], words: new Map(),
  serverEv: [], queue: [], D: null, sess: null, dev: '', lastT: 0, loadedAt: 0, flushing: false, sendErr: '', offline: false,
};

// ===== Tiện ích =====
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function dayStr(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function fmtMin(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ${m % 60 ? ` ${m % 60}′` : ''}`;
}
function djb2(s) { // = csIvHash trong GoPro → khoá câu phỏng vấn trùng nhau giữa hai bên
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const quizKey = (q) => String(q.q).slice(0, 160) + (q.code ? '|code:' + djb2(String(q.code)) : ''); // = csReviewKey trong GoPro
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
// Văn bản trong khoá học: cho phép vài thẻ định dạng, [[code]] → mã inline (= csSafe trong GoPro)
const ALLOWED = /<\/?(b|i|u|em|strong|br|small|kbd|sub|sup|code|span|ul|ol|li|p|pre|table|thead|tbody|tr|th|td|h4|hr)(\s[^<>]*)?\/?>/gi;
function safe(s) {
  const codes = [];
  const decode = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const text = String(s ?? '').replace(/&amp;(lt|gt|amp|quot);/g, '&$1;').replace(/\[\[(.+?)\]\](?!\])/gs, (_, c) => { codes.push(decode(c)); return `\u0000${codes.length - 1}\u0000`; });
  const escPart = (t) => t.replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '', last = 0;
  text.replace(ALLOWED, (tag, _n, _a, idx) => {
    out += escPart(text.slice(last, idx)) + tag.replace(/\s(on\w+|style)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, '');
    last = idx + tag.length;
    return tag;
  });
  out += escPart(text.slice(last));
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="ic">${hlEsc(codes[+i])}</code>`);
}
let toastT = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 3200);
}
function authMessage(e) {
  const m = String((e && (e.message || e.msg)) || e || '');
  if (/Invalid login credentials/i.test(m)) return 'Sai email hoặc mật khẩu.';
  if (/already registered|Database error saving new user|tài khoản đã tồn tại/i.test(m)) return 'GoPro Web đã có tài khoản — hãy đăng nhập bằng tài khoản đó.';
  if (/Password should be/i.test(m)) return 'Mật khẩu cần ít nhất 6 ký tự.';
  if (/valid email|invalid format/i.test(m)) return 'Email không hợp lệ.';
  if (/rate limit/i.test(m)) return 'Thử quá nhiều lần — đợi vài phút rồi thử lại.';
  if (/fetch|network/i.test(m)) return 'Không kết nối được máy chủ — kiểm tra mạng.';
  return m || 'Lỗi không rõ.';
}

// ===== Nội dung khoá học =====
function indexContent(c) {
  S.content = c;
  S.modules = c.modules;
  S.lessons = [];
  S.lessonById = new Map();
  S.qa = [];
  for (const m of c.modules)
    m.lessons.forEach((l, i) => {
      l.module = m;
      l.num = i + 1;
      l.idx = S.lessons.length;
      S.lessons.push(l);
      S.lessonById.set(l.id, l);
      for (const b of l.content) if (b.qa != null && b.answer) S.qa.push({ key: djb2(String(b.qa)), q: b.qa, a: b.answer, level: b.level || '', l });
    });
  S.words = new Map();
  for (const d of c.decks) for (const w of d.words) S.words.set(d.id + '/' + w.id, { ...w, deck: d.id });
}
const CACHE = 'gopro-content';
async function getContent(version, uid) {
  const key = new URL('__content/' + encodeURIComponent(version || 'none'), location.href).href;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) {}
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  setLoading('Đang tải khoá học về máy (lần đầu khoảng 5 MB)…');
  const { data, error } = await sb.storage.from('content').download(`${uid}/course.json`);
  if (error) throw error;
  const text = await data.text();
  if (cache) {
    try {
      for (const k of await cache.keys()) await cache.delete(k);
      await cache.put(key, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) {}
  }
  return JSON.parse(text);
}
async function cachedContentAny() {
  try {
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    if (keys.length) return (await cache.match(keys[0])).json();
  } catch (e) {}
  return null;
}

// ===== Tải dữ liệu =====
function setLoading(msg) { $tabs.hidden = true; $app.innerHTML = `<div class="panel muted">${esc(msg)}</div>`; }
// Mạng chập chờn (DNS lỗi, sóng yếu) có thể treo cả chục giây → quá hạn thì coi như mất mạng
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('network timeout')), ms))]);
}
async function fetchProgress() {
  // Phiên hết hạn mà không làm mới được (mất mạng) → báo lỗi thay vì lặng lẽ đọc như khách (sẽ ra trang trống)
  const { data: { session }, error: se } = await sb.auth.getSession();
  if (!session) throw se || new Error('Phiên đăng nhập đã hết — hãy đăng nhập lại.');
  const { data: row, error } = await sb.from('state').select('data,watermark,content_version,updated_at').maybeSingle();
  if (error) throw error;
  if (!row) return { row: null, ev: [] };
  const { data: ev, error: e2 } = await sb.from('events').select('id,t,kind,body,device').gt('id', row.watermark).order('id').limit(10000);
  if (e2) throw e2;
  return { row, ev };
}
async function loadData(full = true) {
  const uid = S.user.id;
  try {
    const hasSaved = !!ls.get('gopro-web-row');
    const { row, ev } = await withTimeout(fetchProgress(), hasSaved ? 4000 : 45000);
    S.offline = false;
    if (!row) { S.row = null; return; }
    if (full || !S.content || row.content_version !== S.row?.content_version) indexContent(await getContent(row.content_version, uid));
    S.row = row;
    S.serverEv = ev;
    ls.set('gopro-web-row', JSON.stringify({ row, ev }));
  } catch (e) {
    // Mất mạng: dùng bản đã lưu trên máy để vẫn đọc bài và ôn được; lượt học được giữ lại, có mạng sẽ gửi
    console.warn(e);
    const saved = JSON.parse(ls.get('gopro-web-row') || 'null');
    if (!S.content) { const c = await cachedContentAny(); if (c) indexContent(c); }
    if (saved && S.content) { S.row = saved.row; S.serverEv = saved.ev; S.offline = true; }
    else throw e;
  }
  S.loadedAt = Date.now();
  rebuild();
}

// ===== Tiến độ = ảnh chụp + lượt học sau watermark =====
function rebuild() {
  const snap = (S.row && S.row.data) || {};
  const D = {
    lessons: structuredClone(snap.lessons || {}),
    ex: snap.exercises || {},
    labs: snap.labs || {},
    iv: structuredClone(snap.iv || {}),
    srs: structuredClone(snap.srs || {}),
    lc: structuredClone(snap.lc || {}),
    time: structuredClone((snap.stats && snap.stats.time) || {}),
    streak: (snap.stats && snap.stats.streak) || 0,
    lastStudy: (snap.stats && snap.stats.lastStudyDate) || '',
    plan: snap.plan || { hoursPerWeek: 8, daysPerWeek: 6 },
  };
  S.D = D;
  const seen = new Set();
  const all = [...S.serverEv, ...S.queue].filter((e) => { const k = e.device + ':' + e.t; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t);
  for (const e of all) applyEv(D, e);
}
function L(id) { return (S.D.lessons[id] = S.D.lessons[id] || {}); }
function applyEv(D, e) {
  const b = e.body || {};
  const date = dayStr(e.t);
  if (e.kind === 'w') {
    const deck = D.srs[b.d];
    if (!deck || !deck[b.w]) return;
    const first = deck[b.w][2] || e.t; // lần ôn đầu tiên (= srs.first trong GoPro)
    if (b.ok) { const lv = Math.min(deck[b.w][0] + 1, WORD_DAYS.length - 1); deck[b.w] = [lv, e.t + WORD_DAYS[lv] * DAY, first]; }
    else deck[b.w] = [0, 0, first];
  } else if (e.kind === 'i') {
    const s = D.iv[b.key] || { box: 0, n: 0 };
    const box = b.s === 0 ? 0 : b.s === 1 ? Math.max(1, Math.min(s.box, 1)) : Math.min(s.box + 1, 5);
    const days = b.s === 0 ? 1 : b.s === 1 ? 3 : [3, 3, 7, 14, 30, 60][box];
    D.iv[b.key] = { box, n: (s.n || 0) + 1, last: b.s, due: e.t + days * DAY };
  } else if (e.kind === 'q') {
    const st = (D.lessons[b.l] = D.lessons[b.l] || {});
    const set = new Set(st.quizWrong || []);
    if (b.ok) set.delete(b.key); else set.add(b.key);
    st.quizWrong = [...set];
  } else if (e.kind === 'read') {
    const st = (D.lessons[b.l] = D.lessons[b.l] || {});
    st.read = true; st.visited = true;
  } else if (e.kind === 'lq') {
    const st = (D.lessons[b.l] = D.lessons[b.l] || {});
    st.quiz = Math.max(b.pct, st.quiz ?? 0); st.quizWrong = b.wrong || []; st.visited = true;
  } else if (e.kind === 'lc') {
    // Tự chấm bài LeetCode (= lcApply trong GoPro)
    const s = D.lc[b.s] || { box: 0, n: 0 };
    const box = b.r === 0 ? 0 : b.r === 1 ? Math.max(1, Math.min(s.box, 1)) : Math.min(s.box + 1, 5);
    const days = b.r === 0 ? 1 : b.r === 1 ? 3 : [3, 3, 7, 14, 30, 60][box];
    D.lc[b.s] = { box, n: (s.n || 0) + 1, last: b.r, due: e.t + days * DAY, first: s.first || e.t };
  } else if (e.kind === 'time') {
    const d = (D.time[b.date || date] = D.time[b.date || date] || {});
    d.m = { cs: ((d.m || {}).cs || 0) + (b.cs || 0), en: ((d.m || {}).en || 0) + (b.en || 0) };
    return;
  }
  if (date > D.lastStudy) { D.streak = D.lastStudy === dayStr(new Date(date + 'T12:00:00').getTime() - DAY) ? D.streak + 1 : 1; D.lastStudy = date; }
}

// ===== Ghi một lượt học: áp ngay trên máy, xếp hàng gửi lên (mất mạng thì giữ lại) =====
function saveQueue() { ls.set('gopro-web-queue', JSON.stringify(S.queue)); }
function record(kind, body) {
  const t = Math.max(Date.now(), S.lastT + 1);
  S.lastT = t;
  const e = { device: S.dev, t, kind, body };
  S.queue.push(e);
  saveQueue();
  applyEv(S.D, e);
  flushQueue();
}
async function flushQueue() {
  if (S.flushing || !S.queue.length || !S.user) return updateChip();
  S.flushing = true;
  const batch = S.queue.slice(0, 200);
  try {
    const { error } = await sb.from('events').upsert(batch.map((e) => ({ device: e.device, t: e.t, kind: e.kind, body: e.body })), { onConflict: 'user_id,device,t', ignoreDuplicates: true });
    if (error) throw error;
    S.queue = S.queue.slice(batch.length);
    S.serverEv.push(...batch); // đã nằm trên máy chủ (lượt gửi lại bị bỏ qua nhờ khoá duy nhất user+máy+t)
    saveQueue();
    S.sendErr = '';
  } catch (e) {
    console.warn(e);
    S.sendErr = authMessage(e);
  } finally {
    S.flushing = false;
    updateChip();
    if (S.queue.length && !S.sendErr) flushQueue();
  }
}
// Đang dùng bản đã lưu → thử lại định kỳ và ngay khi máy báo có mạng; nối được thì tải tiến độ mới rồi gửi các lượt đang chờ
setInterval(() => (S.offline && S.user && S.row ? refresh() : flushQueue()), 30000);
addEventListener('online', () => (S.offline && S.user && S.row ? refresh() : flushQueue()));

// ===== Đo thời gian học: chỉ khi trang đang hiện và có chạm trong 2 phút gần nhất =====
let lastInput = Date.now();
const pending = { cs: 0, en: 0 };
['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((ev) => addEventListener(ev, () => (lastInput = Date.now()), { passive: true, capture: true }));
function area() {
  const h = location.hash;
  if (/^#\/s\/vocab/.test(h)) return 'en';
  if (/^#\/(l|s|y-chinh)\//.test(h) || h === '#/y-chinh') return 'cs';
  return null;
}
setInterval(() => {
  const a = area();
  if (!a || !S.D || document.visibilityState !== 'visible' || Date.now() - lastInput > 120000) return;
  pending[a] += 15;
  if (pending.cs + pending.en >= 120) flushTime();
}, 15000);
function flushTime() {
  if (!S.D || pending.cs + pending.en < 15) return;
  const body = { date: dayStr(), cs: pending.cs, en: pending.en };
  pending.cs = pending.en = 0;
  record('time', body);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') return flushTime();
  if (S.user && S.row && Date.now() - S.loadedAt > 30000) refresh();
});
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const wasOffline = S.offline;
  try {
    await loadData(false);
    if (wasOffline && !S.offline) { toast('Đã có mạng — đang đồng bộ.'); flushQueue(); }
    if (!location.hash.startsWith('#/s/')) route();
    else updateChip();
  } catch (e) { console.warn(e); } finally { refreshing = false; }
}

// ===== Số liệu =====
function lessonProg(l) {
  const st = S.D.lessons[l.id] || {};
  const exDone = l.exercises.filter((e) => S.D.ex[e.id]).length;
  const quizOk = !l.quiz.length || (st.quiz != null && st.quiz >= PASS);
  return { read: !!st.read, quiz: st.quiz, quizOk, exDone, exTotal: l.exercises.length, done: !!st.read && quizOk && exDone === l.exercises.length, started: !!(st.read || st.visited || st.quiz != null || exDone) };
}
function nextLesson() { return S.lessons.find((l) => !lessonProg(l).done) || null; }
// Như vocabDue() trong GoPro: từ đã học đến hạn + tối đa newPerDay từ mới mỗi ngày (theo thứ tự trong bộ từ)
function vocabDue() {
  const now = Date.now(), today = dayStr();
  const limit = Number.isFinite(S.D.plan.newPerDay) ? S.D.plan.newPerDay : 20;
  let learnedToday = 0;
  for (const deck of Object.values(S.D.srs)) for (const s of Object.values(deck)) if (s[2] && dayStr(s[2]) === today) learnedToday++;
  const slots = Math.max(0, limit - learnedToday);
  const review = [], fresh = [];
  let newTotal = 0;
  for (const [k, w] of S.words) {
    const s = (S.D.srs[w.deck] || {})[w.id];
    if (!s) continue;
    const item = { ...w, level: s[0], next: s[1], k };
    if (!s[2] && s[0] === 0 && !s[1]) { newTotal++; if (fresh.length < slots) fresh.push(item); }
    else if (s[1] <= now) review.push(item);
  }
  return { review, fresh, newLeft: newTotal - fresh.length };
}
function dueWords() { const v = vocabDue(); return [...v.review, ...v.fresh]; }
function vocabSub() { const v = vocabDue(); return `<span class="count">${v.review.length}</span> cần ôn · <span class="count">${v.fresh.length}</span> từ mới`; }
function wrongList() {
  const out = [];
  for (const l of S.lessons) {
    const set = new Set((S.D.lessons[l.id] || {}).quizWrong || []);
    if (set.size) for (const q of l.quiz) if (set.has(quizKey(q))) out.push({ q, l });
  }
  return out;
}
function ivStats() {
  const now = Date.now();
  let due = 0, seen = 0;
  for (const c of S.qa) { const s = S.D.iv[c.key]; if (s) { seen++; if (s.due <= now) due++; } }
  return { due, seen, total: S.qa.length };
}
function daySec(date) {
  const d = S.D.time[date] || {};
  return (d.cs || 0) + (d.en || 0) + ((d.m || {}).cs || 0) + ((d.m || {}).en || 0);
}
function weekSec() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  let s = 0;
  for (let i = 0; i < 7; i++) s += daySec(dayStr(d.getTime() + i * DAY + 3600000));
  return s;
}
function learnedLessons() { return S.lessons.filter((l) => lessonProg(l).started); }

// ===== Điều hướng =====
addEventListener('hashchange', () => { flushTime(); route(); });
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
function route() {
  if (!S.user) return renderAuth();
  if (!S.row || !S.content) return renderNoData();
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  const [a, b, c] = parts;
  const inSession = a === 's';
  document.body.classList.toggle('no-tabs', inSession);
  $tabs.hidden = inSession;
  const tab = !a ? 'home' : a === 'lo-trinh' || a === 'm' || a === 'l' ? 'path' : a === 'leetcode' ? 'lc' : 'review';
  $tabs.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  if (!a) renderHome();
  else if (a === 'lo-trinh') renderPath();
  else if (a === 'm' && b) renderModule(decodeURIComponent(b));
  else if (a === 'l' && b) renderLesson(decodeURIComponent(b));
  else if (a === 'on-tap') renderReview();
  else if (a === 'leetcode') renderLc();
  else if (a === 'y-chinh') b ? renderKpLesson(decodeURIComponent(b)) : renderKp();
  else if (inSession && S.sess && S.sess.kind === b && (b !== 'lq' || S.sess.l.id === decodeURIComponent(c || ''))) renderSession();
  else if (inSession && b === 'lq' && c && S.lessonById.has(decodeURIComponent(c))) { startLessonQuiz(S.lessonById.get(decodeURIComponent(c)), true); }
  else return go('#/');
  updateChip();
  if (!inSession) scrollTo(0, 0);
}
function chipHtml() { return `<button class="chip" id="chip"></button>`; }
function updateChip() {
  const el = document.getElementById('chip');
  if (!el) return;
  const n = S.queue.length;
  const waitLaptop = S.serverEv.length;
  if (n) { el.className = 'chip warn'; el.textContent = S.offline || S.sendErr ? `📴 ${n} lượt chờ gửi` : `⏳ Đang gửi ${n}`; }
  else if (S.offline) { el.className = 'chip warn'; el.textContent = '📴 Offline · bản đã lưu'; }
  else if (waitLaptop) { el.className = 'chip'; el.textContent = `☁️ Đã lưu · laptop chờ nhận ${waitLaptop}`; }
  else { el.className = 'chip good'; el.textContent = '✓ Khớp với laptop'; }
  el.onclick = () => toast(n ? 'Các lượt học được giữ trên máy này và tự gửi khi có mạng.' : S.offline ? 'Chưa kết nối được máy chủ — vẫn học bình thường, có mạng sẽ tự đồng bộ.' : waitLaptop ? 'Đã lưu trên mạng. GoPro trên laptop tự nhận khi app đang mở (mỗi 3 phút).' : 'Tiến độ trên web và GoPro trên laptop đang giống nhau.');
}

// ===== Đăng nhập =====
function renderAuth() {
  $tabs.hidden = true;
  document.body.classList.add('no-tabs');
  $app.innerHTML = `
    <form class="panel auth" id="auth" autocomplete="on">
      <div class="brand"><b>GoPro</b><span>Web</span></div>
      <p class="muted small">Đăng nhập bằng tài khoản bạn đã kết nối trong GoPro trên laptop (mục 🌐 GoPro Web).</p>
      <input type="email" id="auth-email" placeholder="Email" autocomplete="username" required>
      <input type="password" id="auth-pass" placeholder="Mật khẩu" autocomplete="current-password" minlength="6" required>
      <button class="btn primary" type="submit" data-mode="login">Đăng nhập</button>
      <button class="btn" type="submit" data-mode="signup">Tạo tài khoản (lần đầu)</button>
      <p class="small muted">GoPro Web chỉ cho phép một tài khoản. Nếu đã tạo trong GoPro trên laptop thì chỉ cần đăng nhập.</p>
      <div id="auth-msg" role="status"></div>
    </form>`;
  const form = document.getElementById('auth');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const mode = (ev.submitter && ev.submitter.dataset.mode) || 'login';
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-pass').value;
    const msg = document.getElementById('auth-msg');
    form.querySelectorAll('button').forEach((x) => (x.disabled = true));
    msg.innerHTML = `<p class="muted small">${mode === 'signup' ? 'Đang tạo tài khoản…' : 'Đang đăng nhập…'}</p>`;
    try {
      if (mode === 'signup') { const { error } = await sb.auth.signUp({ email, password }); if (error) throw error; }
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      S.user = data.user;
      await start();
    } catch (e) {
      msg.innerHTML = `<p class="msg-bad">${esc(authMessage(e))}</p>`;
      form.querySelectorAll('button').forEach((x) => (x.disabled = false));
    }
  };
}
function renderNoData() {
  $tabs.hidden = true;
  $app.innerHTML = `
    <div class="panel">
      <div class="brand"><b>GoPro</b><span>Web</span></div>
      <h2 style="font-size:20px">Chưa có khoá học trên mạng</h2>
      <p class="muted">Mở GoPro trên laptop → mục <b>🌐 GoPro Web</b> → đăng nhập cùng tài khoản này. GoPro sẽ tự tải khoá học và tiến độ lên (khoảng một phút), rồi bấm nút bên dưới.</p>
      <button class="btn primary" id="retry">🔄 Tải lại</button>
      <button class="btn ghost" id="logout">Đăng xuất (${esc(S.user.email)})</button>
    </div>`;
  document.getElementById('retry').onclick = () => start();
  document.getElementById('logout').onclick = logout;
}
async function logout() {
  await sb.auth.signOut();
  S.user = null; S.row = null; S.content = null;
  ls.del('gopro-web-row');
  renderAuth();
}

// ===== Trang chủ =====
function renderHome() {
  const nx = nextLesson();
  const dw = dueWords().length, iv = ivStats(), wr = wrongList().length;
  const today = daySec(dayStr()) + pending.cs + pending.en;
  const target = (S.D.plan.hoursPerWeek || 8) * 3600;
  const wk = weekSec();
  const done = S.lessons.filter((l) => lessonProg(l).done).length;
  const p = nx && lessonProg(nx);
  $app.innerHTML = `
    <div class="top"><div class="brand"><b>GoPro</b><span>Web</span></div>${chipHtml()}</div>
    <div class="panel today">
      <div><b>${fmtMin(today)}</b><span>học hôm nay</span></div>
      <div><b class="count">${S.D.streak}</b><span>ngày liên tiếp</span></div>
      <div><b class="count">${done}/${S.lessons.length}</b><span>bài hoàn thành</span></div>
    </div>
    ${nx ? `<a class="next" href="#/l/${encodeURIComponent(nx.id)}"><small>${p.started ? 'Học tiếp' : 'Bài tiếp theo'} · ${esc(nx.module.title)}</small><b>${esc(nx.title)}</b><small>${nx.minutes ? `~${nx.minutes} phút · ` : ''}${p.read ? '✓ đã đọc' : 'chưa đọc'} · ${nx.quiz.length ? (p.quizOk ? '✓ trắc nghiệm' : 'trắc nghiệm chưa qua') : 'không có trắc nghiệm'}${nx.exercises.length ? ` · bài tập ${p.exDone}/${nx.exercises.length} (làm trên laptop)` : ''}</small></a>` : '<div class="panel">🎉 Bạn đã hoàn thành cả lộ trình!</div>'}
    <div class="section">Ôn tập</div>
    <div class="tiles">
      <button class="tile" data-start="vocab" ${dw ? '' : 'disabled'}><span class="ico">🎴</span><b>Từ vựng</b><span class="sub">${vocabSub()}</span></button>
      <button class="tile" data-start="iv"><span class="ico">🎤</span><b>Phỏng vấn thử</b><span class="sub"><span class="count">${iv.due}</span> đến hạn · ${iv.seen}/${iv.total} đã luyện</span></button>
      <button class="tile" data-start="wrong" ${wr ? '' : 'disabled'}><span class="ico">🔁</span><b>Câu từng sai</b><span class="sub"><span class="count">${wr}</span> câu cần làm lại</span></button>
      <button class="tile" data-start="mix" ${learnedLessons().some((l) => l.quiz.length) ? '' : 'disabled'}><span class="ico">🎲</span><b>Trắc nghiệm trộn</b><span class="sub">10 câu từ bài đã học</span></button>
    </div>
    <div class="panel">
      <div class="row" style="justify-content:space-between;align-items:baseline"><b>Tuần này</b><span class="muted small">${fmtMin(wk)} / ${S.D.plan.hoursPerWeek || 8} giờ</span></div>
      <div class="bar ${wk >= target ? 'good' : ''}"><i style="width:${Math.min(100, (wk / target) * 100)}%"></i></div>
      <p class="small muted">Tính cả giờ học trên laptop và trên web.</p>
    </div>
    <button class="btn ghost" id="logout">Đăng xuất (${esc(S.user.email)})</button>`;
  bindStarts();
  document.getElementById('logout').onclick = logout;
}
function bindStarts() { $app.querySelectorAll('[data-start]').forEach((el) => (el.onclick = () => startSession(el.dataset.start))); }

// ===== Lộ trình =====
function renderPath() {
  $app.innerHTML = `
    <div class="top"><h1 style="font-size:24px">📚 Lộ trình C#</h1>${chipHtml()}</div>
    <div class="list">${S.modules
      .map((m) => {
        const done = m.lessons.filter((l) => lessonProg(l).done).length;
        return `<a href="#/m/${encodeURIComponent(m.id)}"><span class="st">${done === m.lessons.length ? '✅' : done ? '🟡' : '⚪'}</span><span class="tx"><span>${esc(m.title)}</span><small>${m.lessons.length} bài</small><span class="bar modbar ${done === m.lessons.length ? 'good' : ''}"><i style="width:${(done / m.lessons.length) * 100}%"></i></span></span><span class="rt">${done}/${m.lessons.length}</span></a>`;
      })
      .join('')}</div>`;
}
function renderModule(id) {
  const m = S.modules.find((x) => x.id === id);
  if (!m) return go('#/lo-trinh');
  $app.innerHTML = `
    <a class="back" href="#/lo-trinh">← Lộ trình</a>
    <h1 style="font-size:22px">${esc(m.title)}</h1>
    ${m.description ? `<p class="muted">${safe(m.description)}</p>` : ''}
    <div class="list">${m.lessons
      .map((l) => {
        const p = lessonProg(l);
        return `<a href="#/l/${encodeURIComponent(l.id)}"><span class="st">${p.done ? '✅' : p.read ? '📖' : p.started ? '🟡' : '⚪'}</span><span class="tx"><span>${l.num}. ${esc(l.title)}</span><small>${l.minutes ? `~${l.minutes} phút · ` : ''}${l.quiz.length ? `trắc nghiệm ${p.quiz != null ? p.quiz + '%' : 'chưa làm'}` : ''}${l.exercises.length ? ` · bài tập ${p.exDone}/${l.exercises.length}` : ''}</small></span></a>`;
      })
      .join('')}</div>`;
}

// ===== Bài học =====
const LANG = { cs: 'C#', bash: 'Terminal', sql: 'SQL', json: 'JSON', xml: 'XML', text: 'Văn bản', yaml: 'YAML', http: 'HTTP', dockerfile: 'Dockerfile' };
function blocksHtml(blocks) {
  return blocks
    .map((b) => {
      if (b.h != null) return `<h3>${safe(b.h)}</h3>`;
      if (b.p != null) return `<p>${safe(b.p)}</p>`;
      if (b.list) return `<ul>${b.list.map((x) => `<li>${safe(x)}</li>`).join('')}</ul>`;
      if (b.tip != null) return `<div class="callout tip"><span>💡</span><div>${safe(b.tip)}</div></div>`;
      if (b.warn != null) return `<div class="callout warn"><span>⚠️</span><div>${safe(b.warn)}</div></div>`;
      if (b.note != null) return `<div class="callout note"><span>📝</span><div>${safe(b.note)}</div></div>`;
      if (b.table) {
        const [head, ...rows] = b.table;
        return `<div class="tbl"><table><tr>${head.map((c) => `<th>${safe(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${safe(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
      }
      if (b.links) return `<div class="panel links"><b>📚 Tài liệu tham khảo</b>${b.links.map((x) => /^https:\/\//.test(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)} ↗</a>` : '').join('')}</div>`;
      if (b.lab) {
        const lab = b.lab;
        return `<div class="lab"><span class="chip plain">🛠 LAB · làm trên laptop${lab.hasFiles ? ' (Visual Studio)' : ''}${S.D.labs[lab.id] ? ' · ✓ đã xong' : ''}</span><b>${safe(lab.title)}</b>${lab.goal ? `<p>🎯 ${safe(lab.goal)}</p>` : ''}${(lab.steps || []).length ? `<details><summary class="small">Xem ${lab.steps.length} bước</summary><ol>${lab.steps.map((s) => `<li>${safe(s)}</li>`).join('')}</ol></details>` : ''}</div>`;
      }
      if (b.lc) return lcBlock(b.lc);
      if (b.qa != null) return `<details class="qa"><summary><span class="chip">🎤 Câu hỏi phỏng vấn${b.level ? ' · ' + esc(b.level) : ''}</span><b>${safe(b.qa)}</b><span class="hint">Tự trả lời thành tiếng trước — rồi chạm để xem câu trả lời mẫu</span></summary><div class="ans">${safe(b.answer || '')}</div></details>`;
      if (b.output != null) return `<div class="out"><div class="hd">▸ Kết quả in ra</div><pre>${hlEsc(b.output)}</pre></div>`;
      if (b.code != null) {
        const lang = b.lang || 'cs';
        return `<div class="code"><div class="hd"><span>${esc(b.title || LANG[lang] || lang)}</span>${b.run ? '<span>▶ chạy được trên laptop</span>' : ''}</div>${b.setup ? `<details class="setup"><summary>Bảng & dữ liệu dựng sẵn</summary><pre>${highlightCode(b.setup, lang === 'bash' ? 'bash' : 'sql')}</pre></details>` : ''}<pre><code>${highlightCode(b.code, lang)}</code></pre></div>`;
      }
      return '';
    })
    .join('');
}
function renderLesson(id) {
  const l = S.lessonById.get(id);
  if (!l) return go('#/lo-trinh');
  const p = lessonProg(l);
  const next = S.lessons[l.idx + 1];
  $app.innerHTML = `
    <a class="back" href="#/m/${encodeURIComponent(l.module.id)}">← ${esc(l.module.title)}</a>
    <article class="lesson">
      <span class="muted small">Bài ${l.num} · ${l.minutes ? `~${l.minutes} phút` : ''}</span>
      <h1>${esc(l.title)}</h1>
      ${l.summary ? `<p class="muted">${safe(l.summary)}</p>` : ''}
      ${blocksHtml(l.content)}
      ${l.keyPoints.length ? `<div class="kp"><b>💡 Ý chính</b><ul>${l.keyPoints.map((k) => `<li>${safe(k)}</li>`).join('')}</ul></div>` : ''}
    </article>
    <div class="panel">
      <b>Tiến độ bài này</b>
      ${p.read ? '<p class="msg-ok">✓ Đã đọc</p>' : '<button class="btn primary" id="mark-read">✓ Tôi đã đọc xong bài này</button>'}
      ${l.quiz.length ? `<button class="btn ${p.read && !p.quizOk ? 'primary' : ''}" id="lesson-quiz">📝 Trắc nghiệm ${l.quiz.length} câu ${p.quiz != null ? `(lần tốt nhất ${p.quiz}%${p.quizOk ? ' ✓' : `, cần ${PASS}%`})` : ''}</button>` : ''}
    </div>
    ${l.exercises.length ? `<div class="section">Bài tập code — làm trên laptop (${p.exDone}/${l.exercises.length} đã qua)</div>
      ${l.exercises.map((e) => `<div class="ex"><div class="row" style="justify-content:space-between;align-items:center"><b>${esc(e.title)}</b><span class="chip ${S.D.ex[e.id] ? 'good' : 'plain'}">${S.D.ex[e.id] ? '✓ Đã qua' : esc(e.level || '💻 laptop')}</span></div><div>${safe(e.prompt)}</div>${e.plan.length ? `<details><summary>Gợi ý cách làm (${e.plan.length} bước)</summary><ol>${e.plan.map((x) => `<li>${safe(x)}</li>`).join('')}</ol></details>` : ''}${e.hints.length ? `<details><summary>Gợi ý (${e.hints.length})</summary><ul>${e.hints.map((x) => `<li>${safe(x)}</li>`).join('')}</ul></details>` : ''}</div>`).join('')}` : ''}
    ${next ? `<a class="btn" href="#/l/${encodeURIComponent(next.id)}">Bài tiếp: ${esc(next.title)} →</a>` : ''}`;
  const mr = document.getElementById('mark-read');
  if (mr) mr.onclick = () => { record('read', { l: l.id }); toast('Đã đánh dấu đọc xong.'); renderLesson(id); };
  const lq = document.getElementById('lesson-quiz');
  if (lq) lq.onclick = () => startLessonQuiz(l);
}

// ===== Ôn tập =====
function renderReview() {
  const dw = dueWords().length, iv = ivStats(), wr = wrongList().length;
  $app.innerHTML = `
    <div class="top"><h1 style="font-size:24px">🔁 Ôn tập</h1>${chipHtml()}</div>
    <div class="tiles">
      <button class="tile" data-start="vocab" ${dw ? '' : 'disabled'}><span class="ico">🎴</span><b>Từ vựng</b><span class="sub">${vocabSub()} · 20 thẻ/lượt</span></button>
      <button class="tile" data-start="iv"><span class="ico">🎤</span><b>Phỏng vấn thử</b><span class="sub"><span class="count">${iv.due}</span> đến hạn · 5 câu/lượt</span></button>
      <button class="tile" data-start="wrong" ${wr ? '' : 'disabled'}><span class="ico">🔁</span><b>Câu từng sai</b><span class="sub"><span class="count">${wr}</span> câu cần làm lại</span></button>
      <button class="tile" data-start="mix" ${learnedLessons().some((l) => l.quiz.length) ? '' : 'disabled'}><span class="ico">🎲</span><b>Trắc nghiệm trộn</b><span class="sub">10 câu từ bài đã học</span></button>
      <a class="tile wide" href="#/y-chinh"><span class="ico">💡</span><b>Ý chính từng bài</b><span class="sub">Đọc lướt lại khi đang chờ</span></a>
    </div>
    <div class="panel" id="remind"><b>🔔 Nhắc học mỗi ngày</b><p class="muted small">Đang kiểm tra…</p></div>`;
  bindStarts();
  renderRemind();
}

// ===== Nhắc học (Web Push) — trên iPhone cần iOS 16.4+ và mở GoPro từ biểu tượng ở màn hình chính =====
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function vapidKey() {
  const s = GOPRO_CONFIG.vapidPublic.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function swReg() {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return Promise.race([navigator.serviceWorker.register('sw.js'), new Promise((_, no) => setTimeout(() => no(new Error('Hết thời gian chờ')), 8000))]);
}
async function renderRemind() {
  const box = document.getElementById('remind');
  if (!box) return;
  const head = '<b>🔔 Nhắc học mỗi ngày</b>';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    box.innerHTML = head + (isIOS && !standalone()
      ? '<p class="small">Trên iPhone, thông báo chỉ hoạt động khi mở GoPro từ màn hình chính: trong Safari bấm <b>Chia sẻ → Thêm vào MH chính</b>, rồi mở GoPro từ biểu tượng đó và quay lại đây. (Cần iOS 16.4 trở lên.)</p>'
      : '<p class="small muted">Trình duyệt này không hỗ trợ thông báo đẩy.</p>');
    return;
  }
  let reg = null;
  try {
    reg = await swReg();
  } catch (e) {
    box.innerHTML = head + `<p class="small msg-bad">Không bật được bộ nhận thông báo trên trình duyệt này (${esc(e.message || e)}). Trên iPhone hãy mở GoPro từ biểu tượng ở màn hình chính.</p>`;
    return;
  }
  const sub = reg && (await reg.pushManager.getSubscription());
  let row = null;
  if (sub) { const { data } = await sb.from('push_subs').select('hour').eq('endpoint', sub.endpoint).maybeSingle(); row = data; }
  const hour = row ? row.hour : 20;
  const on = !!(sub && row);
  box.innerHTML = `${head}
    <p class="small muted">${on ? `Đang bật — mỗi ngày lúc <b>${hour}:00</b> GoPro báo số từ cần ôn, câu phỏng vấn và câu từng sai đến hạn (không có gì đến hạn thì không làm phiền).` : 'Mỗi ngày một thông báo vào giờ bạn chọn, kèm số việc đến hạn. Không có gì đến hạn thì không báo.'}</p>
    <label class="small">Giờ nhắc <select id="remind-hour">${Array.from({ length: 18 }, (_, i) => i + 6).map((h) => `<option value="${h}" ${h === hour ? 'selected' : ''}>${h}:00</option>`).join('')}</select></label>
    <div class="row">${on ? '<button class="btn" id="remind-save">Lưu giờ</button><button class="btn" id="remind-test">Gửi thử</button><button class="btn ghost" id="remind-off">Tắt nhắc</button>' : '<button class="btn primary" id="remind-on">Bật nhắc học</button>'}</div>
    <div id="remind-msg" class="small" role="status"></div>`;
  const msg = (t, bad) => { document.getElementById('remind-msg').innerHTML = `<span class="${bad ? 'msg-bad' : 'msg-ok'}">${esc(t)}</span>`; };
  const hourVal = () => +document.getElementById('remind-hour').value;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  const save = async (s) => {
    const j = s.toJSON();
    const { error } = await sb.from('push_subs').upsert({ endpoint: s.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, hour: hourVal(), tz, last_sent: null }, { onConflict: 'endpoint' });
    if (error) throw error;
  };
  const btn = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = async () => { el.disabled = true; try { await fn(); } catch (e) { msg(authMessage(e), true); } finally { el.disabled = false; } }; };
  btn('remind-on', async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return msg('Bạn chưa cho phép thông báo. Vào Cài đặt → Thông báo → GoPro để bật lại.', true);
    const s = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey() }));
    await save(s);
    await renderRemind();
    msg('Đã bật nhắc học. Bấm "Gửi thử" để xem thông báo trông thế nào.');
  });
  btn('remind-save', async () => { await save(sub); msg(`Đã lưu: nhắc lúc ${hourVal()}:00 mỗi ngày.`); });
  btn('remind-test', async () => {
    const { data, error } = await sb.functions.invoke('remind', { body: { test: true, delay: 15 } });
    if (error) throw error;
    if (data.scheduledIn) return msg(`Thông báo thử sẽ đến sau ${data.scheduledIn} giây. Hãy vuốt về màn hình chính (hoặc khoá máy) ngay — iPhone không hiện thông báo khi GoPro đang mở trên màn hình.`);
    const ok = (data.results || []).some((r) => r.ok);
    msg(ok ? 'Đã gửi — thông báo sẽ hiện sau vài giây.' : 'Gửi chưa được: ' + JSON.stringify(data.results || data), !ok);
  });
  btn('remind-off', async () => {
    await sb.from('push_subs').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
    await renderRemind();
    msg('Đã tắt nhắc học trên thiết bị này.');
  });
}
function renderKp() {
  const learned = learnedLessons().filter((l) => l.keyPoints.length);
  const item = (l) => `<a href="#/y-chinh/${encodeURIComponent(l.id)}"><span class="tx"><span>${esc(l.title)}</span><small>${esc(l.module.title)}</small></span><span class="rt">${l.keyPoints.length} ý</span></a>`;
  $app.innerHTML = `
    <a class="back" href="#/on-tap">← Ôn tập</a>
    <h1 style="font-size:22px">💡 Ý chính từng bài</h1>
    ${learned.length ? `<div class="section">Bài đã học (${learned.length})</div><div class="list">${learned.map(item).join('')}</div>` : '<div class="panel muted">Chưa có bài nào đã học.</div>'}
    <details class="panel"><summary style="cursor:pointer;font-weight:600">Tất cả các bài (${S.lessons.length})</summary><div class="list" style="margin-top:8px">${S.lessons.filter((l) => l.keyPoints.length).map(item).join('')}</div></details>`;
}
function renderKpLesson(id) {
  const l = S.lessonById.get(id);
  if (!l) return go('#/y-chinh');
  $app.innerHTML = `
    <a class="back" href="#/y-chinh">← Ý chính</a>
    <div class="card"><span class="muted small">${esc(l.module.title)}</span><h2 style="font-size:20px">${esc(l.title)}</h2><ul style="padding-left:20px;margin:0;display:flex;flex-direction:column;gap:8px">${l.keyPoints.map((k) => `<li>${safe(k)}</li>`).join('')}</ul></div>
    <a class="btn" href="#/l/${encodeURIComponent(l.id)}">Mở cả bài →</a>`;
}

// ===== Phiên ôn =====
function startSession(kind) {
  const from = location.hash || '#/';
  if (kind === 'vocab') {
    const v = vocabDue();
    const due = [...shuffle(v.review).sort((a, b) => a.level - b.level), ...v.fresh].slice(0, 20); // từ cũ trước, từ mới sau
    if (!due.length) return toast('Không còn từ nào đến hạn — giỏi lắm!');
    S.sess = { kind, from, queue: due.map((w) => w.k), i: 0, flipped: false, done: 0, total: due.length };
  } else if (kind === 'iv') {
    S.sess = { kind, from, cards: pickIv(5), i: 0, shown: false, scores: [] };
  } else if (kind === 'wrong' || kind === 'mix') {
    S.sess = { kind, from, ...newQuiz(kind === 'wrong') };
    if (!S.sess.qs.length) return toast('Chưa có câu nào để ôn.');
  }
  go('#/s/' + kind);
}
function startLessonQuiz(l, replace) {
  S.sess = { kind: 'lq', l, from: '#/l/' + encodeURIComponent(l.id), qs: shuffle(l.quiz).map((q) => ({ q, l })), i: 0, picked: null, correct: 0, order: null, wrong: [] };
  const h = '#/s/lq/' + encodeURIComponent(l.id);
  if (replace) renderSession(); else go(h);
}
function exitSession() { const to = (S.sess && S.sess.from) || '#/'; S.sess = null; go(to); }
function renderSession() {
  const k = S.sess.kind;
  if (k === 'vocab') return renderVocab();
  if (k === 'iv') return renderIv();
  return renderQuiz();
}
function head(left, mid, right) { return `<div class="sessionhead"><button class="btn ghost" id="exit">← Thoát</button><span class="small muted">${mid}</span><span class="small muted count">${right || ''}</span></div>`; }
function renderDone(icon, title, sub, again) {
  $app.innerHTML = `
    <div class="card done"><div class="big">${icon}</div><h2>${esc(title)}</h2><p class="muted">${sub}</p>
      <div class="row" style="width:100%">${again ? `<button class="btn primary" id="again">Lượt mới</button>` : ''}<button class="btn" id="back">Xong</button></div></div>`;
  const ag = document.getElementById('again');
  if (ag) ag.onclick = () => { const from = S.sess.from; again(); if (S.sess) S.sess.from = from; };
  document.getElementById('back').onclick = exitSession;
}
function speak(text) {
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 0.85; speechSynthesis.speak(u); } catch (e) {}
}
function renderVocab() {
  const s = S.sess;
  if (s.i >= s.queue.length) return renderDone('🎴', `Xong ${s.done} lượt ôn từ vựng`, dueWords().length ? `Còn ${dueWords().length} từ đến hạn.` : 'Đã ôn hết từ đến hạn.', () => startSession('vocab'));
  const w = S.words.get(s.queue[s.i]);
  $app.innerHTML = `
    ${head('', `${Math.min(s.done + 1, s.total)}/${s.total}`)}
    <div class="bar"><i style="width:${(s.done / s.total) * 100}%"></i></div>
    <div class="card flip" id="flip" role="button" tabindex="0" aria-label="Lật thẻ">
      <div class="term">${esc(w.term)}</div>
      ${w.phonetic ? `<div class="phon">${esc(w.phonetic)}</div>` : ''}
      <button class="btn ghost" id="say">🔊 Nghe</button>
      ${s.flipped ? `<div class="def">${esc(w.definition)}</div>${w.example ? `<div class="example">${esc(w.example)}</div>` : ''}` : '<div class="hint">Nhớ nghĩa trong đầu, rồi chạm để lật</div>'}
    </div>
    <div class="dock">${s.flipped ? '<div class="row"><button class="btn bad" id="no">😕 Quên</button><button class="btn good" id="yes">✅ Nhớ</button></div>' : '<button class="btn primary" id="show">Lật thẻ</button>'}</div>`;
  document.getElementById('exit').onclick = exitSession;
  document.getElementById('say').onclick = (e) => { e.stopPropagation(); speak(w.term); };
  const flip = () => { if (!s.flipped) { s.flipped = true; renderVocab(); } };
  document.getElementById('flip').onclick = flip;
  const sh = document.getElementById('show');
  if (sh) sh.onclick = flip;
  const answer = (ok) => {
    record('w', { d: w.deck, w: w.id, ok });
    if (!ok) { s.queue.push(s.queue[s.i]); s.total++; } // quên → gặp lại cuối phiên, như GoPro
    s.i++; s.done++; s.flipped = false;
    renderVocab();
  };
  const y = document.getElementById('yes');
  if (y) { y.onclick = () => answer(true); document.getElementById('no').onclick = () => answer(false); }
}
function pickIv(n) {
  const now = Date.now(), iv = S.D.iv;
  const learned = new Set(learnedLessons().map((l) => l.id));
  const due = shuffle(S.qa.filter((c) => iv[c.key] && iv[c.key].due <= now)).sort((a, b) => iv[a.key].box - iv[b.key].box);
  const fresh = [...shuffle(S.qa.filter((c) => !iv[c.key] && learned.has(c.l.id))), ...shuffle(S.qa.filter((c) => !iv[c.key] && !learned.has(c.l.id)))];
  const rest = shuffle(S.qa.filter((c) => iv[c.key] && iv[c.key].due > now));
  return [...due, ...fresh, ...rest].slice(0, n);
}
let ivTimer = null;
function renderIv() {
  clearInterval(ivTimer);
  const s = S.sess;
  if (s.i >= s.cards.length) {
    const good = s.scores.filter((x) => x === 2).length;
    return renderDone('🎤', `${good}/${s.scores.length} câu trả lời tốt`, 'Câu chưa tốt sẽ được hỏi lại sau 1–3 ngày.', () => startSession('iv'));
  }
  const c = s.cards[s.i];
  if (!s.shown && !s.start) s.start = Date.now();
  $app.innerHTML = `
    <div class="sessionhead"><button class="btn ghost" id="exit">← Thoát</button><span class="small muted">Câu ${s.i + 1}/${s.cards.length}</span><span class="timer" id="timer">0:00</span></div>
    <div class="bar"><i style="width:${(s.i / s.cards.length) * 100}%"></i></div>
    <div class="card">
      <div class="row" style="gap:6px">${c.level ? `<span class="chip">${esc(c.level)}</span>` : ''}<span class="chip plain">${esc(c.l.module.title)}</span></div>
      <div class="q">${safe(c.q)}</div>
      ${s.shown ? `<div class="ans" style="border-top:1px dashed var(--line);padding-top:12px"><div class="small muted">Đáp án mẫu</div>${safe(c.a)}</div>` : '<div class="hint">Nói to câu trả lời như đang ngồi trước người phỏng vấn (60–90 giây), rồi mới mở đáp án.</div>'}
    </div>
    <div class="dock">${s.shown
      ? `<div class="small muted" style="text-align:center">So với đáp án mẫu, bạn trả lời được bao nhiêu?</div><div class="rate"><button class="btn bad" data-s="0"><span>😣</span>Chưa được</button><button class="btn" data-s="1"><span>🤔</span>Một phần</button><button class="btn good" data-s="2"><span>😎</span>Tốt</button></div>`
      : '<button class="btn primary" id="show">Xem đáp án mẫu</button>'}</div>`;
  document.getElementById('exit').onclick = () => { clearInterval(ivTimer); exitSession(); };
  const sh = document.getElementById('show');
  if (sh) sh.onclick = () => { s.shown = true; s.took = Date.now() - s.start; renderIv(); };
  $app.querySelectorAll('[data-s]').forEach((el) => (el.onclick = () => {
    const sc = +el.dataset.s;
    record('i', { key: c.key, s: sc });
    s.scores.push(sc); s.i++; s.shown = false; s.start = 0;
    renderIv();
    scrollTo(0, 0);
  }));
  const tEl = document.getElementById('timer');
  const tick = () => {
    const sec = Math.floor((s.shown ? s.took : Date.now() - s.start) / 1000);
    tEl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    tEl.classList.toggle('long', sec > 90);
  };
  tick();
  if (!s.shown) ivTimer = setInterval(tick, 1000);
}
function newQuiz(onlyWrong) {
  const wrong = wrongList();
  let qs;
  if (onlyWrong) qs = shuffle(wrong).slice(0, 10);
  else {
    const wset = new Set(wrong.map((x) => x.q));
    const rest = learnedLessons().flatMap((l) => l.quiz.filter((q) => !wset.has(q)).map((q) => ({ q, l })));
    qs = shuffle([...shuffle(wrong).slice(0, 10), ...shuffle(rest)].slice(0, 10));
  }
  return { qs, i: 0, picked: null, correct: 0, order: null, wrong: [] };
}
function renderQuiz() {
  const s = S.sess;
  const isLesson = s.kind === 'lq';
  if (s.i >= s.qs.length) return renderQuizDone();
  const { q, l } = s.qs[s.i];
  if (!s.order) s.order = shuffle(q.options.map((_, i) => i)); // đảo thứ tự đáp án để không nhớ vị trí
  const answered = s.picked != null;
  $app.innerHTML = `
    <div class="sessionhead"><button class="btn ghost" id="exit">← Thoát</button><span class="small muted">Câu ${s.i + 1}/${s.qs.length}</span><span class="small muted count">✓ ${s.correct}</span></div>
    <div class="bar"><i style="width:${(s.i / s.qs.length) * 100}%"></i></div>
    <div class="card">
      <span class="small muted">📘 ${esc(isLesson ? 'Trắc nghiệm bài: ' + l.title : l.title)}</span>
      <div class="q">${safe(q.q)}</div>
      ${q.code ? `<div class="code"><pre><code>${highlightCode(q.code, q.lang || 'cs')}</code></pre></div>` : ''}
      <div class="opts">${s.order.map((i) => {
        const cls = answered ? (i === q.answer ? 'right' : i === s.picked ? 'wrong' : '') : '';
        return `<button class="opt ${cls}" data-o="${i}" ${answered ? 'disabled' : ''}>${safe(q.options[i])}</button>`;
      }).join('')}</div>
      ${answered && q.explain ? `<div class="explain">${safe(q.explain)}</div>` : ''}
    </div>
    ${answered ? `<div class="dock"><button class="btn primary" id="next">${s.i + 1 < s.qs.length ? 'Câu tiếp →' : 'Xem kết quả'}</button></div>` : ''}`;
  document.getElementById('exit').onclick = exitSession;
  $app.querySelectorAll('[data-o]').forEach((el) => (el.onclick = () => {
    s.picked = +el.dataset.o;
    const ok = s.picked === q.answer;
    if (ok) s.correct++;
    else s.wrong.push(q);
    if (!isLesson) {
      // Ôn trộn: như GoPro — sai thì thêm vào "từng sai", đúng thì gỡ ra
      const was = new Set((S.D.lessons[l.id] || {}).quizWrong || []).has(quizKey(q));
      if (!ok || was) record('q', { l: l.id, key: quizKey(q), ok });
    }
    renderQuiz();
  }));
  const nx = document.getElementById('next');
  if (nx) nx.onclick = () => { s.i++; s.picked = null; s.order = null; renderQuiz(); scrollTo(0, 0); };
}
function renderQuizDone() {
  const s = S.sess;
  const pct = Math.round((s.correct / s.qs.length) * 100);
  if (s.kind === 'lq' && !s.saved) {
    s.saved = true;
    record('lq', { l: s.l.id, pct, wrong: s.wrong.map(quizKey) });
  }
  const left = wrongList().length;
  const sub = s.kind === 'lq'
    ? pct >= PASS ? `Qua bài trắc nghiệm (cần ${PASS}%).` : `Chưa đạt ${PASS}% — đọc lại phần giải thích rồi làm lại nhé.`
    : left ? `Còn ${left} câu từng sai cần làm lại.` : 'Không còn câu từng sai nào.';
  renderDone(pct >= 80 ? '🏆' : pct >= 50 ? '💪' : '📖', `Đúng ${s.correct}/${s.qs.length} câu (${pct}%)`, esc(sub), s.kind === 'lq' ? () => startLessonQuiz(s.l, true) : () => startSession(s.kind));
}

// ===== Luyện LeetCode (= trang 🧩 trong GoPro; dữ liệu nằm trong content.lc) =====
const LC_DIFF = { E: ['Dễ', 'good'], M: ['Vừa', 'warn'], H: ['Khó', 'bad'] };
const LC_RATE = [['😣', 'Chưa làm được'], ['🤔', 'Xem gợi ý'], ['😎', 'Tự làm được']];
const LC_TOPIC_VI = {
  Array: 'Mảng', String: 'Chuỗi', 'Hash Table': 'Bảng băm', Math: 'Toán', 'Dynamic Programming': 'Quy hoạch động', Sorting: 'Sắp xếp', Greedy: 'Tham lam',
  'Depth-First Search': 'DFS', 'Binary Search': 'Tìm kiếm nhị phân', Matrix: 'Ma trận', 'Breadth-First Search': 'BFS', 'Two Pointers': 'Hai con trỏ', Tree: 'Cây',
  'Prefix Sum': 'Tổng tiền tố', 'Bit Manipulation': 'Thao tác bit', 'Heap (Priority Queue)': 'Heap', Simulation: 'Mô phỏng', 'Binary Tree': 'Cây nhị phân',
  Stack: 'Stack', 'Graph Theory': 'Đồ thị', Counting: 'Đếm', Database: 'SQL', 'Sliding Window': 'Cửa sổ trượt', Design: 'Thiết kế lớp', Backtracking: 'Quay lui',
  'Linked List': 'Danh sách liên kết', Queue: 'Queue', Recursion: 'Đệ quy', 'Monotonic Stack': 'Stack đơn điệu', 'Binary Search Tree': 'Cây tìm kiếm nhị phân',
};
const lcName = (t) => LC_TOPIC_VI[t] || t;
let lcShow = 30, lcOpen = null;
function lcUi() {
  let u = {};
  try { u = JSON.parse(ls.get('gopro-web-lc') || '{}') || {}; } catch (e) {}
  return { src: 'common', period: '0', diff: '', topic: '', status: '', ...u };
}
function lcItems(d, src) {
  if (src === 'common') return d.common.map(([slug, n], i) => ({ slug, n, rank: i + 1 }));
  const c = d.companies.find((x) => x.id === src);
  return c ? c.items.map(([slug, freq, period], i) => ({ slug, freq, period, rank: i + 1 })) : [];
}
function lcDue() { const now = Date.now(); return Object.entries(S.D.lc).filter(([, s]) => s.due <= now).sort((a, b) => a[1].due - b[1].due).map(([k]) => k); }
function lcRow(d, it) {
  const pr = d.problems[it.slug];
  const st = S.D.lc[it.slug];
  const now = Date.now();
  const [dl, dc] = LC_DIFF[pr[1]];
  const meta = it.n != null ? `${it.n}/${d.totalCompanies} công ty` : it.period ? `${it.period === 1 ? '🔥 30 ngày qua' : it.period === 2 ? '3 tháng qua' : it.period === 3 ? '6 tháng qua' : 'trên 6 tháng'}` : '';
  const topics = pr[2].slice(0, 3).map((t) => lcName(d.topics[t])).join(', ');
  return `<div class="lc" data-slug="${esc(it.slug)}">
    <span class="st">${!st ? '⚪' : st.due <= now ? '↻' : LC_RATE[st.last][0]}</span>
    <div class="tx">
      <a href="https://leetcode.com/problems/${esc(it.slug)}/" target="_blank" rel="noopener"><span class="muted">${it.rank}.</span> ${esc(pr[0])} ↗</a>
      <small><span class="chip ${dc}">${dl}</span> ${esc([meta, topics].filter(Boolean).join(' · '))}${st ? ` · đã làm ${st.n} lần` : ''}</small>
      ${lcOpen === it.slug ? `<div class="lc-rate">${LC_RATE.map(([e, t], i) => `<button class="btn ${i === 2 ? 'good' : ''}" data-r="${i}">${e} ${t}</button>`).join('')}</div>` : ''}
    </div>
    <button class="btn lc-btn ${st && st.due <= now ? 'primary' : ''}" data-rate-open>${lcOpen === it.slug ? 'Đóng' : st ? 'Chấm lại' : 'Đã làm'}</button>
  </div>`;
}
function renderLc() {
  const d = S.content.lc;
  if (!d) { $app.innerHTML = `<div class="top"><h1 style="font-size:24px">🧩 LeetCode</h1>${chipHtml()}</div><div class="panel muted">Chưa có danh sách — mở GoPro trên laptop để đồng bộ.</div>`; return; }
  const ui = lcUi();
  if (ui.src !== 'common' && !d.companies.some((c) => c.id === ui.src)) ui.src = 'common';
  const now = Date.now();
  const all = Object.values(S.D.lc);
  const due = lcDue().filter((s) => d.problems[s]);
  const topicIdx = ui.topic ? d.topics.indexOf(ui.topic) : -1;
  const src = lcItems(d, ui.src);
  const tc = new Map();
  for (const it of src) for (const t of (d.problems[it.slug] || [0, 0, []])[2]) tc.set(t, (tc.get(t) || 0) + 1);
  const items = src.filter((it) => {
    const pr = d.problems[it.slug], st = S.D.lc[it.slug];
    if (!pr) return false;
    if (ui.src !== 'common' && ui.period !== '0' && it.period > +ui.period) return false;
    if (ui.diff && pr[1] !== ui.diff) return false;
    if (topicIdx >= 0 && !pr[2].includes(topicIdx)) return false;
    if (ui.status === 'todo' && st) return false;
    if (ui.status === 'done' && !st) return false;
    if (ui.status === 'due' && !(st && st.due <= now)) return false;
    return true;
  });
  const groups = { vn: 'Có văn phòng ở Việt Nam', ms: 'Microsoft', big: 'Big Tech khác' };
  const sel = (k, opts) => `<select data-f="${k}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${ui[k] === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  $app.innerHTML = `
    <div class="top"><h1 style="font-size:24px">🧩 LeetCode</h1>${chipHtml()}</div>
    <div class="panel today">
      <div><b class="count">${all.length}</b><span>đã làm</span></div>
      <div><b class="count">${all.filter((s) => s.due <= now).length}</b><span>cần làm lại</span></div>
      <div><b class="count">${all.filter((s) => s.box >= 3).length}</b><span>đã vững</span></div>
    </div>
    <p class="small muted" style="margin:0 2px">Mở bài, chọn C#, tự làm ~25 phút rồi quay lại tự chấm — GoPro hẹn ngày làm lại. Đồng bộ với trang Luyện LeetCode trên laptop.</p>
    ${due.length ? `<div class="section">↻ Cần làm lại hôm nay</div><div class="lc-list">${due.slice(0, 6).map((slug, i) => lcRow(d, { slug, rank: i + 1, n: (d.common.find((x) => x[0] === slug) || [])[1] })).join('')}</div>` : ''}
    <div class="section">Danh sách</div>
    <div class="lc-filters">
      <select data-f="src"><option value="common" ${ui.src === 'common' ? 'selected' : ''}>⭐ Bài chung hay gặp (${d.common.length})</option>${Object.entries(groups).map(([g, label]) => `<optgroup label="${label}">${d.companies.filter((c) => c.group === g).map((c) => `<option value="${esc(c.id)}" ${ui.src === c.id ? 'selected' : ''}>${esc(c.id)} (${c.items.length})</option>`).join('')}</optgroup>`).join('')}</select>
      ${ui.src !== 'common' ? sel('period', [['0', 'Mọi lúc'], ['1', '30 ngày qua'], ['2', '3 tháng qua'], ['3', '6 tháng qua']]) : ''}
      ${sel('diff', [['', 'Mọi độ khó'], ['E', 'Dễ'], ['M', 'Vừa'], ['H', 'Khó']])}
      ${sel('topic', [['', 'Mọi dạng bài'], ...[...tc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => [d.topics[t], `${lcName(d.topics[t])} (${n})`])])}
      ${sel('status', [['', 'Mọi trạng thái'], ['todo', 'Chưa làm'], ['done', 'Đã làm'], ['due', 'Đến hạn làm lại']])}
    </div>
    <p class="small muted" style="margin:0 2px">${items.length} bài${ui.src === 'common' ? ' · xếp theo số công ty có bài' : ' · bài gần đây lên đầu'}</p>
    <div class="lc-list">${items.slice(0, lcShow).map((it) => lcRow(d, it)).join('') || '<div class="panel muted">Không có bài nào khớp bộ lọc.</div>'}</div>
    ${items.length > lcShow ? `<button class="btn" id="lc-more">Xem thêm</button>` : ''}
    <p class="small muted" style="margin:0 2px">Nguồn: github.com/liquidslr/leetcode-company-wise-problems (cập nhật ${esc((d.updated || '').split('-').reverse().join('/'))}).</p>`;
  $app.querySelectorAll('[data-f]').forEach((s) => (s.onchange = () => {
    const u = lcUi();
    u[s.dataset.f] = s.value;
    if (s.dataset.f === 'src') u.topic = '';
    ls.set('gopro-web-lc', JSON.stringify(u));
    lcShow = 30;
    renderLc();
  }));
  const more = document.getElementById('lc-more');
  if (more) more.onclick = () => { lcShow += 30; lcKeep(); };
  $app.querySelectorAll('.lc').forEach((row) => {
    const slug = row.dataset.slug;
    row.querySelector('[data-rate-open]').onclick = () => { lcOpen = lcOpen === slug ? null : slug; lcKeep(); };
    row.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => {
      record('lc', { s: slug, r: +b.dataset.r });
      lcOpen = null;
      const st = S.D.lc[slug];
      toast(`${LC_RATE[st.last][0]} Đã ghi — làm lại sau ${Math.round((st.due - Date.now()) / DAY)} ngày.`);
      lcKeep();
    }));
  });
  updateChip();
}
function lcKeep() { const y = scrollY; renderLc(); scrollTo(0, y); }

// Khối "Luyện tiếp trên LeetCode" trong bài học (= lcBlockHtml trong GoPro)
function lcBlock(lc) {
  const d = S.content.lc;
  if (!d) return '';
  const now = Date.now();
  const rank = new Map(d.common.map(([s, n]) => [s, n]));
  const rows = (lc.pick || []).filter((s) => d.problems[s]).map((s, i) => {
    const pr = d.problems[s], st = S.D.lc[s];
    const [dl, dc] = LC_DIFF[pr[1]];
    return `<div class="lcb-row"><span class="st">${!st ? '⚪' : st.due <= now ? '↻' : LC_RATE[st.last][0]}</span><div><a href="https://leetcode.com/problems/${esc(s)}/" target="_blank" rel="noopener">${i + 1}. ${esc(pr[0])} ↗</a> <span class="chip ${dc}">${dl}</span>${rank.has(s) ? ` <small class="muted">${rank.get(s)} công ty</small>` : ''}</div></div>`;
  });
  return `<div class="panel lcb"><b>🧩 Luyện tiếp trên LeetCode — ${esc(lcName(lc.topic))}</b><span class="small muted">Làm theo thứ tự bằng C#, xong thì tự chấm ở tab LeetCode.</span>${rows.join('')}<a class="btn" href="#/leetcode" data-lc-topic="${esc(lc.topic)}">Xem mọi bài dạng này →</a></div>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-lc-topic]');
  if (!a) return;
  const u = lcUi();
  Object.assign(u, { src: 'common', topic: a.dataset.lcTopic, period: '0', diff: '', status: '' });
  ls.set('gopro-web-lc', JSON.stringify(u));
  lcShow = 30;
});

// ===== Khởi động =====
async function start() {
  S.dev = ls.get('gopro-web-dev') || 'w' + Math.random().toString(36).slice(2, 8);
  ls.set('gopro-web-dev', S.dev);
  try { S.queue = JSON.parse(ls.get('gopro-web-queue') || '[]'); } catch (e) { S.queue = []; }
  S.lastT = Math.max(0, ...S.queue.map((e) => e.t));
  setLoading('Đang tải tiến độ…');
  try {
    await loadData(true);
  } catch (e) {
    console.warn(e);
    $tabs.hidden = true;
    $app.innerHTML = `<div class="panel"><b>Không tải được dữ liệu</b><p class="muted">${esc(authMessage(e))}</p><button class="btn primary" id="retry">Thử lại</button></div>`;
    document.getElementById('retry').onclick = start;
    return;
  }
  route();
  flushQueue();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => {
  // Đã đăng nhập trên máy này → mở ngay bằng phiên đã lưu, không chờ làm mới phiên qua mạng (mất mạng sẽ treo ~30 giây)
  let saved = null;
  try { saved = JSON.parse(ls.get('gopro-web-auth') || 'null'); } catch (e) {}
  if (saved && saved.user && saved.refresh_token) { S.user = saved.user; return start(); }
  const { data } = await sb.auth.getSession();
  S.user = data.session ? data.session.user : null;
  if (!S.user) return renderAuth();
  start();
})();
sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' && S.user) { S.user = null; renderAuth(); } });
