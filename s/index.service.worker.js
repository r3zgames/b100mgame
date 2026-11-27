// This service worker is required to expose an exported Godot project as a
// Progressive Web App. It provides an offline fallback page telling the user
// that they need an Internet connection to run the project if desired.
// Incrementing CACHE_VERSION will kick off the install event and force
// previously cached resources to be updated from the network.
/** @type {string} */
const CACHE_VERSION = '1795795891|5537068';
/** @type {string} */
const CACHE_PREFIX = 'B100M-sw-cache-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
/** @type {string} */
const OFFLINE_URL = 'index.offline.html';
/** @type {boolean} */
const ENSURE_CROSSORIGIN_ISOLATION_HEADERS = false;
// Files that will be cached on load.
/** @type {string[]} */
const CACHED_FILES = ["index.html","index.js","index.offline.html","index.icon.png","index.apple-touch-icon.png","index.audio.worklet.js","index.audio.position.worklet.js"];
// Files that we might not want the user to preload, and will only be cached on first load.
/** @type {string[]} */
const CACHEABLE_FILES = ["index.wasm","index.pck"];
const FULL_CACHE = CACHED_FILES.concat(CACHEABLE_FILES);

// The first visit's head start: url -> a promise of {buf, headers} (null if it failed).
const EARLY = new Map();

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHED_FILES)));
	if (!ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
		return;
	}
	event.waitUntil(caches.keys().then((keys) => {
		if (keys.some((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)) {
			return;
		}
		CACHEABLE_FILES.forEach((name) => {
			const href = new URL(name, self.registration.scope).href;
			EARLY.set(href, self.fetch(href).then(async (r) => (r.ok ? { buf: await r.arrayBuffer(), headers: r.headers } : null)).catch(() => null));
		});
	}));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(caches.keys().then(
		function (keys) {
			// Remove old caches.
			return Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
		}
	).then(function () {
		// Enable navigation preload if available.
		return ('navigationPreload' in self.registration) ? self.registration.navigationPreload.enable() : Promise.resolve();
	}));
});

/**
 * Ensures that the response has the correct COEP/COOP headers
 * @param {Response} response
 * @returns {Response}
 */
function ensureCrossOriginIsolationHeaders(response) {
	if (response.type === 'opaqueredirect' || response.status === 0) {
		return response;
	}
	if (response.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp'
		&& response.headers.get('Cross-Origin-Opener-Policy') === 'same-origin') {
		return response;
	}

	const crossOriginIsolatedHeaders = new Headers(response.headers);
	crossOriginIsolatedHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
	crossOriginIsolatedHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
	const newResponse = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: crossOriginIsolatedHeaders,
	});

	return newResponse;
}

/**
 * Calls fetch and cache the result if it is cacheable
 * @param {FetchEvent} event
 * @param {Cache} cache
 * @param {boolean} isCacheable
 * @returns {Response}
 */
async function fetchAndCache(event, cache, isCacheable) {
	// Use the preloaded response, if it's there
	/** @type { Response } */
	let response = await event.preloadResponse;
	if (response == null) {
		// Or, go over network.
		response = await self.fetch(event.request);
	}

	if (ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
		response = ensureCrossOriginIsolationHeaders(response);
	}

	if (isCacheable) {
		// And update the cache
		cache.put(event.request, response.clone());
	}

	return response;
}

self.addEventListener(
	'fetch',
	/**
	 * Triggered on fetch
	 * @param {FetchEvent} event
	 */
	(event) => {
		const isNavigate = event.request.mode === 'navigate';
		const url = event.request.url || '';
		const referrer = event.request.referrer || '';
		const base = referrer.slice(0, referrer.lastIndexOf('/') + 1);
		const local = url.startsWith(base) ? url.replace(base, '') : '';
		const isCacheable = FULL_CACHE.some((v) => v === local) || (base === referrer && base.endsWith(CACHED_FILES[0]));
		if (isNavigate || isCacheable) {
			event.respondWith((async () => {
				// Try to use cache first
				const cache = await caches.open(CACHE_NAME);
				if (isNavigate) {
					// Check if we have full cache during HTML page request.
					/** @type {Response[]} */
					const fullCache = await Promise.all(FULL_CACHE.map((name) => cache.match(name)));
					const missing = fullCache.some((v) => v === undefined);
					if (missing) {
						try {
							// Try network if some cached file is missing (so we can display offline page in case).
							const response = await fetchAndCache(event, cache, isCacheable);
							return response;
						} catch (e) {
							// And return the hopefully always cached offline page in case of network failure.
							console.error('Network error: ', e); // eslint-disable-line no-console
							return caches.match(OFFLINE_URL);
						}
					}
				}
				let cached = await cache.match(event.request);
				if (cached != null) {
					if (ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
						cached = ensureCrossOriginIsolationHeaders(cached);
					}
					return cached;
				}
				// Try network if don't have it in cache.
				try {
					const early = EARLY.get(url);
					if (early) {
						// The first visit's head start (see install): what has come already.
						EARLY.delete(url);
						const got = await early;
						if (got) {
							let ready = new Response(got.buf, { status: 200, headers: got.headers });
							if (ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
								ready = ensureCrossOriginIsolationHeaders(ready);
							}
							if (isCacheable) {
								cache.put(event.request, ready.clone());
							}
							return ready;
						}
					}
					return await fetchAndCache(event, cache, isCacheable);
				} catch (e) {
					// Offline at the folder's address: the cached game page.
					const page = isNavigate && new URL(event.request.url).pathname === new URL(self.registration.scope).pathname
						? await cache.match(CACHED_FILES[0]) : undefined;
					if (page) {
						return ENSURE_CROSSORIGIN_ISOLATION_HEADERS ? ensureCrossOriginIsolationHeaders(page) : page;
					}
					throw e;
				}
			})());
		} else if (ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
			event.respondWith((async () => {
				let response = await fetch(event.request);
				response = ensureCrossOriginIsolationHeaders(response);
				return response;
			})());
		}
	}
);

self.addEventListener('message', (event) => {
	// No cross origin
	if (event.origin !== self.origin) {
		return;
	}
	const id = event.source.id || '';
	const msg = event.data || '';
	// Ensure it's one of our clients.
	self.clients.get(id).then(function (client) {
		if (!client) {
			return; // Not a valid client.
		}
		if (msg === 'claim') {
			self.skipWaiting().then(() => self.clients.claim());
		} else if (msg === 'clear') {
			caches.delete(CACHE_NAME);
		} else if (msg === 'update') {
			self.skipWaiting().then(() => self.clients.claim()).then(() => self.clients.matchAll()).then((all) => all.forEach((c) => c.navigate(c.url)));
		}
	});
});

