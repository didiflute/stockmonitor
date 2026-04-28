// Service Worker - Network First 策略
// 解决 iOS PWA 顽固缓存问题: 每次请求都先尝试网络, 失败才回退到缓存

const CACHE_NAME = "tqqq-dashboard-v1";

self.addEventListener("install", event => {
  // 跳过等待, 立即接管
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  // 立即接管所有 client
  event.waitUntil(
    (async () => {
      // 删掉所有老缓存
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", event => {
  // Network First: 始终先尝试拉最新
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(event.request, { cache: "no-store" });
        // 成功的响应顺手缓存一份 (供离线场景)
        if (fresh.ok && event.request.method === "GET") {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (e) {
        // 网络失败才回退缓存
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw e;
      }
    })()
  );
});
