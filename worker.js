import { Client } from "@mtkruto/mtkruto";
import {
    TelegramClient as MtcuteClient
} from "@mtcute/core/client.js";

import {
    MemoryStorage
} from "@mtcute/core";

import {
    WebCryptoProvider,
    WebSocketTransport,
    WebPlatform
} from "@mtcute/web";

// Pre-compiled WASM module for mtcute's crypto (AES-IGE/CTR, sha, gunzip).
// Workers can't compile WASM at runtime, and mtcute's default loader does
// `new URL("../mtcute.wasm", import.meta.url)`, which throws
// "Invalid URL string." inside a bundled Worker. wrangler turns a .wasm
// import into a ready-to-use WebAssembly.Module.
import mtcuteWasm from "@mtcute/wasm/mtcute.wasm";

import { DurableObject } from "cloudflare:workers";

// Video streaming is deliberately separate from the /piece API.
// Follow TgStreamer’s conservative streaming behavior at the Worker layer:
// one active HTTP media stream per Durable Object, strict cancellation on
// seek/disconnect, aligned offsets, and bounded stream buffering. The mtcute
// 0.32 API does not expose TgStreamer’s old throttle hook, so this Worker
// cannot patch mtcute’s internal worker pool from this file alone.
const TELEGRAM_CHUNK_SIZE = 1024 * 1024;
const TELEGRAM_OFFSET_ALIGNMENT = 4096;
const TELEGRAM_FRAGMENT_SIZE = 1024 * 1024;
// ---- mtcute video streaming (modelled on tgstreamer) -----------------
// tgstreamer opens one download per HTTP Range request starting at an
// aligned offset, never passes `limit`/`fileSize` (mtcute only accepts a
// limit equal to the file size or a divisor of 1 MB), slices the first
// bytes itself, and aborts the download as soon as it has the bytes the
// client asked for. Backpressure there comes from a `throttle` hook that
// mtcute 0.32 no longer has; 0.32's downloadAsStream has `highWaterMark`
// instead ("pause the download while this many bytes are buffered").
const MTCUTE_PART_SIZE_KB = 512;                      // Telegram's max part size
const MTCUTE_PART_BYTES = MTCUTE_PART_SIZE_KB * 1024; // offsets are aligned to this
const MTCUTE_HIGH_WATER_MARK = 4 * 1024 * 1024;     // TgStreamer-style bounded read-ahead
const MTCUTE_STALL_TIMEOUT_MS = 60000;
const MTCUTE_STREAM_QUEUE_CHUNKS = 1;

// Number of Telegram file reads kept ahead of the browser.
const VIDEO_STREAM_WORKERS = 6;

// A seek must not leave several Telegram upload.getFile pipelines running.
// New streams cancel the previous stream instead of allowing up to eight.
const MAX_ACTIVE_MULTIPART_DOWNLOADS = 1;

// A Durable Object has a CPU budget PER INVOCATION (30 s by default). One
// open-ended browser request ("Range: bytes=N-") would keep a single RPC
// stream alive for the whole rest of the file, so the decrypt/copy work of
// the entire video piles up in one invocation until the DO is reset. Each
// response is therefore capped; players simply ask for the next range, and
// each new request starts with a fresh budget. Raise it if range boundaries
// ever cause visible stutter, lower it if the CPU limit still triggers.
const MAX_HTTP_RANGE_SIZE = 16 * 1024 * 1024;

const CACHE_CONTROL = "public, max-age=31536000, immutable";

// What the BROWSER is told for /media responses: always revalidate. The
// ETag is the Telegram file id, so an unchanged image answers 304 instantly
// and a replaced image is picked up on the very next request.
const BROWSER_CACHE_CONTROL = "private, no-cache";

// Files at or under this size are downloaded into memory and served as a
// single buffer, which makes them safely cacheable (see
// bufferFullDownload). Anything larger is streamed and not cached.
const MAX_BUFFERED_SIZE = 2 * 1024 * 1024;

// Only log things that took longer than this (or failed).
const SLOW_MS = 5000;

// Resolved media/multipart info is cached inside the Durable Object so a
// video player's many Range requests don't each redo Telegram lookups.
const MEDIA_CACHE_TTL_MS = 15 * 60 * 1000;
const MEDIA_CACHE_MAX = 500;
const THUMB_CACHE_MAX_ROWS = 10000;
const THUMB_CACHE_MAX_BYTES = 1.5 * 1024 * 1024;

// Un-versioned thumbnail rows (batch API) expire; versioned ones never need to.
const THUMB_CACHE_TTL_MS = 10 * 60 * 1000;

// How long the message lookup for an image/thumbnail is reused. Short, so an
// edited message is noticed quickly; videos keep the longer MEDIA_CACHE_TTL_MS.
const IMAGE_META_TTL_MS = 10 * 1000;

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;

    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (true) {
                const i = next++;
                if (i >= items.length) return;
                results[i] = await fn(items[i], i);
            }
        }
    );

    await Promise.all(workers);
    return results;
}

// Global cap on simultaneous Telegram download requests, with a priority
// lane. Small, latency-sensitive downloads (thumbnails) jump ahead of bulk
// stream chunks, so a big image or video can't starve them on the shared
// connection. Cancelled stream chunks are skipped before they start.
const TELEGRAM_MAX_IN_FLIGHT = 12;

// Bulk (stream/chunk) downloads may only use this many of those slots.
// Everything is multiplexed over ONE Telegram connection, so each extra
// 1 MiB bulk chunk in flight is another megabyte a tiny thumbnail response
// has to wait behind. Keeping bulk low leaves the pipe nearly empty for
// thumbnails. Raise it if single big downloads feel too slow; lower it if
// thumbnails are still slow while big files stream.
const TELEGRAM_MAX_BULK_IN_FLIGHT = 8;

// Minimum gap between starting two bulk Telegram requests. 0 = no pacing.
// Telegram appears to throttle bursts of upload.getFile calls (the whole
// connection stalls for seconds). Set this to ~1000 / (safe requests per
// second) once /api/paced shows which rate avoids the stalls.
const TELEGRAM_BULK_GAP_MS = 0;

class TelegramScheduler {
    constructor(limit, lowLimit, lowGapMs = 0) {
        this.lowGapMs = lowGapMs;
        this.nextLowAt = 0;
        this.pumpTimer = null;
        this.limit = limit;
        this.lowLimit = lowLimit;
        this.active = 0;
        this.activeLow = 0;
        this.high = [];
        this.low = [];
        this.running = new Set();
    }

    // order: lower runs first among "low" jobs, so an older stream finishes
    // before a newer one gets slots. timeoutMs frees the slot if Telegram
    // never answers (the underlying call can't be aborted, but it no longer
    // blocks everyone else).
    run(fn, priority = "low", order = 0, timeoutMs = 0, isCancelled = null) {
        return new Promise((resolve, reject) => {
            (priority === "high" ? this.high : this.low)
                .push({
                    fn,
                    resolve,
                    reject,
                    order,
                    timeoutMs,
                    isCancelled,
                    isLow: priority !== "high"
                });

            this.#pump();
        });
    }

    #next() {
        if (this.high.length) return this.high.shift();

        // Drop jobs whose stream was cancelled before they ever started.
        this.low = this.low.filter(job => {
            if (job.isCancelled?.()) {
                job.resolve(null);
                return false;
            }
            return true;
        });

        if (!this.low.length || this.activeLow >= this.lowLimit) {
            return null;
        }

        const orderOf = job =>
            typeof job.order === "function" ? job.order() : job.order;

        // Newest stream first (the one the user just seeked to). Ties
        // (same stream) keep queue order because the comparison is strict.
        let best = 0;

        for (let i = 1; i < this.low.length; i++) {
            if (orderOf(this.low[i]) > orderOf(this.low[best])) best = i;
        }

        return this.low.splice(best, 1)[0];
    }

    #pump() {
        while (this.active < this.limit) {
            // Pace bulk starts (thumbnails / "high" jobs are never delayed).
            if (this.lowGapMs > 0 && !this.high.length && this.low.length) {
                const wait = this.nextLowAt - Date.now();

                if (wait > 0) {
                    if (!this.pumpTimer) {
                        this.pumpTimer = setTimeout(() => {
                            this.pumpTimer = null;
                            this.#pump();
                        }, wait);
                    }

                    return;
                }
            }

            const job = this.#next();
            if (!job) return;

            if (job.isLow && this.lowGapMs > 0) {
                this.nextLowAt =
                    Math.max(Date.now(), this.nextLowAt) + this.lowGapMs;
            }

            this.active++;
            if (job.isLow) this.activeLow++;
            this.running.add(job);

            let timer = null;
            const work = Promise.resolve().then(job.fn);

            const raced = job.timeoutMs
                ? Promise.race([
                    work,
                    new Promise((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error(
                                "Telegram request timed out after " +
                                Math.round(job.timeoutMs / 1000) + "s."
                            )),
                            job.timeoutMs
                        );
                    })
                ])
                : work;

            raced
                .then(job.resolve, job.reject)
                .finally(() => {
                    if (timer) clearTimeout(timer);
                    this.running.delete(job);

                    if (!job.freed) {
                        this.active--;
                        if (job.isLow) this.activeLow--;
                    }

                    this.#pump();
                });
        }
    }

    // A Telegram call can't be aborted, but once every stream waiting on it
    // is cancelled (e.g. the user seeked) its result is useless. Free its
    // slot now so the new stream doesn't wait for the old call to finish.
    sweepCancelled() {
        let freed = false;

        for (const job of this.running) {
            if (!job.freed && job.isLow && job.isCancelled?.()) {
                job.freed = true;
                this.active--;
                this.activeLow--;
                freed = true;
            }
        }

        if (freed) this.#pump();
    }

    stats() {
        return {
            active: this.active,
            activeBulk: this.activeLow,
            queuedHigh: this.high.length,
            queuedLow: this.low.length
        };
    }
}

const telegramScheduler = new TelegramScheduler(
    TELEGRAM_MAX_IN_FLIGHT,
    TELEGRAM_MAX_BULK_IN_FLIGHT,
    TELEGRAM_BULK_GAP_MS
);

// Thumbnails get their own small, paced lane. A page of 60 thumbnails used
// to fire up to 8 upload.getFile calls at once, which is what produces
// "flood wait ... upload.getFile" from Telegram (and then every download on
// the account stalls for those seconds). Two at a time, 250 ms apart.
const thumbScheduler = new TelegramScheduler(2, 2, 250);

const TELEGRAM_CHUNK_TIMEOUT_MS = 60 * 1000;
const TELEGRAM_BUFFER_TIMEOUT_MS = 60 * 1000;
let streamSeq = 0;

// Chunk cache with in-flight dedupe. Overlapping browser range requests,
// stale + new seek streams, and prefetches all share one Telegram fetch per
// 1 MiB-aligned chunk. Lives in the Durable Object's isolate.
const CHUNK_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const chunkCache = new Map();    // key -> Uint8Array (insertion order = LRU)
const chunkInflight = new Map(); // key -> { promise, waiters, order }
let chunkCacheBytes = 0;

const chunkStats = { n: 0, ms: 0, bytes: 0, since: Date.now() };

// One summary line per 10 chunks: average per-chunk time and real
// aggregate throughput (KB/s over wall-clock time, all chunks in flight).
function recordChunkStat(ms, bytes) {
    chunkStats.n++;
    chunkStats.ms += ms;
    chunkStats.bytes += bytes;

    if (chunkStats.n >= 10) {
        const wall = Date.now() - chunkStats.since;

        console.log("chunk stats:", JSON.stringify({
            chunks: chunkStats.n,
            avgChunkMs: Math.round(chunkStats.ms / chunkStats.n),
            throughputKBps: Math.round(chunkStats.bytes / 1024 / (wall / 1000)),
            ...telegramScheduler.stats()
        }));

        chunkStats.n = 0;
        chunkStats.ms = 0;
        chunkStats.bytes = 0;
        chunkStats.since = Date.now();
    }
}

function cachedChunk(client, fileId, offset, order, isCancelled) {
    const key = fileId + ":" + offset;

    const hit = chunkCache.get(key);

    if (hit) {
        chunkCache.delete(key);
        chunkCache.set(key, hit);
        return Promise.resolve(hit);
    }

    let entry = chunkInflight.get(key);

    if (entry) {
        entry.waiters.add(isCancelled);
        entry.order = Math.max(entry.order, order);
        return entry.promise;
    }

    entry = { waiters: new Set([isCancelled]), order };
    const current = entry;

    let startedAt = 0;

    entry.promise = telegramScheduler.run(
        () => {
            startedAt = Date.now();

            return client.downloadChunk(fileId, {
                offset,
                chunkSize: TELEGRAM_FRAGMENT_SIZE
            });
        },
        "low",
        () => current.order,
        TELEGRAM_CHUNK_TIMEOUT_MS,
        // Only skip if EVERY stream waiting on this chunk is cancelled.
        () => [...current.waiters].every(f => f())
    ).then(bytes => {
        if (bytes?.length) {
            recordChunkStat(Date.now() - startedAt, bytes.length);
            chunkCache.set(key, bytes);
            chunkCacheBytes += bytes.length;

            while (chunkCacheBytes > CHUNK_CACHE_MAX_BYTES) {
                const [oldKey, old] = chunkCache.entries().next().value;
                chunkCache.delete(oldKey);
                chunkCacheBytes -= old.length;
            }
        }

        return bytes;
    }).finally(() => {
        if (chunkInflight.get(key) === current) chunkInflight.delete(key);
    });

    chunkInflight.set(key, entry);

    return entry.promise;
}

// upload.getFile only accepts a limit that is 4096 * 2^k (max 1 MiB), at an
// offset that is a multiple of that limit, and the read must stay inside one
// 1 MiB fragment. Any other size (e.g. a "remaining bytes" tail) is rejected
// with LIMIT_INVALID. Callers slice off whatever extra bytes come back.
function telegramRequestSize(offset, remaining) {
    let want = TELEGRAM_OFFSET_ALIGNMENT;

    while (want < remaining && want < TELEGRAM_FRAGMENT_SIZE) {
        want *= 2;
    }

    let align = TELEGRAM_FRAGMENT_SIZE;

    while (align > TELEGRAM_OFFSET_ALIGNMENT && offset % align !== 0) {
        align /= 2;
    }

    return Math.min(want, align);
}


// Error messages use this prefix so a failure is visible as structured JSON in
// Cloudflare Invocations even when console output is unavailable.
const TG_DIAGNOSTIC_PREFIX = "TG_DIAGNOSTIC_JSON:";

function diagnosticError(event) {
    const error = new Error(TG_DIAGNOSTIC_PREFIX + JSON.stringify(event));
    error.name = "TelegramDiagnosticError";
    return error;
}

function floodWaitSeconds(error) {
    const message = String(error?.message || error || "");
    const patterns = [
        /flood\s*wait[^\d]{0,40}(\d+)\s*seconds?/i,
        /retry\s+in\s+(\d+)\s+seconds?/i,
        /FLOOD_WAIT[_ ]?(\d+)/i
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(message);
        if (match) return Math.max(1, Math.min(86400, Number(match[1]) || 1));
    }
    return 0;
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...extraHeaders
        }
    });
}

// String.fromCharCode(...bytes) can overflow the call stack on large
// arrays, so build the string in chunks. Only used for thumbnail-sized
// buffers (see MAX_BUFFERED_SIZE), so this is always small in practice.
function bufferToBase64(bytes) {
    const CHUNK = 8192;
    let binary = "";

    for (
        let i = 0;
        i < bytes.length;
        i += CHUNK
    ) {
        binary += String.fromCharCode(
            ...bytes.subarray(
                i,
                i + CHUNK
            )
        );
    }

    return btoa(binary);
}

class CloudflareKVStorage {
    constructor(kv, id = null, prefix = "mtkruto") {
        this.kv = kv;
        this._id = id;
        this.prefix = prefix;
    }

    get supportsFiles() {
        return false;
    }

    get mustSerialize() {
        return true;
    }

    get isMemory() {
        return false;
    }

    branch(id) {
        const branchId =
            this._id !== null
                ? `${this._id}S__${id}`
                : id;

        return new CloudflareKVStorage(
            this.kv,
            branchId,
            this.prefix
        );
    }

    async initialize() {}

    async close() {}

    fixKey(key) {
        if (this._id !== null) {
            return ["__S" + this._id, ...key];
        }

        return key;
    }

    encodePart(part) {
        if (typeof part === "bigint") {
            return `b:${part}`;
        }

        if (typeof part === "number") {
            return `n:${part}`;
        }

        return `s:${encodeURIComponent(part)}`;
    }

    decodePart(part) {
        const type = part.slice(0, 2);
        const value = part.slice(2);

        if (type === "b:") {
            return BigInt(value);
        }

        if (type === "n:") {
            return Number(value);
        }

        if (type === "s:") {
            return decodeURIComponent(value);
        }

        throw new Error(`Invalid MTKruto storage key part: ${part}`);
    }

    makeKey(key) {
        return this.prefix + ":" +
            this.fixKey(key)
                .map(part => this.encodePart(part))
                .join(":");
    }

    decodeKey(key) {
        const prefix = this.prefix + ":";

        if (!key.startsWith(prefix)) {
            return null;
        }

        return key
            .slice(prefix.length)
            .split(":")
            .map(part => this.decodePart(part));
    }

    serialize(value) {
        return JSON.stringify(value, (_, value) => {
            if (typeof value === "bigint") {
                return {
                    __mtkruto_type: "bigint",
                    value: value.toString()
                };
            }

            if (value instanceof Uint8Array) {
                return {
                    __mtkruto_type: "uint8array",
                    value: Array.from(value)
                };
            }

            if (value instanceof ArrayBuffer) {
                return {
                    __mtkruto_type: "arraybuffer",
                    value: Array.from(new Uint8Array(value))
                };
            }

            return value;
        });
    }

    deserialize(value) {
        return JSON.parse(value, (_, value) => {
            if (
                value &&
                typeof value === "object" &&
                value.__mtkruto_type === "bigint"
            ) {
                return BigInt(value.value);
            }

            if (
                value &&
                typeof value === "object" &&
                value.__mtkruto_type === "uint8array"
            ) {
                return new Uint8Array(value.value);
            }

            if (
                value &&
                typeof value === "object" &&
                value.__mtkruto_type === "arraybuffer"
            ) {
                return new Uint8Array(value.value).buffer;
            }

            return value;
        });
    }

    async get(key) {
        const value =
            await this.kv.get(
                this.makeKey(key)
            );

        if (value === null) {
            return null;
        }

        return this.deserialize(value);
    }

    async *getMany(filter, params = {}) {
        let prefix;

        if ("prefix" in filter) {
            prefix = this.makeKey(filter.prefix);
        } else {
            prefix = this.prefix + ":";
        }

        let cursor;

        do {
            const result =
                await this.kv.list({
                    prefix,
                    limit: params.limit || 1000,
                    ...(cursor ? { cursor } : {})
                });

            const names =
                result.keys.map(item => item.name);

            const values =
                names.length
                    ? await this.kv.get(names)
                    : new Map();

            for (const name of names) {
                const decoded =
                    this.decodeKey(name);

                if (!decoded) {
                    continue;
                }

                const value =
                    values.get(name);

                if (value === null || value === undefined) {
                    continue;
                }

                const fixed =
                    this._id !== null
                        ? decoded.slice(1)
                        : decoded;

                yield [
                    fixed,
                    this.deserialize(value)
                ];
            }

            if (result.list_complete) {
                break;
            }

            cursor = result.cursor;
        } while (cursor);
    }

    async set(key, value) {
        const kvKey =
            this.makeKey(key);

        if (value === null) {
            await this.kv.delete(kvKey);
            return;
        }

        await this.kv.put(
            kvKey,
            this.serialize(value)
        );
    }

    async incr(key, by) {
        const kvKey =
            this.makeKey(key);

        const current =
            await this.kv.get(kvKey);

        let value =
            current === null
                ? 0
                : Number(
                    this.deserialize(current)
                );

        if (!Number.isFinite(value)) {
            value = 0;
        }

        await this.kv.put(
            kvKey,
            this.serialize(value + by)
        );
    }
}

// A single Durable Object instance holds the one persistent Telegram
// client. This is the sanctioned way to keep an I/O object (a live
// MTProto socket) alive across many requests on Cloudflare Workers: a
// DO processes its own invocations sequentially, so it is exempt from
// the "I/O objects can't cross requests" restriction that broke an
// earlier attempt to do this with a module-scope client in the plain
// Worker (see the DO class near the bottom of this file for the
// explanation of that restriction and why a DO is different).
//
// One Telegram session (one authString) backs one Telegram account, and
// MTProto multiplexes many calls over a single connection just fine, so
// there's no benefit to sharding this by chat -- every shard would be
// the same account anyway. Hence a single fixed instance name.
function getConnectionStub(env) {
    const id =
        env.TELEGRAM_DO.idFromName(
            "telegram-client"
        );

    return env.TELEGRAM_DO.get(id);
}

// cache.put() can throw synchronously for a handful of reasons (a 206
// response, a Vary: * header, a body over the size limit, etc). Caching
// is always a best-effort side channel -- it must never be able to turn
// a successful response into a 500. This wraps both the synchronous
// call and the returned promise so nothing from cache.put() can escape.
function safeCachePut(ctx, cache, request, response) {
    if (!ctx || !cache) {
        return;
    }

    try {
        const toCache =
            response.clone();

        ctx.waitUntil(
            Promise.resolve(
                cache.put(request, toCache)
            ).catch(() => {})
        );
    } catch {
        // Ignore -- caching is never allowed to affect the real response.
    }
}

async function createMtcuteClient(env) {
    const [apiIdRaw, apiHash, session, botToken] = await Promise.all([
        env.API_ID.get(), env.API_HASH.get(),
        env.MTCUTE_SESSION?.get?.() ?? Promise.resolve(null),
        env.MTCUTE_BOT_TOKEN?.get?.() ?? Promise.resolve(null)
    ]);
    const apiId = Number(apiIdRaw);
    if (!apiId || !apiHash) throw new Error("Telegram API credentials are not configured.");
    if (!session && !botToken) throw new Error("MTCUTE_SESSION or MTCUTE_BOT_TOKEN must be configured for video streaming.");
    // Cloudflare Workers is not one of mtcute's built-in runtimes, so
    // do NOT rely on @mtcute/web's environment detection here. Construct
    // the core client explicitly and provide every runtime dependency.
    // mtcute 0.32 takes a transport INSTANCE (not a factory).
    const client = new MtcuteClient({
        apiId,
        apiHash,
        storage: new MemoryStorage(),
        transport: new WebSocketTransport(),
        crypto: new WebCryptoProvider({ wasmInput: mtcuteWasm }),
        platform: new WebPlatform(),
        disableUpdates: true
    });

    await client.start(
        botToken
            ? { botToken }
            : {
                session,
                sessionForce: true
            }
    );

    return client;
}

async function createClient(env) {
    // These were three sequential awaits; each is its own round trip to
    // the Secrets Store, and this runs on every single request now, so
    // running them concurrently is a small, free win on every request.
    const [
        apiIdRaw,
        apiHash,
        session
    ] = await Promise.all([
        env.API_ID.get(),
        env.API_HASH.get(),
        env.MTKRUTO_SESSION.get()
    ]);

    const apiId =
        Number(apiIdRaw);

    if (!apiId || !apiHash || !session) {
        throw new Error(
            "Telegram credentials are not configured."
        );
    }

    const client =
        new Client({
            apiId,
            apiHash,
            authString:
                session,
            persistCache:
                false
        });

    await client.start();

    return client;
}

// In-memory peer memo, shared across requests on a warm isolate.
//
// Unlike a Client (which owns a socket and must never be shared), this
// holds only plain data -- a chat object and a BigInt access hash -- so
// Cloudflare's cross-request I/O restriction does not apply. It saves a
// KV read on repeat hits for the same chat; it is not a substitute for
// the KV cache, which is what survives isolate restarts.
const peerMemo = new Map();

async function getCachedChatPeer(
    env,
    chatId
) {
    const memoKey =
        Number(chatId);

    const memoized =
        peerMemo.get(memoKey);

    if (memoized) {
        return memoized;
    }

    if (!env.MTKRUTO_CACHE) {
        return null;
    }

    const storage =
        new CloudflareKVStorage(
            env.MTKRUTO_CACHE
        );

    const cached =
        await storage.get([
            "peers",
            Number(chatId)
        ]);

    if (
        !Array.isArray(cached) ||
        cached.length !== 2 ||
        !cached[0] ||
        cached[1] === null ||
        cached[1] === undefined
    ) {
        return null;
    }

    const resolved = {
        chat:
            cached[0],
        accessHash:
            typeof cached[1] === "bigint"
                ? cached[1]
                : BigInt(cached[1])
    };

    peerMemo.set(
        memoKey,
        resolved
    );

    return resolved;
}

async function cacheChatPeer(
    env,
    chatId,
    peer
) {
    if (!env.MTKRUTO_CACHE) {
        return false;
    }

    const storage =
        new CloudflareKVStorage(
            env.MTKRUTO_CACHE
        );

    const key = [
        "peers",
        Number(chatId)
    ];

    /*
     * Always check KV immediately before writing.
     *
     * This is intentional even if the caller already
     * checked it, because another request/isolate may
     * have populated the entry in the meantime.
     */
    const existing =
        await storage.get(key);

    if (existing !== null) {
        return false;
    }

    try {
        await storage.set(
            key,
            [
                peer[0],
                peer[1]
            ]
        );

        return true;
    } catch (error) {
        /*
         * A KV write quota error must not prevent
         * the Telegram request itself from working.
         */
        console.log(
            "Chat peer KV cache write failed:",
            error?.message ||
                String(error)
        );

        return false;
    }
}

async function prepareChatPeer(
    client,
    env,
    chatId
) {
    const numericId =
        Number(chatId);

    if (!Number.isSafeInteger(numericId)) {
        throw new Error(
            `Invalid chat ID: ${chatId}`
        );
    }

    /*
     * First: try the persistent chat/hash cache.
     */
    const cached =
        await getCachedChatPeer(
            env,
            numericId
        );

    if (cached) {
        client.messageStorage.setPeer2(
            cached.chat,
            cached.accessHash
        );

        return {
            cached: true,
            peer:
                cached
        };
    }

    /*
     * No persistent entry exists.
     *
     * The client (owned by the Durable Object, persisting across many
     * calls) knows no peers yet -- either this is its first-ever call,
     * or it was just rebuilt after a reconnect (persistCache=false, so
     * a rebuilt client starts cold too). For a channel/supergroup it
     * cannot build an inputPeerChannel without the access hash, so
     * calling getChat() directly here fails with PEER_ID_INVALID on a
     * cold cache.
     *
     * Loading the dialog list is how that access hash is legitimately
     * learned -- it populates MTKruto's in-memory peer map as a side
     * effect. This is only reached on a cache MISS, so once this DO's
     * client has resolved a chat, later calls for the SAME chat won't
     * pay this cost again for the client's whole lifetime -- only a
     * genuinely new chat, or a rebuilt client, does.
     */
    try {
        await client.getChats({
            from: "main",
            limit: 100
        });
    } catch (error) {
        console.log(
            "Dialog bootstrap failed:",
            error?.message ||
                String(error)
        );
    }

    /*
     * Ask Telegram for the chat. This causes
     * MTKruto to obtain the peer/access hash.
     */
    const chat =
        await client.getChat(
            numericId
        );

    if (!chat) {
        throw new Error(
            `Chat ${chatId} was not found.`
        );
    }

    /*
     * getChat() should have populated MTKruto's
     * in-memory peer map. Read it back.
     */
    let peer =
        await client.messageStorage.peers.get([
            numericId
        ]);

    /*
     * If the peer wasn't populated by getChat(),
     * explicitly obtain the input peer. This is
     * still only an in-memory operation because
     * persistCache=false.
     */
    if (!peer) {
        await client.getInputPeer(
            numericId
        );

        peer =
            await client.messageStorage.peers.get([
                numericId
            ]);
    }

    if (
        !peer ||
        !Array.isArray(peer) ||
        peer.length !== 2
    ) {
        throw new Error(
            `Could not resolve Telegram peer for chat ${chatId}.`
        );
    }

    /*
     * Check KV again before writing.
     *
     * If another request populated it while we were
     * talking to Telegram, we use that existing value
     * and NEVER issue a put.
     */
    const existing =
        await getCachedChatPeer(
            env,
            numericId
        );

    if (existing) {
        client.messageStorage.setPeer2(
            existing.chat,
            existing.accessHash
        );

        return {
            cached: true,
            peer:
                existing
        };
    }

    /*
     * This is the ONLY place where a new chat
     * peer is written to KV.
     */
    await cacheChatPeer(
        env,
        numericId,
        peer
    );

    /*
     * Memoize in-process too. Later requests on this
     * isolate then short-circuit in getCachedChatPeer,
     * so they issue neither a KV read nor a redundant
     * write-check.
     */
    peerMemo.set(
        numericId,
        {
            chat:
                peer[0],
            accessHash:
                typeof peer[1] === "bigint"
                    ? peer[1]
                    : BigInt(peer[1])
        }
    );

    return {
        cached: false,
        peer
    };
}

async function getChatForId(
    client,
    env,
    chatId
) {
    const numericId =
        Number(chatId);

    if (!Number.isSafeInteger(numericId)) {
        throw new Error(
            `Invalid chat ID: ${chatId}`
        );
    }

    await prepareChatPeer(
        client,
        env,
        numericId
    );

    const chat =
        await client.getChat(
            numericId
        );

    if (!chat) {
        throw new Error(
            `Chat ${chatId} was not found.`
        );
    }

    return chat;
}

async function getMessages(client, env, chatId) {
    const numericId = Number(chatId);

    if (!Number.isSafeInteger(numericId)) {
        throw new Error(`Invalid chat ID: ${chatId}`);
    }

    await prepareChatPeer(client, env, numericId);

    const start = Date.now();
    const messages = await client.getHistory(numericId, { limit: 100 });
    const elapsed = Date.now() - start;

    if (elapsed > SLOW_MS) {
        console.log("slow getHistory:", JSON.stringify({ chatId: numericId, ms: elapsed }));
    }

    return messages;
}

async function getMessage(client, env, chatId, messageId) {
    const numericChatId = Number(chatId);
    const numericMessageId = Number(messageId);

    if (
        !Number.isSafeInteger(numericChatId) ||
        !Number.isSafeInteger(numericMessageId) ||
        numericChatId === 0 ||
        numericMessageId <= 0
    ) {
        throw new Error("Invalid chat or message ID.");
    }

    const started = Date.now();

    await prepareChatPeer(client, env, numericChatId);
    const prepareTime = Date.now() - started;

    const message = await client.getMessage(numericChatId, numericMessageId);
    const total = Date.now() - started;

    if (total > SLOW_MS) {
        console.log("slow getMessage:", JSON.stringify({
            chatId: numericChatId,
            messageId: numericMessageId,
            prepareChatPeer: prepareTime,
            total
        }));
    }

    if (!message) {
        throw new Error(
            `Message ${numericMessageId} was not found in chat ${numericChatId}.`
        );
    }

    return message;
}

function getMessageMedia(message) {
    if (!message) return null;

    switch (message.type) {
        case "photo":
            return message.photo || null;

        case "livePhoto":
            return message.photo || message.video || null;

        case "document":
            return message.document || null;

        case "video":
            return message.video || null;

        case "animation":
            return message.animation || null;

        case "audio":
            return message.audio || null;

        case "voice":
            return message.voice || null;

        case "videoNote":
            return message.videoNote || null;

        case "sticker":
            return message.sticker || null;

        default:
            return null;
    }
}

function getMediaThumbnails(media) {
    if (!media) return [];

    if (Array.isArray(media.thumbnails)) {
        return media.thumbnails;
    }

    if (media.thumbnail) {
        return [media.thumbnail];
    }

    return [];
}

function getMediaMimeType(media, message) {
    if (!media) return "application/octet-stream";

    if (message?.type === "photo") {
        return "image/jpeg";
    }

    if (message?.type === "video") {
        return media.mimeType || "video/mp4";
    }

    if (message?.type === "animation") {
        return media.mimeType || "video/mp4";
    }

    if (message?.type === "audio") {
        return media.mimeType || "audio/mpeg";
    }

    if (message?.type === "voice") {
        return media.mimeType || "audio/ogg";
    }

    if (message?.type === "videoNote") {
        return media.mimeType || "video/mp4";
    }

    if (message?.type === "sticker") {
        return media.mimeType || "image/webp";
    }

    return media.mimeType || "application/octet-stream";
}

function detectImageMimeType(bytes) {
    if (!bytes || bytes.length < 12) {
        return null;
    }

    if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    ) {
        return "image/png";
    }

    if (
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "image/jpeg";
    }

    if (
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38
    ) {
        return "image/gif";
    }

    if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "image/webp";
    }

    return null;
}

function parseRange(rangeHeader, size) {
    if (!rangeHeader) {
        return null;
    }

    if (!Number.isSafeInteger(size) || size <= 0) {
        return null;
    }

    const match =
        /^bytes=(\d*)-(\d*)$/i.exec(
            rangeHeader.trim()
        );

    if (!match) {
        return null;}

    let start;
    let end;

    if (match[1] === "") {
        const suffixLength =
            Number(match[2]);

        if (
            !Number.isSafeInteger(
                suffixLength
            ) ||
            suffixLength <= 0
        ) {
            return null;
        }

        start =
            Math.max(
                0,
                size - suffixLength
            );

        end =
            size - 1;
    } else {
        start =
            Number(match[1]);

        if (
            !Number.isSafeInteger(start) ||
            start < 0 ||
            start >= size
        ) {
            return null;
        }

        if (match[2] === "") {
            end = size - 1;
        } else {
            end =
                Number(match[2]);

            if (
                !Number.isSafeInteger(end) ||
                end < start
            ) {
                return null;
            }

            end =
                Math.min(
                    end,
                    size - 1
                );
        }
    }

    return {
        start,
        end,
        length:
            end - start + 1
    };
}

function parseMultipartFilename(filename) {
    const name = String(filename || "");

    /*
     * Current packager format:
     *
     *   MyVideo.part001.mp4
     *   MyVideo.part002.mp4
     *   MyVideo.part003.mp4
     *
     * Total is not encoded in the filename, so total will be null
     * and getMultipartMediaInfo() will discover all matching parts.
     */
    let match =
        /^(.+)\.part(\d+)\.([^.]+)$/i.exec(name);

    if (match) {
        const part = Number(match[2]);

        if (
            Number.isSafeInteger(part) &&
            part >= 1
        ) {
            return {
                originalName: match[1] + "." + match[3],
                baseName: match[1],
                extension: match[3],
                part,
                total: null
            };
        }
    }

    /*
     * Also continue supporting the older explicit-total formats:
     *
     *   MyVideo.mp4.part001of003
     *   MyVideo.mp4.part001_003
     */
    match =
        /^(.+)\.part(\d+)(?:of|_)(\d+)$/i.exec(name);

    if (match) {
        const part = Number(match[2]);
        const total = Number(match[3]);

        if (
            Number.isSafeInteger(part) &&
            Number.isSafeInteger(total) &&
            part >= 1 &&
            total >= 1 &&
            part <= total
        ) {
            return {
                originalName: match[1],
                baseName: match[1].replace(/\.[^.]+$/, ""),
                extension:
                    match[1].split(".").pop() || "",
                part,
                total
            };
        }
    }

    return null;
}

async function getMessageMediaInfo(
    client,
    env,
    chatId,
    messageId,
    existingMessage = null
) {
    const message =
        existingMessage ||
        await getMessage(
            client,
            env,
            chatId,
            messageId
        );

    const media =
        getMessageMedia(message);

    if (!media) {
        return {
            messageId:
                Number(messageId),
            chatId:
                Number(chatId),
            type:
                message?.type || null,
            media: null
        };
    }

    const thumbnails =
        getMediaThumbnails(media);

    return {
        messageId:
            Number(messageId),
        chatId:
            Number(chatId),
        messageType:
            message.type,
        mediaType:
            media.constructor?.name ||
            null,
        fileId:
            media.fileId ?? null,
        fileUniqueId:
            media.fileUniqueId ?? null,
        fileSize:
            media.fileSize ?? null,
        mimeType:
            getMediaMimeType(
                media,
                message
            ),
        width:
            media.width ?? null,
        height:
            media.height ?? null,
        duration:
            media.duration ?? null,
        fileName:
            media.fileName ?? null,
        thumbnails:
            thumbnails.map(
                item => ({
                    fileId:
                        item.fileId ??
                        null,
                    fileUniqueId:
                        item.fileUniqueId ??
                        null,
                    fileSize:
                        item.fileSize ??
                        null,
                    width:
                        item.width ??
                        null,
                    height:
                        item.height ??
                        null
                })
            )
    };
}


async function getMultipartMediaInfo(
    client,
    env,
    chatId,
    messageId,
    existingMessage = null,
    existingInfo = null
) {
    const numericChatId = Number(chatId);
    const numericMessageId = Number(messageId);

    const targetMessage =
        existingMessage ||
        await getMessage(
            client,
            env,
            numericChatId,
            numericMessageId
        );

    const targetInfo =
        existingInfo ||
        await getMessageMediaInfo(
            client,
            env,
            numericChatId,
            numericMessageId,
            targetMessage
        );

    const multipart =
        parseMultipartFilename(targetInfo.fileName);

    if (!multipart) {
        return null;
    }

    /*
     * All parts are identified by:
     *
     *   baseName + ".partNNN." + extension
     *
     * Example:
     *
     *   MyVideo.part001.mp4
     *   MyVideo.part002.mp4
     *   MyVideo.part003.mp4
     *
     * The packager does not encode the total in the filename, so we
     * discover the complete set from chat history.
     */

    const found = new Map();

    function addMessageInfo(message, info) {
        if (!message || !info?.fileId) {
            return;
        }

        const parsed =
            parseMultipartFilename(info.fileName);

        if (!parsed) {
            return;
        }

        /*
         * The base name and extension must match.
         *
         * This prevents:
         *
         *   OtherVideo.part001.mp4
         *
         * from being accidentally included.
         */
        if (
            parsed.baseName !== multipart.baseName ||
            parsed.extension.toLowerCase() !==
                multipart.extension.toLowerCase()
        ) {
            return;
        }

        found.set(parsed.part, {
            ...info,
            part: parsed.part,
            total: parsed.total
        });
    }

    /*
     * Always include the message that was actually requested.
     */
    addMessageInfo(
        targetMessage,
        targetInfo
    );

    /*
     * Resolve the peer once before the lookups.
     */
    await prepareChatPeer(
        client,
        env,
        numericChatId
    );

    /*
     * First try consecutive message IDs.
     *
     * This is fast because the packager's parts will normally have
     * been uploaded consecutively.
     */
    const firstMessageId =
        numericMessageId -
        (multipart.part - 1);

    /*
     * If the filename explicitly contains the total, we know exactly
     * how many parts to look for.
     *
     * Otherwise, scan forward/backward until the consecutive run ends.
     */
    if (multipart.total !== null) {
        const missing = [];

        for (
            let part = 1;
            part <= multipart.total;
            part++
        ) {
            if (!found.has(part)) {
                missing.push(part);
            }
        }

        await mapLimit(
            missing,
            6,
            async part => {
                const candidateId =
                    firstMessageId +
                    (part - 1);

                if (candidateId <= 0) {
                    return;
                }

                try {
                    const message =
                        await getMessage(
                            client,
                            env,
                            numericChatId,
                            candidateId
                        );

                    const info =
                        await getMessageMediaInfo(
                            client,
                            env,
                            numericChatId,
                            candidateId,
                            message
                        );

                    addMessageInfo(
                        message,
                        info
                    );
                } catch {
                    // History fallback below.
                }
            }
        );
    } else {
        /*
         * Current packager format has no total.
         *
         * Search the recent history. This also means the parts do NOT
         * have to remain consecutive message IDs.
         */
        try {
            const history =
                await client.getHistory(
                    numericChatId,
                    { limit: 100 }
                );

            for (const message of history || []) {
                if (
                    message.id ===
                    numericMessageId
                ) {
                    continue;
                }

                const info =
                    await getMessageMediaInfo(
                        client,
                        env,
                        numericChatId,
                        message.id,
                        message
                    );

                addMessageInfo(
                    message,
                    info
                );
            }
        } catch (error) {
            console.log(
                "Multipart history scan failed:",
                error?.message ||
                    String(error)
            );
        }
    }

    /*
     * We now know the complete set that exists in recent history.
     *
     * If the target was part 2 and parts 1/3 are also present, we have
     * everything necessary to expose one logical video.
     */
    if (found.size === 0) {
        return null;
    }

    /*
     * For the explicit-total format, missing parts are an error.
     */
    if (
        multipart.total !== null &&
        found.size !== multipart.total
    ) {
        throw new Error(
            `Could not find all parts of multipart file ` +
            `"${multipart.originalName}". ` +
            `Found ${found.size} of ${multipart.total}.`
        );
    }

    const parts =
        Array.from(found.values())
            .sort(
                (a, b) =>
                    a.part - b.part
            );

    /*
     * Make sure numbering is contiguous.
     */
    for (
        let index = 0;
        index < parts.length;
        index++
    ) {
        if (
            parts[index].part !==
            index + 1
        ) {
            throw new Error(
                `Multipart file "${multipart.originalName}" ` +
                `is missing part ${index + 1}.`
            );
        }

        if (
            !Number.isSafeInteger(
                Number(parts[index].fileSize)
            ) ||
            Number(parts[index].fileSize) <= 0
        ) {
            throw new Error(
                `Multipart file "${multipart.originalName}" ` +
                `has an invalid size for part ${index + 1}.`
            );
        }
    }

    let totalSize = 0;

    for (const part of parts) {
        totalSize +=
            Number(part.fileSize);

        if (
            !Number.isSafeInteger(
                totalSize
            )
        ) {
            throw new Error(
                `Multipart file "${multipart.originalName}" ` +
                `is too large.`
            );
        }
    }

    return {
        multipart: true,

        originalName:
            multipart.originalName,

        totalParts:
            parts.length,

        fileSize:
            totalSize,

        mimeType:
            parts[0].mimeType ||
            "video/mp4",

        parts
    };
}

// One lookup for everything the /media handler needs (message, media info,
// multipart resolution) so it costs a single RPC and one message fetch.
async function resolveMediaTarget(client, env, chatId, messageId, thumbnail) {
    const message = await getMessage(client, env, chatId, messageId);
    const info = await getMessageMediaInfo(client, env, chatId, messageId, message);

    if (!info.fileId || thumbnail) {
        return { info, multipart: null };
    }

    const multipart = await getMultipartMediaInfo(
        client, env, chatId, messageId, message, info
    );

    return { info, multipart };
}

function contentDispositionInline(filename) {
    const name =
        String(filename || "media");

    // ASCII-only fallback for old clients: replace anything outside
    // printable ASCII, plus quotes and backslashes, with "_".
    const fallback =
        name
            .replace(/[^\x20-\x7e]/g, "_")
            .replace(/["\\]/g, "_");

    // RFC 5987 encoding for the real, Unicode name.
    // encodeURIComponent leaves ! ' ( ) * unescaped, but those are
    // not allowed in an RFC 5987 value, so escape them manually.
    const encoded =
        encodeURIComponent(name)
            .replace(
                /['()*!]/g,
                c =>
                    "%" +
                    c.charCodeAt(0)
                        .toString(16)
                        .toUpperCase()
            );

    return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function createMediaHeaders({
    mimeType,
    size,
    filename,
    start = null,
    end = null,
    etag = null,
    version = null
}) {
    const headers = {
        "Content-Type": mimeType || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": BROWSER_CACHE_CONTROL,
        "Access-Control-Allow-Origin": "*",
        "Content-Disposition": contentDispositionInline(filename)
    };

    if (etag) headers["ETag"] = etag;

    // Debugging aids. If a response in DevTools has NO X-Media-Version, it did
    // not come from this code (it is an older copy held by a cache in front).
    if (version) headers["X-Media-Version"] = String(version);
    headers["X-Media-Source"] = "telegram";

    if (start !== null && end !== null) {
        headers["Content-Length"] = String(end - start + 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    } else {
        headers["Content-Length"] = String(size);
    }

    return headers;
}

// Download a whole (small) file into a single buffer.
//
// This exists specifically so thumbnails can be cached safely. Caching a
// streaming response requires response.clone(), which tees the underlying
// ReadableStream -- and a tee only advances as fast as its SLOWEST reader.
// The cache-write side runs in waitUntil (background, deprioritized), so
// the tee would stall, hold the shared Telegram client's download iterator
// open, and eventually get force-cancelled at the waitUntil deadline. That
// starves every other request queued behind the shared client.
//
// A fully-buffered body has no such coupling: cloning it is an instant
// refcount, both readers are already-resolved data, and nothing holds the
// Telegram connection open. Only use this for genuinely small files.
async function bufferFullDownload(client, fileId, scheduler = telegramScheduler, priority = "high") {
    const queuedAt = Date.now();

    return scheduler.run(async () => {
        const startedAt = Date.now();
        const chunks = [];
        let total = 0;

        const iterator = client.download(fileId, {
            chunkSize: TELEGRAM_CHUNK_SIZE
        });

        try {
            while (true) {
                const result = await iterator.next();
                if (result.done) break;

                chunks.push(result.value);
                total += result.value.length;
            }
        } finally {
            try { await iterator.return?.(); } catch {}
        }

        const finishedAt = Date.now();

        if (finishedAt - queuedAt > SLOW_MS) {
            console.log("slow buffer download:", JSON.stringify({
                fileId: String(fileId),
                bytes: total,
                queueWait: startedAt - queuedAt,
                telegram: finishedAt - startedAt,
                ...telegramScheduler.stats()
            }));
        }

        if (chunks.length === 1) {
            return chunks[0];
        }

        const output = new Uint8Array(total);
        let position = 0;

        for (const chunk of chunks) {
            output.set(chunk, position);
            position += chunk.length;
        }

        return output;
    }, priority, 0, TELEGRAM_BUFFER_TIMEOUT_MS);
}

async function streamFullDownload(client, fileId, onFatalError) {
    const iterator = client.download(fileId, { chunkSize: TELEGRAM_CHUNK_SIZE });
    const startedAt = Date.now();
    let released = false;

    async function release() {
        if (released) return;
        released = true;
        try { await iterator.return?.(); } catch {}
    }

    return new ReadableStream({
        async pull(controller) {
            try {
                const waitStarted = Date.now();
                const result = await iterator.next();
                const waited = Date.now() - waitStarted;

                if (waited > SLOW_MS) {
                    console.log("slow telegram chunk (full download):", JSON.stringify({
                        fileId: String(fileId),
                        ms: waited,
                        elapsed: Date.now() - startedAt
                    }));
                }

                if (result.done) {
                    controller.close();
                    await release();
                    return;
                }

                controller.enqueue(result.value);
            } catch (error) {
                console.log("full download error:", JSON.stringify({
                    fileId: String(fileId),
                    elapsed: Date.now() - startedAt,
                    error: error?.message || String(error)
                }));

                controller.error(error);
                await release();
                onFatalError?.(error);
            }
        },

        async cancel() {
            await release();
        }
    });
}

// Yields exactly the bytes [start, end] (inclusive, relative to this file)
// of one Telegram document: one mtcute download, started at a part-aligned
// offset, cancelled the moment we have what the client asked for.
async function* mtcuteSegmentIterator(mtClient, media, _fileSize, start, end, signal) {
    const alignedFrom =
        Math.floor(start / MTCUTE_PART_BYTES) * MTCUTE_PART_BYTES;

    let skip = start - alignedFrom;
    let remaining = end - start + 1;

    // Per-segment controller so we can stop mtcute early without
    // aborting the caller's (whole-response) signal.
    const local = new AbortController();

    const onAbort = () => {
        try { local.abort(signal.reason); } catch {}
    };

    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    }

    const stream = mtClient.downloadAsStream(media, {
        offset: alignedFrom,
        partSize: MTCUTE_PART_SIZE_KB,
        stallTimeout: MTCUTE_STALL_TIMEOUT_MS,
        abortSignal: local.signal,
        highWaterMark: MTCUTE_HIGH_WATER_MARK
    });

    const reader = stream.getReader();

    try {
        while (remaining > 0) {
            signal?.throwIfAborted?.();

            const result = await reader.read();

            if (result.done) {
                throw new Error(
                    "mtcute stream ended " + remaining + " bytes early."
                );
            }

            let bytes = result.value;

            if (skip) {
                if (bytes.length <= skip) {
                    skip -= bytes.length;
                    continue;
                }

                bytes = bytes.slice(skip);
                skip = 0;
            }

            if (bytes.length > remaining) {
                bytes = bytes.slice(0, remaining);
            }

            remaining -= bytes.length;

            if (bytes.length) yield bytes;
        }
    } finally {
        // Done, errored, or the HTTP client left: stop Telegram traffic now
        // and drop whatever mtcute had buffered.
        signal?.removeEventListener?.("abort", onAbort);

        try { await reader.cancel(); } catch {}
        try { local.abort(new Error("segment finished")); } catch {}
    }
}

// Concatenates segments (one for a normal file, several for a multipart
// file) into one logical byte sequence.
async function* mtcuteRangeIterator(mtClient, segments, signal) {
    for (const seg of segments) {
        yield* mtcuteSegmentIterator(
            mtClient, seg.media, seg.fileSize, seg.start, seg.end, signal
        );
    }
}

async function handleImageViewer(
    request,
    url
) {
    if (
        request.method !== "GET"
    ) {
        return new Response(null, {
            status: 405,
            headers: {
                Allow: "GET"
            }
        });
    }

    const chat =
        url.searchParams.get("chat");

    const message =
        url.searchParams.get("message");

    if (!chat || !message) {
        return new Response(
            "Missing chat or message.",
            {
                status: 400,
                headers: {
                    "Content-Type":
                        "text/plain; charset=utf-8"
                }
            }
        );
    }

    const mediaUrl =
        "/media?chat=" +
        encodeURIComponent(chat) +
        "&message=" +
        encodeURIComponent(message);

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Image</title>
<style>
html, body {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #111;
}

body {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
}

img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
}

#status {
    color: #ccc;
    font-family: sans-serif;
}
</style>
</head>
<body>
<div id="status">Loading image...</div>

<script>
(async () => {
    const status =
        document.getElementById("status");

    const image =
        document.createElement("img");

    image.alt = "";

    image.onload = () => {
        status.remove();
        document.body.appendChild(
            image
        );
    };

    image.onerror = () => {
        status.textContent =
            "Failed to load image.";
    };

    image.src =
        ${JSON.stringify(mediaUrl)};
})();
</script>
</body>
</html>`;

    return new Response(
        html,
        {
            headers: {
                "Content-Type":
                    "text/html; charset=utf-8",
                "Cache-Control":
                    "no-store"
            }
        }
    );
}

// Responses are stored at the edge under a key that includes the file
// version, so they can safely be kept "forever": a changed file never reuses
// the old key. The stored copy and the copy sent to browsers differ in
// Cache-Control, hence the two helpers.
function cacheStore(ctx, cache, key, response) {
    if (!ctx || !cache) return;

    try {
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", CACHE_CONTROL);

        safeCachePut(
            ctx,
            cache,
            key,
            new Response(response.clone().body, {
                status: response.status,
                headers
            })
        );
    } catch {
        // Caching must never break the real response.
    }
}

function browserFresh(cached, etag) {
    const headers = new Headers(cached.headers);

    headers.set("Cache-Control", BROWSER_CACHE_CONTROL);
    headers.set("ETag", etag);
    headers.set("X-Media-Version", etag.replace(/"/g, ""));
    headers.set("X-Media-Source", "edge-cache");

    return new Response(cached.body, { status: cached.status, headers });
}

async function handleDirectMediaRequest(request, env, url, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, {
            status: 405,
            headers: { Allow: "GET, HEAD" }
        });
    }

    const cacheable =
        request.method === "GET" && !request.headers.get("Range");

    const cache = cacheable ? caches.default : null;

    const totalStart = Date.now();
    const timings = {};

    const pathParts = url.pathname.split("/").filter(Boolean);

    let chatId = url.searchParams.get("chat");
    let messageId = url.searchParams.get("message");

    if (pathParts[0] === "media" && pathParts.length >= 3) {
        chatId = decodeURIComponent(pathParts[1]);
        messageId = decodeURIComponent(pathParts[2]);
    }

    const thumbnail =
        url.searchParams.has("thumb") || url.searchParams.has("thumbnail");

    function addTimingHeader(headers) {
        timings.total = Date.now() - totalStart;

        headers["X-Media-Timing"] = Object.entries(timings)
            .map(([key, value]) => `${key}=${value}ms`)
            .join(", ");

        if (timings.total > SLOW_MS) {
            console.log("slow media request:", JSON.stringify({
                chatId,
                messageId,
                thumbnail,
                range: request.headers.get("Range"),
                timings
            }));
        }

        return headers;
    }

    if (!chatId || !messageId) {
        return json({ success: false, error: "Missing chat or message." }, 400);
    }

    const stub = getConnectionStub(env);

    // Single RPC: message lookup + media info + multipart resolution,
    // cached inside the Durable Object.
    //
    // Multipart files are several Telegram documents whose names end in
    // .partNNN_NNN (or .partNofN); a URL for ANY one of them resolves to the whole
    // logical file. Thumbnails stay attached to the individual message.
    const resolveStart = Date.now();
    const resolved = await stub.resolveMedia(chatId, messageId, thumbnail);
    timings.resolve = Date.now() - resolveStart;

    const info = resolved.info;
    const multipartInfo = resolved.multipart;

    if (!info.fileId) {
        return json({
            success: false,
            error: "Message does not contain supported media."
        }, 404);
    }

    let fileId = info.fileId;
    let version = info.fileUniqueId || info.fileId;
    let fileSize = Number(info.fileSize);
    let mimeType = info.mimeType;
    let filename = info.fileName || `telegram-${chatId}-${messageId}`;

    if (multipartInfo) {
        fileSize = multipartInfo.fileSize;
        mimeType = multipartInfo.mimeType || mimeType || "application/octet-stream";
        filename = multipartInfo.originalName;

        version = multipartInfo.parts
            .map(part => part.fileUniqueId || part.fileId)
            .join("-");
    }

    if (thumbnail) {
        if (!info.thumbnails.length) {
            return json({ success: false, error: "Media has no thumbnail." }, 404);
        }

        const selected = info.thumbnails[info.thumbnails.length - 1];

        version = selected.fileUniqueId || selected.fileId;

        fileId = selected.fileId;
        fileSize = Number(selected.fileSize);
        mimeType = "image/jpeg";
        filename += "-thumbnail.jpg";
    }

    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
        return json({
            success: false,
            error: "Media does not contain a downloadable file."
        }, 500);
    }

    // Freshness: the cache key and ETag both carry the current Telegram file
    // id, so a replaced image is a cache miss / ETag mismatch automatically.
    const etag = "\"" + String(version).replace(/[^A-Za-z0-9_.-]/g, "") + "\"";
    const cacheKey = cacheKeyFor(url, version);
    const thumbKey = `t:${Number(chatId)}:${Number(messageId)}:${version}`;
    const mediaHeaders = options => createMediaHeaders({ ...options, etag, version });

    if (cacheable) {
        const ifNoneMatch = request.headers.get("If-None-Match");

        if (
            ifNoneMatch &&
            ifNoneMatch.split(",").some(
                tag => tag.trim().replace(/^W\//, "") === etag
            )
        ) {
            return new Response(null, {
                status: 304,
                headers: {
                    ETag: etag,
                    "Cache-Control": BROWSER_CACHE_CONTROL,
                    "Access-Control-Allow-Origin": "*",
                    "X-Media-Version": etag.replace(/"/g, ""),
                    "X-Media-Source": "304-unchanged"
                }
            });
        }

        if (cache && !multipartInfo) {
            try {
                const cached = await cache.match(cacheKey);
                if (cached) return browserFresh(cached, etag);
            } catch {}
        }
    }

    const rangeHeader = request.headers.get("Range");

    if (rangeHeader) {
        const range = parseRange(rangeHeader, fileSize);

        if (!range) {
            return new Response(null, {
                status: 416,
                headers: {
                    "Content-Range": `bytes */${fileSize}`,
                    "Accept-Ranges": "bytes",
                    "Cache-Control": CACHE_CONTROL,
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }

        // Stream the exact Range the browser requested. There is no artificial
        // 8 MiB boundary; seeking cancels the stream and starts a new Range.
        const effectiveEnd = Math.min(
            range.end,
            range.start + MAX_HTTP_RANGE_SIZE - 1
        );

        const headers = mediaHeaders({
            mimeType,
            size: fileSize,
            filename,
            start: range.start,
            end: effectiveEnd
        });

        if (request.method === "HEAD") {
            addTimingHeader(headers);
            return new Response(null, { status: 206, headers });
        }

        const downloadStart = Date.now();

        const stream = multipartInfo
            ? await stub.downloadMultipartRangeStream(
                chatId, multipartInfo.parts, range.start, effectiveEnd
            )
            : await stub.downloadRangeStream(
                chatId, messageId, fileSize, range.start, effectiveEnd
            );

        timings.streamSetup = Date.now() - downloadStart;
        addTimingHeader(headers);

        return new Response(stream, { status: 206, headers });
    }

    if (request.method === "HEAD") {
        const headers = mediaHeaders({
            mimeType,
            size: fileSize,
            filename
        });

        addTimingHeader(headers);
        return new Response(null, { status: 200, headers });
    }

    const downloadStart = Date.now();

    // Multipart files are never buffered: stream as one logical file.
    if (multipartInfo) {
        const stream = await stub.downloadMultipartRangeStream(
                chatId, multipartInfo.parts, 0, fileSize - 1
        );

        timings.streamSetup = Date.now() - downloadStart;

        const headers = mediaHeaders({ mimeType, size: fileSize, filename });
        addTimingHeader(headers);

        return new Response(stream, { status: 200, headers });
    }

    const bufferable =
        cache && (thumbnail || fileSize <= MAX_BUFFERED_SIZE);

    if (bufferable) {
        const body = await stub.downloadBuffer(
            fileId,
            thumbnail ? thumbKey : null
        );

        timings.download = Date.now() - downloadStart;

        const headers = mediaHeaders({
            mimeType,
            size: body.byteLength,
            filename
        });

        addTimingHeader(headers);

        const response = new Response(body, { status: 200, headers });
        cacheStore(ctx, cache, cacheKey, response);

        return response;
    }

    // Large single-file GET without a Range header: use the parallel
    // read-ahead streamer (same bytes, 200 response) instead of the serial
    // one-chunk-at-a-time iterator.
    const stream = await stub.downloadRangeStream(
        chatId, messageId, fileSize, 0, fileSize - 1
    );

    timings.streamSetup = Date.now() - downloadStart;

    const headers = mediaHeaders({ mimeType, size: fileSize, filename });
    addTimingHeader(headers);

    return new Response(stream, { status: 200, headers });
}

async function handlePieceRequest(
    request,
    env,
    url,
    ctx
) {
    if (
        request.method !== "GET" &&
        request.method !== "HEAD"
    ) {
        return new Response(null, {
            status: 405,
            headers: {
                Allow: "GET, HEAD"
            }
        });
    }

    // Piece URLs are content-addressed (fileId + fileSize + offset +
    // length + mime, always serialized in the same order by fetchPiece),
    // so they're safe to cache at Cloudflare's edge with the Cache API.
    // A cache hit costs essentially no CPU and never touches Telegram --
    // this is what makes repeat views of the same media (reloads, other
    // viewers, retried requests) nearly free.
    const cache = caches.default;

    try {
        const cached =
            await cache.match(request);

        if (cached) {
            return cached;
        }
    } catch {
        // Fall through to a normal fetch if the cache read fails.
    }

    const requestStart =
        Date.now();

    const fileId =
        url.searchParams.get(
            "fileId"
        );

    const fileSize =
        Number(
            url.searchParams.get(
                "fileSize"
            )
        );

    const offset =
        Number(
            url.searchParams.get(
                "offset"
            )
        );

    const length =
        Number(
            url.searchParams.get(
                "length"
            )
        );

    const mimeType =
        url.searchParams.get(
            "mime"
        ) ||
        "application/octet-stream";

    if (!fileId) {
        return json({
            success: false,
            error:
                "Missing fileId."
        }, 400);
    }

    if (
        !Number.isSafeInteger(fileSize) ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        fileSize <= 0 ||
        offset < 0 ||
        length <= 0
    ) {
        return json({
            success: false,
            error:
                "Invalid fileSize, offset, or length."
        }, 400);
    }

    if (
        offset >= fileSize
    ) {
        return new Response(null, {
            status: 416,
            headers: {
                "Content-Range":
                    `bytes */${fileSize}`,
                "Cache-Control":
                    "no-store"
            }
        });
    }

    if (
        offset %
        TELEGRAM_OFFSET_ALIGNMENT !==
        0
    ) {
        return json({
            success: false,
            error:
                `Offset must be divisible by ${TELEGRAM_OFFSET_ALIGNMENT}.`
        }, 400);
    }

    const actualLength =
        Math.min(
            length,
            fileSize - offset
        );

    const end =
        offset +
        actualLength -
        1;

    const headers = {
        "Content-Type":
            mimeType,
        "Content-Length":
            String(actualLength),
        "Cache-Control":
            CACHE_CONTROL,
        "Accept-Ranges":
            "bytes",
        "Access-Control-Allow-Origin":
            "*"
    };

    if (
        request.method === "HEAD"
    ) {
        return new Response(null, {
            status: 200,
            headers
        });
    }

    const stub =
        getConnectionStub(env);

    const downloadStart =
        Date.now();

    const chunks = [];
    let downloaded = 0;
    let currentOffset = offset;

    while (
        downloaded <
        actualLength
    ) {
        const requestLength =
            telegramRequestSize(currentOffset, actualLength - downloaded);

        const bytes =
            await stub.downloadChunk(
                fileId,
                currentOffset,
                requestLength
            );

            if (
                !bytes ||
                bytes.length === 0
            ) {
                throw new Error(
                    "Telegram returned no data at offset " +
                    currentOffset +
                    "."
                );
            }

            const usableLength =
                Math.min(
                    bytes.length,
                    actualLength -
                        downloaded
                );

            chunks.push(
                usableLength ===
                bytes.length
                    ? bytes
                    : bytes.slice(
                        0,
                        usableLength)
            );

            downloaded +=
                usableLength;

            currentOffset +=
                usableLength;

            if (
                usableLength <
                bytes.length
            ) {
                break;
            }
        }

        const downloadTime =
            Date.now() -
            downloadStart;

        const output =
            new Uint8Array(
                downloaded
            );

        let position = 0;

        for (
            const chunk of chunks
        ) {
            output.set(
                chunk,
                position
            );

            position +=
                chunk.length;
        }

        const totalTime =
            Date.now() -
            requestStart;

        headers[
            "Content-Length"
        ] =
            String(output.length);

        headers[
            "X-Piece-Range"
        ] =
            `bytes ${offset}-${offset + output.length - 1}/${fileSize}`;

        headers[
            "X-Timing-Download"
        ] =
            `${downloadTime} ms`;

        headers[
            "X-Timing-Total"
        ] =
            `${totalTime} ms`;

        headers[
            "X-Piece-Offset"
        ] =
            String(offset);

        headers[
            "X-Piece-Bytes"
        ] =
            String(output.length);

    const response =
        new Response(
            output,
            {
                status: 200,
                headers
            }
        );

    if (
        request.method === "GET"
    ) {
        safeCachePut(
            ctx,
            cache,
            request,
            response
        );
    }

    return response;
}

async function testDownload(
    client,
    fileId
) {
    const iterator =
        client.download(
            fileId,
            {
                chunkSize:
                    TELEGRAM_CHUNK_SIZE
            }
        );

    let total = 0;
    let chunks = 0;

    try {
        for await (
            const chunk of iterator
        ) {
            total += chunk.length;
            chunks++;

            if (chunks >= 2) {
                break;
            }
        }
    } finally {
        try {
            await iterator.return?.();
        } catch {}
    }

    return {
        bytes: total,
        chunks
    };
}

async function handleApi(
    request,
    env,
    url
) {
    const path =
        url.pathname;

    // Explicit mtcute health check. This endpoint does not touch any media;
    // it only proves that the Worker can construct and start the mtcute
    // client. Use it before testing a video.
    if (path === "/api/mtcute-test") {
        const start = Date.now();

        try {
            const stub = getConnectionStub(env);
            const result = await stub.testMtcute(url.searchParams.get("step"));

            return json({
                success: result.ok,
                step: url.searchParams.get("step") || "all",
                phases: result.phases,
                elapsedMs: Date.now() - start
            }, result.ok ? 200 : 500);
        } catch (error) {
            return json({
                success: false,
                error: String(error?.message || error),
                name: error?.name || "Error",
                stack: error?.stack || null,
                elapsedMs: Date.now() - start
            }, 500);
        }
    }

    if (path === "/api/chats") {
        const start =
            Date.now();

        const stub =
            getConnectionStub(env);

        const chats =
            await stub.getChats();

        return json({
            success: true,
            timings: {
                total:
                    `${Date.now() - start} ms`
            },
            chats
        });
    }

    if (path === "/api/chat") {
        const chatId =
            url.searchParams.get(
                "chat"
            );

        if (!chatId) {
            return json({
                success: false,
                error: "Missing chat."
            }, 400);
        }

        const start =
            Date.now();

        const stub =
            getConnectionStub(env);

        const chat =
            await stub.getChat(
                chatId
            );

        return json({
            success: true,

            timings: {
                total:
                    `${Date.now() - start} ms`
            },

            chat
        });
    }

    if (path === "/api/messages") {
        const chatId =
            url.searchParams.get(
                "chat"
            );
    
        if (!chatId) {
            return json({
                success: false,
                error: "Missing chat."
            }, 400);
        }
    
        const start =
            Date.now();

        const stub =
            getConnectionStub(env);

        const messages =
            await stub.getMessages(
                chatId
            );

        return json({
            success: true,

            timings: {
                total:
                    `${Date.now() - start} ms`
            },

            chatId:
                Number(chatId),

            messages
        });
    }

    // Batch thumbnails into one request. Fetched with bounded concurrency
    // (the Durable Object interleaves them while awaiting Telegram) rather
    // than one at a time, which was the main cause of timeouts on large
    // batches.
    if (path === "/api/thumbnails") {
        const chatId = url.searchParams.get("chat");
        const messagesParam = url.searchParams.get("messages");

        if (!chatId || !messagesParam) {
            return json({
                success: false,
                error: "Missing chat or messages."
            }, 400);
        }

        const messageIds = messagesParam
            .split(",")
            .map(part => Number(part.trim()))
            .filter(id => Number.isSafeInteger(id) && id > 0);

        const MAX_BATCH = 60;

        if (!messageIds.length) {
            return json({ success: false, error: "No valid message IDs." }, 400);
        }

        if (messageIds.length > MAX_BATCH) {
            return json({
                success: false,
                error: `Too many messages requested (max ${MAX_BATCH}).`
            }, 400);
        }

        const start = Date.now();
        const stub = getConnectionStub(env);
        const thumbnails = {};
        let failures = 0;

        await mapLimit(messageIds, 4, async messageId => {
            try {
                const buffer = await stub.getThumbnailBuffer(chatId, messageId);

                thumbnails[messageId] = buffer
                    ? {
                        mimeType: "image/jpeg",
                        dataUrl:
                            "data:image/jpeg;base64," + bufferToBase64(buffer)
                    }
                    : null;
            } catch (error) {
                failures++;

                console.log(
                    "Batch thumbnail failed:",
                    messageId,
                    error?.message || String(error)
                );

                thumbnails[messageId] = null;
            }
        });

        const elapsed = Date.now() - start;

        if (elapsed > SLOW_MS) {
            console.log("slow thumbnail batch:", JSON.stringify({
                chatId,
                count: messageIds.length,
                failures,
                ms: elapsed
            }));
        }

        return json({
            success: true,
            timings: { total: `${elapsed} ms` },
            thumbnails
        }, 200, {
            // Never let a batch containing failures be cached for a year.
            "Cache-Control": failures ? "no-store" : CACHE_CONTROL
        });
    }

    if (path === "/api/media-info") {
        const chatId =
            url.searchParams.get(
                "chat"
            );

        const messageId =
            url.searchParams.get(
                "message"
            );

        if (!chatId || !messageId) {
            return json({
                success: false,
                error:
                    "Missing chat or message."
            }, 400);
        }

        const stub =
            getConnectionStub(env);

        return json({
            success: true,
            ...(
                await stub.getMediaInfo(
                    chatId,
                    messageId
                )
            )
        });
    }

    if (path === "/api/message") {
        const chatId =
            url.searchParams.get(
                "chat"
            );

        const messageId =
            url.searchParams.get(
                "message"
            );

        if (!chatId || !messageId) {
            return json({
                success: false,
                error:
                    "Missing chat or message."
            }, 400);
        }

        const stub =
            getConnectionStub(env);

        const message =
            await stub.getMessageDetail(
                chatId,
                messageId
            );

        return json({
            success: true,
            message
        });
    }

    if (path === "/api/speedtest") {
        const chatId = url.searchParams.get("chat");
        const messageId = url.searchParams.get("message");

        if (!chatId || !messageId) {
            return json({ success: false, error: "Missing chat or message." }, 400);
        }

        const result = await getConnectionStub(env).runSpeedTest(chatId, messageId);

        if (!result) {
            return json({ success: false, error: "Message has no media." }, 404);
        }

        return json({ success: true, ...result });
    }

    if (path === "/api/sustained") {
        const chatId = url.searchParams.get("chat");
        const messageId = url.searchParams.get("message");

        if (!chatId || !messageId) {
            return json({ success: false, error: "Missing chat or message." }, 400);
        }

        const n = Math.min(200, Math.max(1, Number(url.searchParams.get("n")) || 60));
        const c = Math.min(12, Math.max(1, Number(url.searchParams.get("c")) || 4));
        const mode = url.searchParams.get("mode") === "sched" ? "sched" : "direct";

        const result = await getConnectionStub(env)
            .runSustainedTest(chatId, messageId, n, c, mode);

        if (!result) {
            return json({ success: false, error: "Message has no media." }, 404);
        }

        return json({ success: true, ...result });
    }

    if (path === "/api/paced") {
        const chatId = url.searchParams.get("chat");
        const messageId = url.searchParams.get("message");

        if (!chatId || !messageId) {
            return json({ success: false, error: "Missing chat or message." }, 400);
        }

        const n = Math.min(200, Math.max(1, Number(url.searchParams.get("n")) || 60));
        const rate = Math.min(20, Math.max(0.1, Number(url.searchParams.get("rate")) || 1));

        const result = await getConnectionStub(env).runPacedTest(chatId, messageId, n, rate);

        if (!result) {
            return json({ success: false, error: "Message has no media." }, 404);
        }

        return json({ success: true, ...result });
    }

    if (path === "/api/seektest") {
        const chatId = url.searchParams.get("chat");
        const messageId = url.searchParams.get("message");

        if (!chatId || !messageId) {
            return json({ success: false, error: "Missing chat or message." }, 400);
        }

        const gapParam = url.searchParams.get("gap");
        const gap = gapParam === null ? null : Number(gapParam);

        const result = await getConnectionStub(env).runSeekTest(chatId, messageId, gap);

        if (!result) {
            return json({ success: false, error: "Message has no media." }, 404);
        }

        return json({ success: true, ...result });
    }

    if (path === "/api/multipart") {
        const chatId = url.searchParams.get("chat");
        const messageId = url.searchParams.get("message");

        if (!chatId || !messageId) {
            return json({ success: false, error: "Missing chat or message." }, 400);
        }

        const stub = getConnectionStub(env);
        const info = await stub.getMediaInfo(chatId, messageId);

        let multipart = null;
        let multipartError = null;

        try {
            multipart = await stub.getMultipartMediaInfo(chatId, messageId);
        } catch (error) {
            multipartError = error?.message || String(error);
        }

        return json({
            success: true,
            thisMessage: {
                messageId: info.messageId,
                fileName: info.fileName,
                fileSize: info.fileSize,
                fileUniqueId: info.fileUniqueId,
                mimeType: info.mimeType
            },
            detectedAsMultipart: Boolean(multipart),
            multipartError,
            totalSize: multipart?.fileSize ?? null,
            parts: multipart
                ? multipart.parts.map(part => ({
                    part: part.part,
                    of: part.total,
                    messageId: part.messageId,
                    fileName: part.fileName,
                    fileSize: part.fileSize,
                    fileUniqueId: part.fileUniqueId
                }))
                : null
        });
    }

    if (path === "/api/test-download") {
        const chatId =
            url.searchParams.get(
                "chat"
            );

        const messageId =
            url.searchParams.get(
                "message"
            );

        if (!chatId || !messageId) {
            return json({
                success: false,
                error:
                    "Missing chat or message."
            }, 400);
        }

        const stub =
            getConnectionStub(env);

        const result =
            await stub.runTestDownload(
                chatId,
                messageId
            );

        if (!result) {
            return json({
                success: false,
                error:
                    "Message has no downloadable media."
            }, 404);
        }

        return json({
            success: true,
            ...result
        });
    }

    return json({
        success: false,
        error:
            "Unknown API endpoint."
    }, 404);
}


function renderPage() {
    return new Response(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Media</title>
<style>
* {
    box-sizing: border-box;
}

body {
    margin: 0;
    background: #111;
    color: #eee;
    font-family: Arial, sans-serif;
}

main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px;
}

h1 {
    margin-top: 0;
}

h2 {
    margin-top: 28px;
}

select,
button {
    background: #222;
    color: #eee;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 9px 11px;
    font-size: 14px;
}

select {
    width: 100%;
    margin-bottom: 12px;
}

button {
    cursor: pointer;
}

button:hover {
    background: #2b2b2b;
}

.panel {
    background: #181818;
    border: 1px solid #2c2c2c;
    border-radius: 8px;
    padding: 16px;
    margin-top: 18px;
}

.hidden {
    display: none;
}

pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: #0b0b0b;
    border-radius: 6px;
    padding: 12px;
    overflow: auto;
}

a {
    color: #7db7ff;
}

.media {
    margin-top: 16px;
}

.media img,
.media video {
    max-width: 100%;
    max-height: 75vh;
    display: block;
    background: #000;
}

.media audio {
    width: 100%;
}

.progress {
    margin-top: 10px;
    background: #222;
    border-radius: 5px;
    overflow: hidden;
    height: 8px;
}

.progress-bar {
    height: 100%;
    width: 0%;
    background: #4d9cff;
    transition: width .1s linear;
}

.status {
    margin-top: 8px;
    color: #aaa;
    font-size: 13px;
}

.api-links {
    display: flex;
    flex-direction: column;
    gap: 7px;
}

.message-text {
    white-space: pre-wrap;
    word-break: break-word;
}
</style>
</head>
<body>
<main>
<h1>Telegram Media</h1>

<div class="panel">
<h2>Chat</h2>
<select id="chatSelect">
<option value="">Select a chat...</option>
</select>

<h2>Message</h2>
<select id="messageSelect" disabled>
<option value="">Select a message...</option>
</select>
</div>

<div id="messagePanel" class="panel hidden">
<h2>Message content</h2>
<div id="messageContent"></div>
</div>

<div id="mediaPanel" class="panel hidden">
<h2>Media</h2>
<div id="mediaInfo"></div>
<div id="mediaStatus" class="status"></div>
<div class="progress">
<div id="mediaProgress" class="progress-bar"></div>
</div>
<div id="mediaContainer" class="media"></div>
</div>

<div id="apiPanel" class="panel hidden">
<h2>API / diagnostics</h2>
<div id="apiLinks" class="api-links"></div>
</div>
</main>

<script>
const PIECE_SIZE = ${TELEGRAM_CHUNK_SIZE};
const PIECE_CONCURRENCY = 8;

const chatSelect =
    document.getElementById(
        "chatSelect"
    );

const messageSelect =
    document.getElementById(
        "messageSelect"
    );

const messagePanel =
    document.getElementById(
        "messagePanel"
    );

const messageContent =
    document.getElementById(
        "messageContent"
    );

const mediaPanel =
    document.getElementById(
        "mediaPanel"
    );

const mediaInfo =
    document.getElementById(
        "mediaInfo"
    );

const mediaStatus =
    document.getElementById(
        "mediaStatus"
    );

const mediaProgress =
    document.getElementById(
        "mediaProgress"
    );

const mediaContainer =
    document.getElementById(
        "mediaContainer"
    );

const apiPanel =
    document.getElementById(
        "apiPanel"
    );

const apiLinks =
    document.getElementById(
        "apiLinks"
    );

let chats = [];
let messages = [];
let selectedChatId = null;
let selectedMessageId = null;
let currentObjectUrl = null;
let mediaLoadToken = 0;

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
        return "Unknown";
    }

    if (bytes < 1024) {
        return bytes + " B";
    }

    if (bytes < 1024 ** 2) {
        return (
            (bytes / 1024).toFixed(1) +
            " KB"
        );
    }

    if (bytes < 1024 ** 3) {
        return (
            (bytes / 1024 ** 2).toFixed(2) +
            " MB"
        );
    }

    return (
        (bytes / 1024 ** 3).toFixed(2) +
        " GB"
    );
}

function formatDate(value) {
    if (!value) {
        return "";
    }

    try {
        return new Date(
            value
        ).toLocaleString();
    } catch {
        return String(value);
    }
}

async function api(url) {
    const response =
        await fetch(url);

    const text =
        await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(
            "HTTP " +
            response.status +
            ": " +
            text
        );
    }

    if (
        !response.ok ||
        data.success === false
    ) {
        throw new Error(
            data.error ||
            ("HTTP " +
                response.status)
        );
    }

    return data;
}

function invalidateMediaLoad() {
    mediaLoadToken++;

    if (currentObjectUrl) {
        URL.revokeObjectURL(
            currentObjectUrl
        );

        currentObjectUrl = null;
    }

    mediaContainer.innerHTML = "";
    mediaInfo.innerHTML = "";
    mediaStatus.textContent = "";
    mediaProgress.style.width = "0%";
    mediaPanel.classList.add("hidden");
}

function clearMessage() {
    selectedMessageId = null;

    messagePanel.classList.add(
        "hidden"
    );

    messageContent.innerHTML = "";

    apiPanel.classList.add(
        "hidden"
    );

    apiLinks.innerHTML = "";

    invalidateMediaLoad();
}

function addLink(label, url) {
    const a =
        document.createElement("a");

    a.href = url;
    a.textContent = label;
    a.target = "_blank";
    a.rel = "noopener";

    apiLinks.appendChild(a);
}

async function loadChats() {
    const data =
        await api("/api/chats");

    chats =
        data.chats || [];

    chatSelect.innerHTML =
        '<option value="">Select a chat...</option>';

    for (const chat of chats) {
        const option =
            document.createElement(
                "option"
            );

        option.value =
            String(chat.id);

        const name =
            chat.title ||
            [
                chat.firstName,
                chat.lastName
            ]
                .filter(Boolean)
                .join(" ") ||
            chat.username ||
            String(chat.id);

        option.textContent =
            name +
            " (" +
            chat.id +
            ")";

        chatSelect.appendChild(
            option
        );
    }

    if (data.timings) {
        apiPanel.classList.remove(
            "hidden"
        );

        apiLinks.innerHTML =
            "<pre>" +
            escapeHtml(
                Object.entries(
                    data.timings
                )
                    .map(
                        ([key, value]) =>
                            key +
                            ": " +
                            value
                    )
                    .join("\\n")
            ) +
            "</pre>";
    }
}

async function loadMessages(chatId) {
    const data =
        await api(
            "/api/messages?chat=" +
            encodeURIComponent(
                chatId
            )
        );

    messages =
        data.messages || [];

    messageSelect.innerHTML =
        '<option value="">Select a message...</option>';

    for (const message of messages) {
        const option =
            document.createElement(
                "option"
            );

        option.value =
            String(message.id);

        const text =
            message.text ||
            message.caption ||
            "";

        const preview =
            text
                .replace(/\\s+/g, " ")
                .slice(0, 80);

        const mediaMarker =
            message.hasMedia
                ? " [media]"
                : "";

        option.textContent =
            "#" +
            message.id +
            " - " +
            (
                message.type ||
                "message"
            ) +
            mediaMarker +
            (
                preview
                    ? " - " +
                      preview
                    : ""
            );

        messageSelect.appendChild(
            option
        );
    }

    messageSelect.disabled =
        false;

    if (data.timings) {
        apiPanel.classList.remove(
            "hidden"
        );

        apiLinks.innerHTML =
            "<pre>" +
            escapeHtml(
                Object.entries(
                    data.timings
                )
                    .map(
                        ([key, value]) =>
                            key +
                            ": " +
                            value
                    )
                    .join("\\n")
            ) +
            "</pre>";}
}

async function fetchPiece(
    fileId,
    fileSize,
    mimeType,
    offset,
    length
) {
    const params =
        new URLSearchParams({
            fileId,
            fileSize:
                String(fileSize),
            mime:
                mimeType || "",
            offset:
                String(offset),
            length:
                String(length)
        });

    const start =
        performance.now();

    const response =
        await fetch(
            "/piece?" +
            params.toString(),
            {
                cache:
                    "force-cache"
            }
        );

    if (!response.ok) {
        let errorText = "";

        try {
            const data =
                await response.json();

            errorText =
                data.error || "";
        } catch {}

        throw new Error(
            "Piece " +
            offset +
            " failed: HTTP " +
            response.status +
            (
                errorText
                    ? " - " +
                      errorText
                    : ""
            )
        );
    }

    const buffer =
        await response.arrayBuffer();

    const browserTime =
        Math.round(
            performance.now() -
            start
        );

    const createClientTime =
        response.headers.get(
            "X-Timing-Create-Client"
        ) ||
        "unknown";

    const downloadTime =
        response.headers.get(
            "X-Timing-Download"
        ) ||
        "unknown";

    const serverTotal =
        response.headers.get(
            "X-Timing-Total"
        ) ||
        "unknown";

    const pieceOffset =
        response.headers.get(
            "X-Piece-Offset"
        ) ||
        String(offset);

    const pieceBytes =
        response.headers.get(
            "X-Piece-Bytes"
        ) ||
        String(buffer.byteLength);

    const timing =
        document.createElement(
            "div"
        );

    timing.className =
        "piece-timing";

    timing.textContent =
        "Piece " +
        pieceOffset +
        " (" +
        formatBytes(
            Number(pieceBytes)
        ) +
        "): " +
        "createClient " +
        createClientTime +
        ", download " +
        downloadTime +
        ", server total " +
        serverTotal +
        ", browser total " +
        browserTime +
        " ms";

    apiPanel.classList.remove(
        "hidden"
    );

    apiLinks.appendChild(
        timing
    );

    return buffer;
}

async function fetchImageParts(
    fileId,
    fileSize,
    mimeType,
    token
) {
    // Each "part" is now a single PIECE_SIZE-aligned chunk (same size the
    // Worker's /piece handler fetches from Telegram in one downloadChunk
    // call). Previously this split the file into only 5 large parts, which
    // forced handlePieceRequest to loop over many downloadChunk/decrypt
    // calls inside a single Worker invocation -- accumulating CPU time
    // against one request's cap instead of spreading it across many cheap
    // requests. Concurrency (not part size) is what should scale with
    // image size.
    const partCount =
        Math.max(
            1,
            Math.ceil(
                fileSize /
                PIECE_SIZE
            )
        );

    const parts =
        new Array(partCount);

    let nextIndex = 0;
    let completed = 0;
    let completedBytes = 0;

    async function worker() {
        while (true) {
            const index =
                nextIndex++;

            if (
                index >= partCount
            ) {
                return;
            }

            if (
                token !==
                mediaLoadToken
            ) {
                throw new Error(
                    "Media load cancelled."
                );
            }

            const start =
                index *
                PIECE_SIZE;

            const length =
                Math.min(
                    PIECE_SIZE,
                    fileSize -
                    start
                );

            const buffer =
                await fetchPiece(
                    fileId,
                    fileSize,
                    mimeType,
                    start,
                    length
                );

            if (
                token !==
                mediaLoadToken
            ) {
                throw new Error(
                    "Media load cancelled."
                );
            }

            parts[index] =
                buffer;

            completed++;
            completedBytes +=
                buffer.byteLength;

            mediaProgress.style.width =
                (
                    completedBytes /
                    fileSize *
                    100
                ) +
                "%";

            mediaStatus.textContent =
                "Downloaded " +
                formatBytes(
                    completedBytes
                ) +
                " / " +
                formatBytes(
                    fileSize
                ) +
                " (" +
                completed +
                " / " +
                partCount +
                " parts)";
        }
    }

    const workerCount =
        Math.min(
            PIECE_CONCURRENCY,
            partCount
        );

    await Promise.all(
        Array.from(
            {
                length:
                    workerCount
            },
            () => worker()
        )
    );

    return parts;
}

async function fetchMediaPieces(
    fileId,
    fileSize,
    mimeType,
    token
) {
    const pieceCount =
        Math.max(
            1,
            Math.ceil(
                fileSize /
                PIECE_SIZE
            )
        );

    const pieces =
        new Array(pieceCount);

    let completed = 0;
    let completedBytes = 0;
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const index =
                nextIndex++;

            if (
                index >= pieceCount
            ) {
                return;
            }

            if (
                token !==
                mediaLoadToken
            ) {
                throw new Error(
                    "Media load cancelled."
                );
            }

            const offset =
                index *
                PIECE_SIZE;

            const length =
                Math.min(
                    PIECE_SIZE,
                    fileSize -
                    offset
                );

            const buffer =
                await fetchPiece(
                    fileId,
                    fileSize,
                    mimeType,
                    offset,
                    length
                );

            if (
                token !==
                mediaLoadToken
            ) {
                throw new Error(
                    "Media load cancelled."
                );
            }

            pieces[index] =
                buffer;

            completed++;
            completedBytes +=
                buffer.byteLength;

            mediaProgress.style.width =
                (
                    completedBytes /
                    fileSize *
                    100
                ) +
                "%";

            mediaStatus.textContent =
                "Downloaded " +
                formatBytes(
                    completedBytes
                ) +
                " / " +
                formatBytes(
                    fileSize
                ) +
                " (" +
                completed +
                " / " +
                pieceCount +
                " pieces)";
        }
    }

    const workerCount =
        Math.min(
            PIECE_CONCURRENCY,
            pieceCount
        );

    await Promise.all(
        Array.from(
            {
                length:
                    workerCount
            },
            () => worker()
        )
    );

    return pieces;
}

function combinePieces(
    pieces,
    mimeType
) {
    return new Blob(
        pieces.map(
            piece =>
                new Uint8Array(
                    piece
                )
        ),
        {
            type:
                mimeType ||
                "application/octet-stream"
        }
    );
}

async function loadMedia(
    chatId,
    messageId
) {
    const token =
        ++mediaLoadToken;

    if (currentObjectUrl) {
        URL.revokeObjectURL(
            currentObjectUrl
        );

        currentObjectUrl = null;
    }

    mediaContainer.innerHTML = "";
    mediaInfo.innerHTML = "";
    mediaStatus.textContent = "";
    mediaProgress.style.width = "0%";

    mediaPanel.classList.remove(
        "hidden"
    );

    try {
        mediaStatus.textContent =
            "Getting media information...";

        const info =
            await api(
                "/api/media-info?chat=" +
                encodeURIComponent(chatId) +
                "&message=" +
                encodeURIComponent(messageId)
            );

        if (
            token !==
            mediaLoadToken
        ) {
            return;
        }

        if (
            !info.success ||
            !info.fileId
        ) {
            mediaInfo.textContent =
                "This message has no supported media.";

            mediaStatus.textContent = "";
            return;
        }

        const size =
            Number(info.fileSize);

        const mime =
            info.mimeType || "";

        mediaInfo.innerHTML =
            "<div><b>Type:</b> " +
            escapeHtml(
                info.messageType
            ) +
            "</div>" +
            "<div><b>Size:</b> " +
            escapeHtml(
                formatBytes(size)
            ) +
            "</div>" +
            "<div><b>MIME:</b> " +
            escapeHtml(mime) +
            "</div>" +
            (
                info.width &&
                info.height
                    ? "<div><b>Dimensions:</b> " +
                      escapeHtml(
                          info.width +
                          " × " +
                          info.height
                      ) +
                      "</div>"
                    : ""
            );

        if (
            !Number.isSafeInteger(size) ||
            size <= 0
        ) {
            throw new Error(
                "Invalid media size."
            );
        }

        if (!mime) {
            throw new Error(
                "Media MIME type is missing."
            );
        }

        if (
            mime.startsWith("image/")
        ) {
            const parts =
                await fetchImageParts(
                    info.fileId,
                    size,
                    mime,
                    token
                );

            if (
                token !==
                mediaLoadToken
            ) {
                return;
            }

            const blob =
                new Blob(
                    parts,
                    {
                        type: mime
                    }
                );

            currentObjectUrl =
                URL.createObjectURL(
                    blob
                );

            const img =
                document.createElement(
                    "img"
                );

            img.src =
                currentObjectUrl;

            img.alt = "";

            mediaContainer.appendChild(
                img
            );

            mediaStatus.textContent =
                "Image loaded.";

            return;
        }

        if (
            mime.startsWith("video/") ||
            mime.startsWith("audio/")
        ) {
            // Let the browser's media stack drive HTTP Range requests directly.
            // The /media endpoint maps each logical range to the correct
            // Telegram part and streams only that byte window.  Do not build a
            // multi-gigabyte Blob here: doing so defeats seeking and forces the
            // entire multipart file through the browser before playback.
            const mediaUrl =
                "/media?chat=" +
                encodeURIComponent(chatId) +
                "&message=" +
                encodeURIComponent(messageId);

            if (
                token !==
                mediaLoadToken
            ) {
                return;
            }

            if (
                mime.startsWith("video/")
            ) {
                const video =
                    document.createElement(
                        "video"
                    );

                video.controls = true;
                video.preload = "metadata";
                video.src = mediaUrl;

                mediaContainer.appendChild(
                    video
                );

                mediaStatus.textContent =
                    "Video ready for streaming.";
            } else {
                const audio =
                    document.createElement(
                        "audio"
                    );

                audio.controls = true;
                audio.preload = "metadata";
                audio.src = mediaUrl;

                mediaContainer.appendChild(
                    audio
                );

                mediaStatus.textContent =
                    "Audio ready for streaming.";
            }
        } else {
            const pieces =
                await fetchMediaPieces(
                    info.fileId,
                    size,
                    mime,
                    token
                );

            if (
                token !==
                mediaLoadToken
            ) {
                return;
            }

            const blob =
                new Blob(
                    pieces,
                    {
                        type: mime
                    }
                );

            currentObjectUrl =
                URL.createObjectURL(
                    blob
                );

            const link =
                document.createElement(
                    "a"
                );

            link.href =
                currentObjectUrl;

            link.textContent =
                "Open downloaded file";

            link.target =
                "_blank";

            link.rel =
                "noopener";

            mediaContainer.appendChild(
                link
            );

            mediaStatus.textContent =
                "File loaded.";
        }
    } catch (error) {
        if (
            token !==
            mediaLoadToken
        ) {
            return;
        }

        mediaStatus.textContent =
            "Media error: " +
            (
                error?.message ||
                String(error)
            );
    }
}

async function selectMessage(
    messageId
) {
    clearMessage();

    if (!messageId) {
        return;
    }

    selectedMessageId =
        Number(messageId);

    messagePanel.classList.remove(
        "hidden"
    );

    const message =
        messages.find(
            item =>
                Number(item.id) ===
                selectedMessageId
        );

    if (!message) {
        messageContent.textContent =
            "Message not found.";

        return;
    }

    const text =
        message.text ||
        message.caption ||
        "";

    messageContent.innerHTML =
        "<div><b>ID:</b> " +
        escapeHtml(
            message.id
        ) +
        "</div>" +
        "<div><b>Date:</b> " +
        escapeHtml(
            formatDate(
                message.date
            )
        ) +
        "</div>" +
        "<div><b>Type:</b> " +
        escapeHtml(
            message.type || ""
        ) +
        "</div>" +
        (
            text
                ? "<h3>Text</h3><div class='message-text'>" +
                  escapeHtml(
                      text
                  ) +
                  "</div>"
                : "<div>No text content.</div>"
        );

    apiPanel.classList.remove(
        "hidden"
    );

    apiLinks.innerHTML = "";

    addLink(
        "Messages API",
        "/api/messages?chat=" +
        encodeURIComponent(
            selectedChatId
        )
    );

    addLink(
        "Chat API",
        "/api/chat?chat=" +
        encodeURIComponent(
            selectedChatId
        )
    );

    addLink(
        "Message API",
        "/api/message?chat=" +
        encodeURIComponent(
            selectedChatId
        ) +
        "&message=" +
        encodeURIComponent(
            selectedMessageId
        )
    );

    addLink(
        "Media info",
        "/api/media-info?chat=" +
        encodeURIComponent(
            selectedChatId
        ) +
        "&message=" +
        encodeURIComponent(
            selectedMessageId
        )
    );

    addLink(
        "Direct media URL",
        "/media/" +
        encodeURIComponent(
            selectedChatId
        ) +
        "/" +
        encodeURIComponent(
            selectedMessageId
        )
    );

    addLink(
        "Direct thumbnail URL",
        "/media/" +
        encodeURIComponent(
            selectedChatId
        ) +
        "/" +
        encodeURIComponent(
            selectedMessageId
        ) +
        "?thumb=1"
    );

    addLink(
        "Full download test",
        "/api/test-download?chat=" +
        encodeURIComponent(
            selectedChatId
        ) +
        "&message=" +
        encodeURIComponent(
            selectedMessageId
        )
    );
    /*
    await loadMedia(
        selectedChatId,
        selectedMessageId
    );
    */
}

chatSelect.addEventListener(
    "change",
    async () => {
        selectedChatId =
            chatSelect.value ||
            null;

        clearMessage();

        messageSelect.innerHTML =
            '<option value="">Select a message...</option>';

        messageSelect.disabled =
            true;

        if (!selectedChatId) {
            return;
        }

        try {
            await loadMessages(
                selectedChatId
            );
        } catch (error) {
            messageContent.textContent =
                error.message;

            messagePanel.classList.remove(
                "hidden"
            );
        }
    }
);

messageSelect.addEventListener(
    "change",
    async () => {
        try {
            await selectMessage(
                messageSelect.value
            );
        } catch (error) {
            messagePanel.classList.remove(
                "hidden"
            );

            messageContent.textContent =
                error.message;
        }
    }
);

loadChats().catch(
    error => {
        chatSelect.innerHTML =
            '<option value="">Error loading chats</option>';

        messageContent.textContent =
            error.message;

        messagePanel.classList.remove(
            "hidden"
        );
    }
);
</script>
</body>
</html>`, {
        headers: {
            "Content-Type":
                "text/html; charset=utf-8",
            "Cache-Control":
                "no-store"
        }
    });
}

function looksLikeConnectionError(error) {
    const message =
        String(
            error?.message ||
            error ||
            ""
        ).toLowerCase();

    return (
        message.includes("disconnect") ||
        message.includes("connection") ||
        message.includes("closed") ||
        message.includes("socket") ||
        message.includes("timeout") ||
        message.includes("network") ||
        message.includes("stall")
    );
}

// The one persistent Telegram client.
//
// A Durable Object instance processes its own invocations sequentially,
// which is why it's exempt from the restriction that broke an earlier
// attempt to share a client via a module-scope variable in the plain
// Worker: Cloudflare Workers forbids using an I/O object (a socket, a
// stream, etc) created during one request from a different request's
// handler ("Cannot perform I/O on behalf of a different request..."),
// but that restriction is about isolate-shared globals across
// concurrent, independent requests -- not about a DO's own sequential
// access to its own state. Holding a live connection across calls here
// is the same sanctioned pattern hibernatable WebSockets and persistent
// DB connections use.
//
// Every public method here becomes an RPC method callable from the
// Worker via a DurableObjectStub. RPC return values must be structured-
// cloneable (plus bigint/Date/ArrayBuffer/typed-arrays/Error/Blob/
// ReadableStream -- see Cloudflare's RPC docs), and MTKruto's `message`/
// `chat`/`media` objects are class instances, not plain objects (note
// `media.constructor?.name` elsewhere in this file), so none of those
// raw objects are returned directly. Every method here maps its result
// into a plain, JSON-shaped object first -- the same shapes this file
// already built for its JSON API responses -- before returning it.
// `downloadStream`/`downloadRangeStream` are the one exception: they
// return a ReadableStream directly, which RPC explicitly supports with
// automatic flow control (including cancellation propagating back to
// this side when the Worker's response stream is cancelled).
export class TelegramConnectionDO extends DurableObject {
    #client = null;
    #clientPromise = null;
    #mtClient = null;
    #mtClientPromise = null;

    #activeMultipartDownloads =
        new Map();

    #nextMultipartDownloadId = 1;

    #bufferInflight = new Map();
    #sqlReady = false;
    #thumbPuts = 0;
    #telegramCooldownUntil = 0;
    #lastFloodWaitEvent = null;

    constructor(ctx, env) {
        super(ctx, env);

        // Thumbnails are tiny and effectively immutable, so persist them in
        // this Durable Object's SQLite storage. After the first successful
        // download a thumbnail never needs Telegram again, even across
        // Worker isolates, edge locations and Durable Object restarts.
        try {
            ctx.storage.sql.exec(
                "CREATE TABLE IF NOT EXISTS thumb_cache (" +
                "k TEXT PRIMARY KEY, data BLOB NOT NULL, ts INTEGER NOT NULL)"
            );

            ctx.storage.sql.exec(
                "CREATE TABLE IF NOT EXISTS stream_guard (k TEXT PRIMARY KEY, v INTEGER NOT NULL)"
            );
            const guardRows = ctx.storage.sql
                .exec("SELECT v FROM stream_guard WHERE k = ?", "telegram_cooldown_until")
                .toArray();
            this.#telegramCooldownUntil = guardRows.length ? Number(guardRows[0].v) || 0 : 0;
            this.#sqlReady = true;
        } catch (error) {
            console.log(
                "thumbnail cache unavailable:",
                error?.message || String(error)
            );
        }
    }

    #thumbGet(key) {
        if (!this.#sqlReady || !key) return null;

        try {
            const rows = this.ctx.storage.sql
                .exec("SELECT data, ts FROM thumb_cache WHERE k = ?", key)
                .toArray();

            if (!rows.length || !rows[0].data) return null;

            // Versioned keys (t:chat:msg:fileUniqueId) can't go stale; the
            // un-versioned batch-API keys (t:chat:msg) can, so they expire.
            const versioned = String(key).split(":").length > 3;

            if (!versioned && Date.now() - Number(rows[0].ts) > THUMB_CACHE_TTL_MS) {
                return null;
            }

            return new Uint8Array(rows[0].data);
        } catch {
            return null;
        }
    }

    #thumbPut(key, bytes) {
        if (!this.#sqlReady || !key || !bytes) return;
        if (bytes.byteLength === 0 || bytes.byteLength > THUMB_CACHE_MAX_BYTES) return;

        try {
            const buffer = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
            );

            this.ctx.storage.sql.exec(
                "INSERT OR REPLACE INTO thumb_cache (k, data, ts) VALUES (?, ?, ?)",
                key,
                buffer,
                Date.now()
            );

            if (++this.#thumbPuts % 25 === 0) {
                this.ctx.storage.sql.exec(
                    "DELETE FROM thumb_cache WHERE k IN (" +
                    "SELECT k FROM thumb_cache ORDER BY ts DESC " +
                    "LIMIT -1 OFFSET ?)",
                    THUMB_CACHE_MAX_ROWS
                );
            }
        } catch (error) {
            console.log(
                "thumbnail cache write failed:",
                error?.message || String(error)
            );
        }
    }

    // Share one download between identical concurrent requests and fill the
    // persistent cache when a cacheKey is given.
    async #bufferOnce(inflightKey, cacheKey, load) {
        const cached = this.#thumbGet(cacheKey);
        if (cached) return cached;

        let pending = this.#bufferInflight.get(inflightKey);

        if (!pending) {
            pending = load()
                .then(bytes => {
                    if (bytes && cacheKey) this.#thumbPut(cacheKey, bytes);
                    return bytes;
                })
                .finally(() => {
                    this.#bufferInflight.delete(inflightKey);
                });

            this.#bufferInflight.set(inflightKey, pending);
        }

        return pending;
    }

    getCachedThumbnail(key) {
        return this.#thumbGet(key);
    }

    #mediaCache = new Map();
    #mediaInflight = new Map();

    #registerMultipartDownload(cancel) {
        const id = this.#nextMultipartDownloadId++;

        while (
            this.#activeMultipartDownloads.size >=
            MAX_ACTIVE_MULTIPART_DOWNLOADS
        ) {
            const oldest =
                this.#activeMultipartDownloads.entries().next().value;

            if (!oldest) break;

            const [oldestId, oldestCancel] = oldest;
            this.#activeMultipartDownloads.delete(oldestId);

            try {
                oldestCancel("Replaced by a newer multipart download.");
            } catch {}
        }

        this.#activeMultipartDownloads.set(id, cancel);

        return () => {
            this.#activeMultipartDownloads.delete(id);
        };
    }

    async #ensureClient() {
        if (!this.#clientPromise) {
            this.#clientPromise =
                createClient(this.env)
                    .then(client => {
                        this.#client = client;
                        return client;
                    })
                    .catch(error => {
                        this.#clientPromise = null;
                        this.#client = null;
                        throw error;
                    });
        }

        return this.#clientPromise;
    }

    async #ensureMtcuteClient() {
        if (!this.#mtClientPromise) {
            this.#mtClientPromise = createMtcuteClient(this.env).then(client => { this.#mtClient = client; return client; }).catch(error => { this.#mtClientPromise = null; this.#mtClient = null; throw error; });
        }
        return this.#mtClientPromise;
    }

    // Discard helpers. These only affect the NEXT caller; they can't undo
    // the failure the current caller already sees. The old client is
    // closed so its sockets don't leak inside the long-lived DO.
    #discardMtkrutoClient(error) {
        if (!looksLikeConnectionError(error)) return;

        const old = this.#client;
        this.#client = null;
        this.#clientPromise = null;

        try {
            Promise.resolve(old?.disconnect?.()).catch(() => {});
        } catch {}
    }

    #discardMtcuteClient(error) {
        if (!looksLikeConnectionError(error)) return;

        const old = this.#mtClient;
        this.#mtClient = null;
        this.#mtClientPromise = null;
        this.#mtMediaCache.clear();

        try {
            Promise.resolve(old?.destroy?.()).catch(() => {});
        } catch {}
    }

    async #withClient(fn) {
        const client =
            await this.#ensureClient();

        try {
            return await fn(client);
        } catch (error) {
            this.#discardMtkrutoClient(error);

            throw error;
        }
    }

    // ---- mtcute media resolution ---------------------------------------
    // The video path is mtcute-only. MTKruto message/media objects are not
    // understood by mtcute, so the media object that mtcute downloads is
    // always fetched with mtcute itself and cached here, which means a
    // seek (a brand new Range request) costs no Telegram lookup at all.
    #mtMediaCache = new Map();
    #mtBootstrapPromise = null;
    #mtBootstrapAt = 0;

    // A cold mtcute client (fresh isolate, or rebuilt after an error) knows
    // no access hashes, so getMessages() on a channel/supergroup fails with
    // a peer error. Loading the dialog list teaches it the peers.
    async #mtBootstrapPeers(mt) {
        if (Date.now() - this.#mtBootstrapAt < 30000) return false;

        if (!this.#mtBootstrapPromise) {
            this.#mtBootstrapPromise = (async () => {
                let seen = 0;

                for await (const _dialog of mt.iterDialogs({ limit: 200 })) {
                    if (++seen >= 200) break;
                }
            })()
                .catch(error => {
                    console.log(
                        "mtcute dialog bootstrap failed:",
                        error?.message || String(error)
                    );
                })
                .finally(() => {
                    this.#mtBootstrapAt = Date.now();
                    this.#mtBootstrapPromise = null;
                });
        }

        await this.#mtBootstrapPromise;
        return true;
    }

    // Returns one mtcute media object per requested message id (same order).
    async #mtResolveMedia(chatId, messageIds) {
        const mt = await this.#ensureMtcuteClient();
        const cid = Number(chatId);
        const now = Date.now();
        const result = new Array(messageIds.length);
        const missing = [];

        messageIds.forEach((id, index) => {
            const hit = this.#mtMediaCache.get(cid + ":" + Number(id));

            if (hit && hit.expires > now) {
                result[index] = hit.media;
            } else {
                missing.push(index);
            }
        });

        if (!missing.length) return result;

        const ids = [...new Set(missing.map(i => Number(messageIds[i])))];
        const load = () => mt.getMessages(cid, ids);

        let messages;

        try {
            messages = await load();
        } catch (error) {
            if (looksLikeConnectionError(error)) {
                this.#discardMtcuteClient(error);
                throw error;
            }

            if (!(await this.#mtBootstrapPeers(mt))) throw error;

            messages = await load();
        }

        const byId = new Map();
        ids.forEach((id, i) => {
            if (messages?.[i]) byId.set(id, messages[i]);
        });

        for (const index of missing) {
            const id = Number(messageIds[index]);
            const media = byId.get(id)?.media;

            if (!media) {
                throw new Error(
                    "mtcute found no downloadable media in message " +
                    id + " of chat " + cid + "."
                );
            }

            if (this.#mtMediaCache.size >= MEDIA_CACHE_MAX) {
                this.#mtMediaCache.delete(
                    this.#mtMediaCache.keys().next().value
                );
            }

            this.#mtMediaCache.set(cid + ":" + id, {
                media,
                expires: Date.now() + MEDIA_CACHE_TTL_MS
            });

            result[index] = media;
        }

        return result;
    }

    // Wraps the segment iterator in an HTTP-facing ReadableStream.
    // pull() is only called when the consumer has room, so the browser
    // (via the RPC stream's flow control) paces Telegram. cancel() -- which
    // is what a seek or closed tab triggers -- aborts mtcute immediately.
    #openMtcuteStream(mtClient, segments, cacheKeys) {
        const abort = new AbortController();
        const iterator = mtcuteRangeIterator(mtClient, segments, abort.signal);
        let unregister = null;
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;

            try { unregister?.(); } catch {}
        };

        unregister = this.#registerMultipartDownload(reason => {
            try {
                abort.abort(new Error(String(reason || "Replaced by a newer stream.")));
            } catch {}
        });

        return new ReadableStream({
            pull: async controller => {
                try {
                    // Do not delay each pull: every pull corresponds to useful
                    // downstream demand. A seek/disconnect aborts this iterator,
                    // while the Durable Object keeps the MTProto client alive.
                    if (abort.signal.aborted) {
                        finish();
                        try { controller.close(); } catch {}
                        return;
                    }
                    const result = await iterator.next();

                    if (result.done) {
                        finish();
                        controller.close();
                        return;
                    }

                    controller.enqueue(result.value);
                } catch (error) {
                    finish();

                    if (abort.signal.aborted) {
                        // Seek / disconnect / replaced: not a failure.
                        try { controller.close(); } catch {}
                        return;
                    }

                    const message = String(error?.message || error || "");
                    let floodEvent = this.#recordFloodWait(error);
                    if (!floodEvent && message.startsWith(TG_DIAGNOSTIC_PREFIX)) {
                        try {
                            const existing = JSON.parse(message.slice(TG_DIAGNOSTIC_PREFIX.length));
                            if (existing.event === "telegram_cooldown_active") floodEvent = existing;
                        } catch {}
                    }
                    if (floodEvent) {
                        // Do not destroy/reconnect the shared MTProto client for a
                        // server-requested wait. Persist the cooldown so a DO reset
                        // cannot immediately hammer Telegram again. The prefixed JSON
                        // also appears in Cloudflare's exception/invocation details.
                        controller.error(diagnosticError(floodEvent));
                        return;
                    }

                    for (const key of cacheKeys) this.#mtMediaCache.delete(key);
                    this.#discardMtcuteClient(error);

                    // The error itself is structured, rather than relying on logs.
                    controller.error(diagnosticError({
                        event: "telegram_stream_error",
                        at: new Date().toISOString(),
                        activeStreams: this.#activeMultipartDownloads.size,
                        name: error?.name || "Error",
                        message: String(error?.message || error || "").slice(0, 1000),
                        action: "stream_failed_client_preserved_unless_connection_error"
                    }));
                }
            },

            cancel: async reason => {
                finish();

                try {
                    abort.abort(
                        reason instanceof Error
                            ? reason
                            : new Error(String(reason || "HTTP stream cancelled."))
                    );
                } catch {}

                // Await iterator cleanup so mtcute has a chance to cancel its
                // underlying download before the stream is considered closed.
                try {
                    await iterator.return?.();
                } catch {}
            }
        }, new CountQueuingStrategy({ highWaterMark: MTCUTE_STREAM_QUEUE_CHUNKS }));
    }

    // Step-by-step health check. Errors thrown inside a Durable Object lose
    // their stack when they cross RPC, so every phase is caught HERE and
    // reported with its own stack, which points at the real culprit.
    async testMtcute(only = null) {
        const phases = [];

        const run = async (phase, fn) => {
            if (only && only !== phase) return true;

            const started = Date.now();
            console.log("mtcute-test phase start:", phase);

            try {
                const info = await fn();

                console.log("mtcute-test phase ok:", phase);

                phases.push({
                    phase,
                    ok: true,
                    ms: Date.now() - started,
                    ...(info !== undefined ? { info } : {})
                });

                return true;
            } catch (error) {
                console.log(
                    "mtcute-test phase FAILED:", phase,
                    error?.message || String(error), error?.stack || ""
                );

                phases.push({
                    phase,
                    ok: false,
                    ms: Date.now() - started,
                    error: error?.message || String(error),
                    name: error?.name || null,
                    stack: String(error?.stack || "").split("\n").slice(0, 14),
                    cause: error?.cause
                        ? String(error.cause?.message || error.cause)
                        : null
                });

                return false;
            }
        };

        await run("secrets", async () => {
            const [id, hash, session, bot] = await Promise.all([
                this.env.API_ID.get(),
                this.env.API_HASH.get(),
                this.env.MTCUTE_SESSION?.get?.() ?? null,
                this.env.MTCUTE_BOT_TOKEN?.get?.() ?? null
            ]);

            return {
                apiId: Boolean(id),
                apiHash: Boolean(hash),
                session: Boolean(session),
                botToken: Boolean(bot)
            };
        });

        await run("wasm-module", async () => ({
            type: Object.prototype.toString.call(mtcuteWasm),
            isWebAssemblyModule:
                typeof WebAssembly !== "undefined" &&
                mtcuteWasm instanceof WebAssembly.Module
        }));

        await run("crypto-init", async () => {
            const provider = new WebCryptoProvider({ wasmInput: mtcuteWasm });
            await provider.initialize?.();
            return "wasm crypto ready";
        });

        await run("raw-websocket", async () => {
            // Bypasses mtcute: can this Worker open a client WebSocket to
            // Telegram's web endpoint at all?
            const ws = new WebSocket("wss://pluto.web.telegram.org/apiws", "binary");

            await new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error("no open event after 8s")), 8000
                );

                ws.addEventListener("open", () => {
                    clearTimeout(timer);
                    resolve();
                });

                ws.addEventListener("error", () => {
                    clearTimeout(timer);
                    reject(new Error("WebSocket error event"));
                });
            });

            try { ws.close(); } catch {}
            return "opened";
        });

        await run("client-start", async () => {
            const client = await this.#ensureMtcuteClient();

            return {
                clientType: client?.constructor?.name || "TelegramClient"
            };
        });

        return {
            ok: phases.every(p => p.ok),
            phases
        };
    }

    async getChats() {
        return this.#withClient(
            async client => {
                const chats =
                    await client.getChats({
                        from: "main",
                        limit: 100
                    });

                return chats.map(
                    item => {
                        const chat =
                            item.chat;

                        return {
                            id:
                                chat?.id ??
                                null,
                            title:
                                chat?.title ??
                                null,
                            firstName:
                                chat?.firstName ??
                                null,
                            lastName:
                                chat?.lastName ??
                                null,
                            type:
                                chat?.type ??
                                null,
                            username:
                                chat?.username ??
                                null
                        };
                    }
                );
            }
        );
    }

    async getChat(chatId) {
        return this.#withClient(
            async client => {
                const chat =
                    await getChatForId(
                        client,
                        this.env,
                        chatId
                    );

                return {
                    id:
                        chat.id,
                    title:
                        chat.title ??
                        null,
                    firstName:
                        chat.firstName ??
                        null,
                    lastName:
                        chat.lastName ??
                        null,
                    type:
                        chat.type ??
                        null,
                    username:
                        chat.username ??
                        null
                };
            }
        );
    }

    async getMessages(chatId) {
        return this.#withClient(
            async client => {
                const messages =
                    await getMessages(
                        client,
                        this.env,
                        chatId
                    );

                return messages.map(
                    message => ({
                        id:
                            message.id,
                        date:
                            message.date ??
                            null,
                        type:
                            message.type ??
                            null,
                        text:
                            message.text ??
                            "",
                        caption:
                            message.caption ??
                            "",
                        senderId:
                            message.sender?.id ??
                            null,
                        hasMedia:
                            Boolean(
                                getMessageMedia(
                                    message
                                )
                            )
                    })
                );
            }
        );
    }

    async getMessageDetail(
        chatId,
        messageId
    ) {
        return this.#withClient(
            async client => {
                const message =
                    await getMessage(
                        client,
                        this.env,
                        chatId,
                        messageId
                    );

                const media =
                    await getMessageMediaInfo(
                        client,
                        this.env,
                        chatId,
                        messageId,
                        message
                    );

                return {
                    id:
                        message.id,
                    date:
                        message.date ??
                        null,
                    type:
                        message.type ??
                        null,
                    text:
                        message.text ??
                        "",
                    caption:
                        message.caption ??
                        "",
                    senderId:
                        message.sender?.id ??
                        null,
                    media
                };
            }
        );
    }

    async getMediaInfo(
        chatId,
        messageId
    ) {
        return this.#withClient(
            client =>
                getMessageMediaInfo(
                    client,
                    this.env,
                    chatId,
                    messageId
                )
        );
    }

    async getMultipartMediaInfo(
    chatId,
    messageId
) {
    return this.#withClient(
        client =>
            getMultipartMediaInfo(
                client,
                this.env,
                chatId,
                messageId
            )
    );
}

    #checkTelegramCooldown(chatId = null, messageId = null) {
        const now = Date.now();
        if (this.#telegramCooldownUntil <= now) {
            if (this.#telegramCooldownUntil) {
                this.#telegramCooldownUntil = 0;
                this.#lastFloodWaitEvent = null;
                try {
                    if (this.#sqlReady) this.ctx.storage.sql.exec(
                        "DELETE FROM stream_guard WHERE k = ?", "telegram_cooldown_until"
                    );
                } catch {}
            }
            return;
        }

        const waitSeconds = Math.max(1, Math.ceil((this.#telegramCooldownUntil - now) / 1000));
        throw diagnosticError({
            event: "telegram_cooldown_active",
            at: new Date(now).toISOString(),
            chatId: chatId == null ? null : String(chatId),
            messageId: messageId == null ? null : Number(messageId),
            waitSeconds,
            cooldownUntil: new Date(this.#telegramCooldownUntil).toISOString(),
            previousEvent: this.#lastFloodWaitEvent,
            action: "request_rejected_before_telegram_io"
        });
    }

    #recordFloodWait(error, chatId = null, messageId = null) {
        const seconds = floodWaitSeconds(error);
        if (!seconds) return null;

        const now = Date.now();
        this.#telegramCooldownUntil = Math.max(
            this.#telegramCooldownUntil, now + seconds * 1000 + 1500
        );
        const event = {
            event: "telegram_flood_wait",
            at: new Date(now).toISOString(),
            chatId: chatId == null ? null : String(chatId),
            messageId: messageId == null ? null : Number(messageId),
            waitSeconds: seconds,
            cooldownUntil: new Date(this.#telegramCooldownUntil).toISOString(),
            activeStreams: this.#activeMultipartDownloads.size,
            error: String(error?.message || error || "").slice(0, 500),
            action: "preserve_client_and_reject_new_media_requests_during_cooldown"
        };
        this.#lastFloodWaitEvent = event;
        try {
            if (this.#sqlReady) this.ctx.storage.sql.exec(
                "INSERT OR REPLACE INTO stream_guard (k, v) VALUES (?, ?)",
                "telegram_cooldown_until", this.#telegramCooldownUntil
            );
        } catch {}
        return event;
    }

    async resolveMedia(chatId, messageId, thumbnail = false) {
        this.#checkTelegramCooldown(chatId, messageId);
        const key = `${chatId}:${messageId}:${thumbnail ? 1 : 0}`;

        const hit = this.#mediaCache.get(key);

        if (hit && hit.expires > Date.now()) {
            return hit.value;
        }

        let pending = this.#mediaInflight.get(key);

        if (!pending) {
            pending = this.#withClient(client =>
                resolveMediaTarget(
                    client, this.env, chatId, messageId, Boolean(thumbnail)
                )
            )
                .then(value => {
                    if (this.#mediaCache.size >= MEDIA_CACHE_MAX) {
                        const oldest = this.#mediaCache.keys().next().value;
                        this.#mediaCache.delete(oldest);
                    }

                    this.#mediaCache.set(key, {
                        value,
                        expires: Date.now() + (
                            thumbnail ||
                            String(value?.info?.mimeType || "").startsWith("image/")
                                ? IMAGE_META_TTL_MS
                                : MEDIA_CACHE_TTL_MS
                        )
                    });

                    return value;
                })
                .finally(() => {
                    this.#mediaInflight.delete(key);
                });

            this.#mediaInflight.set(key, pending);
        }

        return pending;
    }

    // Diagnostic: bypasses scheduler and cache and hits Telegram directly.
    // Compares tiny-request latency, serial 1 MiB chunks, and parallel
    // batches to tell latency-bound from bandwidth-capped.
    async runSpeedTest(chatId, messageId) {
        return this.#withClient(async client => {
            const message = await getMessage(client, this.env, chatId, messageId);
            const media = getMessageMedia(message);

            if (!media?.fileId) return null;

            const fileId = media.fileId;
            const size = Number(media.fileSize);
            const slots = Math.max(1, Math.floor(size / TELEGRAM_FRAGMENT_SIZE));
            let counter = 0;

            // Distinct offsets per call so nothing can be reused.
            const nextOffset = () =>
                (counter++ % slots) * TELEGRAM_FRAGMENT_SIZE;

            const withTimeout = p => Promise.race([
                p,
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("timeout 120s")), 120000))
            ]);

            const one = async chunkSize => {
                const t = Date.now();

                try {
                    const bytes = await withTimeout(
                        client.downloadChunk(fileId, {
                            offset: nextOffset(),
                            chunkSize
                        })
                    );

                    return { ms: Date.now() - t, bytes: bytes?.length || 0 };
                } catch (error) {
                    return { ms: Date.now() - t, error: error?.message || String(error) };
                }
            };

            const out = { fileSize: size };

            out.tiny4KiB_serial = [];
            for (let i = 0; i < 3; i++) out.tiny4KiB_serial.push(await one(4096));

            out.chunk1MiB_serial = [];
            for (let i = 0; i < 3; i++) out.chunk1MiB_serial.push(await one(TELEGRAM_FRAGMENT_SIZE));

            for (const n of [4, 8]) {
                const t = Date.now();
                const results = await Promise.all(
                    Array.from({ length: n }, () => one(TELEGRAM_FRAGMENT_SIZE))
                );
                const wall = Date.now() - t;
                const bytes = results.reduce((a, r) => a + (r.bytes || 0), 0);

                out["parallel" + n] = {
                    wallMs: wall,
                    perChunkMs: results.map(r => r.ms),
                    errors: results.filter(r => r.error).map(r => r.error),
                    throughputKBps: Math.round(bytes / 1024 / (wall / 1000))
                };
            }

            return out;
        });
    }

    // Diagnostic: sustained download of n sequential 1 MiB chunks with c in
    // flight, to see whether per-chunk time degrades over time (rate
    // limiting) and whether our scheduler/cache path ("sched") is slower
    // than raw client calls ("direct"). Stops launching after 90s.
    async runSustainedTest(chatId, messageId, n, c, mode) {
        return this.#withClient(async client => {
            const message = await getMessage(client, this.env, chatId, messageId);
            const media = getMessageMedia(message);

            if (!media?.fileId) return null;

            const fileId = media.fileId;
            const size = Number(media.fileSize);
            const slots = Math.max(1, Math.floor(size / TELEGRAM_FRAGMENT_SIZE));
            const base = Math.floor(Math.random() * Math.max(1, slots - n));
            const order = ++streamSeq;

            const completions = []; // [secondsSinceStart, chunkMs]
            const errors = [];
            let next = 0;
            const t0 = Date.now();

            const withTimeout = p => Promise.race([
                p,
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("timeout 60s")), 60000))
            ]);

            const worker = async () => {
                while (true) {
                    if (Date.now() - t0 > 90000) return;

                    const i = next++;
                    if (i >= n) return;

                    const offset = ((base + i) % slots) * TELEGRAM_FRAGMENT_SIZE;
                    const started = Date.now();

                    try {
                        if (mode === "sched") {
                            await withTimeout(
                                cachedChunk(client, fileId, offset, order, () => false)
                            );
                        } else {
                            await withTimeout(
                                client.downloadChunk(fileId, {
                                    offset,
                                    chunkSize: TELEGRAM_FRAGMENT_SIZE
                                })
                            );
                        }

                        completions.push([
                            Math.round((Date.now() - t0) / 100) / 10,
                            Date.now() - started
                        ]);
                    } catch (error) {
                        errors.push({
                            i,
                            ms: Date.now() - started,
                            error: error?.message || String(error)
                        });
                    }
                }
            };

            await Promise.all(Array.from({ length: c }, worker));

            const wall = Date.now() - t0;
            const sorted = completions.map(x => x[1]).sort((a, b) => a - b);
            const pct = q => sorted.length
                ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
                : null;

            return {
                mode,
                concurrency: c,
                requested: n,
                completed: completions.length,
                wallMs: wall,
                throughputKBps: Math.round(
                    completions.length * TELEGRAM_FRAGMENT_SIZE / 1024 / (wall / 1000)
                ),
                p50ms: pct(0.5),
                p90ms: pct(0.9),
                maxMs: sorted.length ? sorted[sorted.length - 1] : null,
                errors,
                completions
            };
        });
    }

    // Diagnostic: start one 1 MiB chunk request every 1000/rate ms
    // (open loop, no concurrency cap) and record how long each takes.
    // If a lower rate shows no multi-second stalls while a higher one does,
    // Telegram is throttling request bursts.
    async runPacedTest(chatId, messageId, n, rate) {
        return this.#withClient(async client => {
            const message = await getMessage(client, this.env, chatId, messageId);
            const media = getMessageMedia(message);

            if (!media?.fileId) return null;

            const fileId = media.fileId;
            const size = Number(media.fileSize);
            const slots = Math.max(1, Math.floor(size / TELEGRAM_FRAGMENT_SIZE));
            const base = Math.floor(Math.random() * Math.max(1, slots - n));
            const gap = 1000 / rate;

            const completions = [];
            const errors = [];
            const pending = [];
            const t0 = Date.now();

            const withTimeout = p => Promise.race([
                p,
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("timeout 60s")), 60000))
            ]);

            for (let i = 0; i < n; i++) {
                const due = t0 + i * gap;
                const wait = due - Date.now();

                if (wait > 0) await new Promise(r => setTimeout(r, wait));
                if (Date.now() - t0 > 75000) break;

                const offset = ((base + i) % slots) * TELEGRAM_FRAGMENT_SIZE;
                const started = Date.now();

                pending.push(
                    withTimeout(
                        client.downloadChunk(fileId, {
                            offset,
                            chunkSize: TELEGRAM_FRAGMENT_SIZE
                        })
                    ).then(
                        () => completions.push([
                            Math.round((Date.now() - t0) / 100) / 10,
                            Date.now() - started
                        ]),
                        error => errors.push({
                            i,
                            ms: Date.now() - started,
                            error: error?.message || String(error)
                        })
                    )
                );
            }

            await Promise.all(pending);

            const wall = Date.now() - t0;
            const sorted = completions.map(x => x[1]).sort((a, b) => a - b);
            const pct = q => sorted.length
                ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
                : null;

            return {
                rateReqPerSec: rate,
                started: pending.length,
                completed: completions.length,
                wallMs: wall,
                throughputKBps: Math.round(
                    completions.length * TELEGRAM_FRAGMENT_SIZE / 1024 / (wall / 1000)
                ),
                p50ms: pct(0.5),
                p90ms: pct(0.9),
                maxMs: sorted.length ? sorted[sorted.length - 1] : null,
                slowOver2s: sorted.filter(x => x > 2000).length,
                errors,
                completions
            };
        });
    }

    // Diagnostic: simulates a player (read two 8 MiB windows, abort one
    // half-way, then seek around) through the real mtcute streaming path and
    // reports time-to-first-byte for each step. (?gap= is accepted for URL
    // compatibility but no longer does anything.)
    async runSeekTest(chatId, messageId, _gapMs) {
        const info = await this.getMediaInfo(chatId, messageId);
        const size = Number(info.fileSize);

        if (!info.fileId || !Number.isSafeInteger(size) || size <= 0) return null;

        const MiB = 1024 * 1024;
        const WIN = 8 * MiB;
        const steps = [];
        const t0 = Date.now();

        const timeout = (p, label) => Promise.race([
            p,
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error("timeout 45s: " + label)), 45000))
        ]);

        const open = (start, bytes) => this.downloadRangeStream(
            chatId, messageId, size, start, Math.min(size - 1, start + bytes - 1)
        );

        const readStep = async (label, start, windowBytes, stopAfter) => {
            const began = Date.now();
            const step = { label, start, atSec: Math.round((began - t0) / 100) / 10 };

            try {
                const stream = await open(start, windowBytes);
                const reader = stream.getReader();
                let got = 0;
                step.ttfbMs = null;

                try {
                    while (got < stopAfter) {
                        const r = await timeout(reader.read(), label);
                        if (r.done) break;
                        if (step.ttfbMs === null) step.ttfbMs = Date.now() - began;
                        got += r.value.length;
                    }
                } finally {
                    await reader.cancel().catch(() => {});
                }

                step.bytes = got;
            } catch (error) {
                step.error = error?.message || String(error);
            }

            step.totalMs = Date.now() - began;
            steps.push(step);
        };

        await readStep("play window 1 (full 8 MiB)", 0, WIN, WIN);
        await readStep("play window 2 (abort after 2 MiB)", WIN, WIN, 2 * MiB);
        await readStep("seek to 60% (read 1 MiB)", Math.floor(size * 0.6) + 777, WIN, MiB);
        await readStep("seek to 30% (read 1 MiB)", Math.floor(size * 0.3) + 777, WIN, MiB);

        const began = Date.now();
        const step = { label: "abandon stream at 40%, seek to 80% right away" };

        try {
            const abandoned = await open(Math.floor(size * 0.4), WIN);
            const abandonedReader = abandoned.getReader();
            const pendingRead = abandonedReader.read().catch(() => {});
            await new Promise(r => setTimeout(r, 100));

            const stream = await open(Math.floor(size * 0.8) + 777, WIN);
            const reader = stream.getReader();
            const r = await timeout(reader.read(), step.label);

            step.ttfbMs = Date.now() - began;
            step.bytes = r.value?.length || 0;

            await reader.cancel().catch(() => {});
            await abandonedReader.cancel().catch(() => {});
            await pendingRead;
        } catch (error) {
            step.error = error?.message || String(error);
        }

        step.totalMs = Date.now() - began;
        steps.push(step);

        return {
            fileSize: size,
            totalSec: Math.round((Date.now() - t0) / 100) / 10,
            steps
        };
    }

    async runTestDownload(
        chatId,
        messageId
    ) {
        return this.#withClient(
            async client => {
                const message =
                    await getMessage(
                        client,
                        this.env,
                        chatId,
                        messageId
                    );

                const media =
                    getMessageMedia(
                        message
                    );

                if (!media?.fileId) {
                    return null;
                }

                const result =
                    await testDownload(
                        client,
                        media.fileId
                    );

                return {
                    fileId:
                        media.fileId,
                    fileSize:
                        media.fileSize ??
                        null,
                    ...result
                };
            }
        );
    }

    // Used by /api/thumbnails. Served from the persistent cache when
    // possible; otherwise getMessage + pick-a-thumbnail + download.
    async getThumbnailBuffer(chatId, messageId) {
        const key = `t:${Number(chatId)}:${Number(messageId)}`;

        // Un-versioned entry: answers instantly, expires after a few minutes.
        const fresh = this.#thumbGet(key);
        if (fresh) return fresh;

        return this.#bufferOnce(key, null, () =>
            this.#withClient(async client => {
                const message = await getMessage(
                    client, this.env, chatId, messageId
                );

                const thumbs = getMediaThumbnails(getMessageMedia(message));

                if (!thumbs.length) {
                    return null;
                }

                const thumb = thumbs[thumbs.length - 1];

                // Versioned entry: keyed by the thumbnail's unique id, so it
                // never goes stale and never needs Telegram again. Without
                // this every thumbnail was re-downloaded (upload.getFile)
                // each time the un-versioned entry expired.
                const versionedKey =
                    key + ":" + String(thumb.fileUniqueId || thumb.fileId);

                let bytes = this.#thumbGet(versionedKey);

                if (!bytes) {
                    bytes = await bufferFullDownload(
                        client, thumb.fileId, thumbScheduler, "low"
                    );

                    if (bytes) this.#thumbPut(versionedKey, bytes);
                }

                // Refresh the short-lived entry so the next batch is instant.
                if (bytes) this.#thumbPut(key, bytes);

                return bytes;
            })
        );
    }

    async downloadBuffer(fileId, cacheKey = null) {
        return this.#bufferOnce(
            cacheKey || `f:${fileId}`,
            cacheKey,
            () => this.#withClient(
                client => bufferFullDownload(client, fileId)
            )
        );
    }

    async downloadChunk(
        fileId,
        offset,
        chunkSize
    ) {
        return this.#withClient(
            client =>
                telegramScheduler.run(() => client.downloadChunk(fileId, { offset, chunkSize }), "low")
        );
    }

    async downloadStream(fileId) {
        const client =
            await this.#ensureClient();

        return streamFullDownload(
            client,
            fileId,
            error =>
                this.#discardMtkrutoClient(
                    error
                )
        );
    }

    // One browser Range request on a single-document file.
    async downloadRangeStream(chatId, messageId, fileSize, start, end) {
        this.#checkTelegramCooldown(chatId, messageId);
        const mtClient = await this.#ensureMtcuteClient();
        const [media] = await this.#mtResolveMedia(chatId, [messageId]);

        let size = Number(fileSize);

        if (!Number.isSafeInteger(size) || size <= 0) {
            size = Number(media.fileSize);
        }

        if (!Number.isSafeInteger(size) || size <= 0) {
            throw new Error("Unable to determine Telegram media size.");
        }

        start = Math.max(0, Math.min(size - 1, Number(start)));
        end = Math.max(start, Math.min(size - 1, Number(end)));

        return this.#openMtcuteStream(
            mtClient,
            [{ media, fileSize: size, start, end }],
            [Number(chatId) + ":" + Number(messageId)]
        );
    }

    // One browser Range request on a multipart file. start/end address the
    // concatenation of all parts; only the parts the range touches are
    // resolved, in a single getMessages call.
    async downloadMultipartRangeStream(chatId, parts, start, end) {
        this.#checkTelegramCooldown(chatId, null);
        if (!Array.isArray(parts) || parts.length === 0) {
            throw new Error("Multipart media has no parts.");
        }

        const mtClient = await this.#ensureMtcuteClient();

        let offset = 0;

        const layout = parts.map((part, index) => {
            const size = Number(part.fileSize ?? part.size);

            if (!Number.isSafeInteger(size) || size <= 0) {
                throw new Error(
                    "Invalid multipart size for part " + (index + 1) + "."
                );
            }

            const entry = {
                messageId: Number(part.messageId),
                size,
                start: offset,
                end: offset + size - 1
            };

            offset += size;
            return entry;
        });

        const total = offset;

        start = Math.max(0, Math.min(total - 1, Number(start)));
        end = Math.max(start, Math.min(total - 1, Number(end)));

        const selected = layout.filter(
            part => part.end >= start && part.start <= end
        );

        const media = await this.#mtResolveMedia(
            chatId,
            selected.map(part => part.messageId)
        );

        const segments = selected.map((part, index) => ({
            media: media[index],
            fileSize: part.size,
            start: Math.max(0, start - part.start),
            end: Math.min(part.size - 1, end - part.start)
        }));

        return this.#openMtcuteStream(
            mtClient,
            segments,
            selected.map(part => Number(chatId) + ":" + part.messageId)
        );
    }
}

// ---------------------------------------------------------------------
// Password gate. Everything except /login requires a signed cookie.
// The password lives in the AUTH_PASSWORD Worker secret. If it is not set,
// the Worker refuses to serve anything (fails closed, never open).
// ---------------------------------------------------------------------
const AUTH_COOKIE = "tg_auth";
const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const textEncoder = new TextEncoder();

async function hmacHex(key, message) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signature = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        textEncoder.encode(message)
    );

    return [...new Uint8Array(signature)]
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

function safeEqual(a, b) {
    if (a.length !== b.length) return false;

    let diff = 0;

    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return diff === 0;
}

async function makeAuthCookie(password) {
    const expires = Math.floor(Date.now() / 1000) + AUTH_MAX_AGE;
    const signature = await hmacHex(password, "auth:" + expires);

    return AUTH_COOKIE + "=" + expires + "." + signature +
        "; Max-Age=" + AUTH_MAX_AGE +
        "; Path=/; HttpOnly; Secure; SameSite=Lax";
}

// A token is "<expiryUnixSeconds>.<hex HMAC-SHA256(AUTH_PASSWORD, 'auth:' + expiry)>".
// The worker issues these as its cookie, and another server that knows
// AUTH_PASSWORD can mint them too (see the site integration notes).
async function verifyToken(token, password) {
    const match = /^(\d+)\.([0-9a-f]+)$/.exec(token || "");

    if (!match) return false;

    const expires = Number(match[1]);

    const nowSeconds = Date.now() / 1000;

    if (
        !Number.isSafeInteger(expires) ||
        expires < nowSeconds ||
        expires > nowSeconds + 60 * 60 * 24 * 400
    ) {
        return false;
    }

    const expected = await hmacHex(password, "auth:" + expires);

    return safeEqual(expected, match[2]);
}

// Accepts the cookie, an "Authorization: Bearer <token>" header, or an
// "?auth=<token>" query parameter (needed for <video src> and links).
async function isAuthed(request, password, url) {
    const cookie = request.headers.get("Cookie") || "";
    const fromCookie = /(?:^|;\s*)tg_auth=([^;]+)/.exec(cookie)?.[1];

    if (await verifyToken(fromCookie, password)) return true;

    const bearer = /^Bearer\s+(\S+)$/i.exec(
        request.headers.get("Authorization") || ""
    )?.[1];

    if (await verifyToken(bearer, password)) return true;

    return verifyToken(
        url.searchParams.get("auth") || url.searchParams.get("auth_token"),
        password
    );
}

function loginPage(message, status = 200) {
    return new Response(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>
<style>
body { margin:0; background:#111; color:#eee; font-family:Arial,sans-serif;
       display:flex; align-items:center; justify-content:center; height:100vh; }
form { background:#181818; border:1px solid #2c2c2c; border-radius:8px;
       padding:24px; width:300px; }
input, button { width:100%; box-sizing:border-box; background:#222; color:#eee;
       border:1px solid #444; border-radius:6px; padding:10px; font-size:15px;
       margin-top:12px; }
button { cursor:pointer; }
p { color:#f88; margin:12px 0 0; min-height:1em; }
</style>
</head>
<body>
<form method="POST" action="/login">
<div>Password</div>
<input type="password" name="password" autofocus autocomplete="current-password">
<button type="submit">Sign in</button>
<p>${message}</p>
</form>
</body>
</html>`, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
        }
    });
}

async function handleLogin(request, password, url) {
    // Auto-login: /login?auth=<token>&next=/path sets the cookie and
    // redirects, so the token never stays in the address bar.
    const token =
        url.searchParams.get("auth") || url.searchParams.get("auth_token");

    if (
        request.method === "GET" &&
        token &&
        await verifyToken(token, password)
    ) {
        const remaining =
            Number(token.split(".")[0]) - Math.floor(Date.now() / 1000);

        let next = url.searchParams.get("next") || "/";

        if (!next.startsWith("/") || next.startsWith("//")) next = "/";

        return new Response(null, {
            status: 302,
            headers: {
                Location: next,
                "Set-Cookie": AUTH_COOKIE + "=" + token +
                    "; Max-Age=" + remaining +
                    "; Path=/; HttpOnly; Secure; SameSite=Lax",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer"
            }
        });
    }

    if (request.method === "POST") {
        let submitted = "";

        try {
            const form = await request.formData();
            submitted = String(form.get("password") || "");
        } catch {}

        const ok = safeEqual(
            await hmacHex("login", submitted),
            await hmacHex("login", password)
        );

        if (ok) {
            return new Response(null, {
                status: 302,
                headers: {
                    Location: "/",
                    "Set-Cookie": await makeAuthCookie(password),
                    "Cache-Control": "no-store"
                }
            });
        }

        // Slow down guessing.
        await new Promise(resolve => setTimeout(resolve, 1000));

        return loginPage("Wrong password.", 401);
    }

    return loginPage("");
}

// AUTH_PASSWORD may be a plain Worker secret/variable (a string) or a
// Secrets Store binding (an object with an async get()). The store value is
// cached briefly in memory because each get() is a network round trip.
let authPasswordCache = { value: null, at: 0 };
const AUTH_PASSWORD_TTL_MS = 5 * 60 * 1000;

async function getAuthPassword(env) {
    const binding = env.AUTH_PASSWORD;

    if (typeof binding === "string") return binding || null;

    if (!binding || typeof binding.get !== "function") return null;

    if (
        authPasswordCache.value &&
        Date.now() - authPasswordCache.at < AUTH_PASSWORD_TTL_MS
    ) {
        return authPasswordCache.value;
    }

    try {
        const value = await binding.get();

        if (typeof value === "string" && value) {
            authPasswordCache = { value, at: Date.now() };
            return value;
        }
    } catch (error) {
        console.log(
            "AUTH_PASSWORD read failed:",
            error?.message || String(error)
        );
    }

    return null;
}

// Used only to build the 401 message so a bad token is debuggable.
function describeAuthFailure(request, url) {
    const cookie = request.headers.get("Cookie") || "";

    const candidate =
        url.searchParams.get("auth") ||
        url.searchParams.get("auth_token") ||
        /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") || "")?.[1] ||
        /(?:^|;\s*)tg_auth=([^;]+)/.exec(cookie)?.[1];

    if (!candidate) {
        return "no token found (expected ?auth=TOKEN, an Authorization: Bearer header, or the login cookie)";
    }

    const match = /^(\d+)\.([0-9a-f]+)$/.exec(candidate);

    if (!match) {
        return "token is malformed (expected <expiry-seconds>.<lowercase hex signature>)";
    }

    const expires = Number(match[1]);
    const now = Math.floor(Date.now() / 1000);

    if (expires > now + 60 * 60 * 24 * 400) {
        return "expiry is too far in the future; it looks like milliseconds, use Unix seconds";
    }

    if (expires < now) {
        return "token expired (expiry " + expires + ", server time " + now + ")";
    }

    return "signature does not match (wrong key, or the signed message is not exactly 'auth:' + expiry)";
}

// Cache by URL without the token, so every visitor's fresh token still hits
// the same cached image instead of re-downloading it from Telegram.
function cacheKeyFor(url, version = null) {
    const clean = new URL(url);

    if (version) clean.searchParams.set("_v", String(version));

    clean.searchParams.delete("auth");
    clean.searchParams.delete("auth_token");

    return new Request(clean.toString(), { method: "GET" });
}

export default {
    async fetch(request, env, ctx) {
        const url =
            new URL(
                request.url
            );

        try {
            // Public on purpose: tell well-behaved crawlers to stay away
            // instead of answering them with a 401 in the logs.
            if (url.pathname === "/robots.txt") {
                return new Response("User-agent: *\nDisallow: /\n", {
                    headers: {
                        "Content-Type": "text/plain; charset=utf-8",
                        "Cache-Control": "public, max-age=86400"
                    }
                });
            }

            const password = await getAuthPassword(env);

            if (!password) {
                // Fails closed. Reports names/types only, never values.
                const names = Object.keys(env).sort().join(", ") || "(none)";
                const kind = env.AUTH_PASSWORD === undefined
                    ? "missing"
                    : "present (" + typeof env.AUTH_PASSWORD +
                      ") but empty or unreadable";

                return new Response(
                    "Server not configured: AUTH_PASSWORD is " + kind +
                    ".\nVariables this worker can see: " + names + "\n",
                    {
                        status: 503,
                        headers: { "Content-Type": "text/plain; charset=utf-8" }
                    }
                );
            }

            if (url.pathname === "/login") {
                return await handleLogin(request, password, url);
            }

            if (url.pathname === "/logout") {
                return new Response(null, {
                    status: 302,
                    headers: {
                        Location: "/login",
                        "Set-Cookie": AUTH_COOKIE +
                            "=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"
                    }
                });
            }

            if (!(await isAuthed(request, password, url))) {
                if (
                    request.method === "GET" &&
                    (url.pathname === "/" || url.pathname === "/index.html")
                ) {
                    return Response.redirect(
                        new URL("/login", request.url).toString(),
                        302
                    );
                }

                return json({
                    success: false,
                    error: "Unauthorized.",
                    reason: describeAuthFailure(request, url)
                }, 401);
            }

            if (
                url.pathname === "/" ||
                url.pathname ===
                    "/index.html"
            ) {
                return renderPage();
            }

            if (
                url.pathname ===
                "/piece"
            ) {
                return await handlePieceRequest(
                    request,
                    env,
                    url,
                    ctx
                );
            }

            if (url.pathname === "/image") {
                return handleImageViewer(
                    request,
                    url
                );
            }

            if (
                url.pathname ===
                    "/media" &&
                (
                    request.method ===
                        "GET" ||
                    request.method ===
                        "HEAD"
                )
            ) {
                return await handleDirectMediaRequest(
                    request,
                    env,
                    url,
                    ctx
                );
            }

            if (
                url.pathname.startsWith(
                    "/api/"
                )
            ) {
                return await handleApi(
                    request,
                    env,
                    url
                );
            }

            if (
                url.pathname === "/media" ||
                url.pathname.startsWith("/media/")
            ) {
                return await handleDirectMediaRequest(
                    request,
                    env,
                    url,
                    ctx
                );
            }

            return new Response(
                "Not found",
                {
                    status: 404
                }
            );
        } catch (error) {
            const message = String(error?.message || error || "");
            if (message.startsWith(TG_DIAGNOSTIC_PREFIX)) {
                const raw = message.slice(TG_DIAGNOSTIC_PREFIX.length);
                let event = {};
                try { event = JSON.parse(raw); } catch {}
                const status = event.event === "telegram_cooldown_active" ? 429 : 503;
                return new Response(JSON.stringify(event, null, 2), {
                    status,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "no-store",
                        "Retry-After": String(Math.max(1, Number(event.waitSeconds) || 1)),
                        "X-Telegram-Diagnostic": String(event.event || "error")
                    }
                });
            }

            // Keep structured exception details in the Cloudflare invocation.
            console.error(
                "request failed:",
                JSON.stringify({
                    url: request.url,
                    method: request.method,
                    name:
                        error?.name ||
                        error?.constructor?.name ||
                        "Error",
                    message:
                        error?.message ||
                        String(error),
                    stack:
                        error?.stack ||
                        null
                })
            );

            return json({
                success: false,
                error:
                    error?.message ||
                    String(error),
                name:
                    error?.constructor?.name ||
                    "Error"
            }, 500);
        }
    }
};
