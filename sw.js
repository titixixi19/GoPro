/* GoPro Web — service worker: nhận thông báo nhắc học + giữ bản sao trang để mở được khi mất mạng.
   Trang (HTML/JS/CSS): lấy từ mạng trước để bản mới luôn được dùng ngay; mạng lỗi hoặc quá 4 giây thì dùng bản đã lưu.
   Phông chữ Google: dùng bản đã lưu, cập nhật ngầm. Yêu cầu tới Supabase không đi qua đây (app tự xử lý khi mất mạng). */
const SHELL = 'gopro-shell-v1';
const CORE = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'highlight.js', 'vendor/supabase-2.49.4.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const NET_WAIT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(CORE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // Chỉ dọn bản sao trang cũ — cache 'gopro-content' (khoá học) do app.js quản lý
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('gopro-shell') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(req, key) {
  return caches.open(SHELL).then((cache) => {
    const net = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone()).catch(() => {});
      return res;
    });
    const fromCache = () => cache.match(key, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? cache.match('./') : null));
    return new Promise((resolve, reject) => {
      let done = false;
      const fallback = () => fromCache().then((hit) => { if (hit && !done) { done = true; resolve(hit); } return hit; });
      const timer = setTimeout(fallback, NET_WAIT);
      net.then((res) => { clearTimeout(timer); if (!done) { done = true; resolve(res); } })
        .catch((err) => { clearTimeout(timer); fallback().then((hit) => { if (!hit && !done) { done = true; reject(err); } }); });
    });
  });
}
function cacheFirst(req) {
  return caches.open(SHELL).then((cache) => cache.match(req).then((hit) => {
    const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {}); return res; });
    if (hit) { net.catch(() => {}); return hit; }
    return net;
  }));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith(new URL(self.registration.scope).pathname)) {
    // Trang mở bằng điều hướng (kể cả từ màn hình chính) → luôn lưu dưới khoá './'
    e.respondWith(networkFirst(req, req.mode === 'navigate' ? './' : req));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(req));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'GoPro', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'gopro-remind', renotify: true, timestamp: Date.now(), data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data.url || './');
  }));
});
