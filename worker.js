import { Client } from "@mtkruto/mtkruto";
import { DurableObject } from "cloudflare:workers";

// Keep each Telegram request at the maximum 1 MiB fragment size.
// streamRangeDownload still splits at fragment boundaries, so this avoids
// LIMIT_INVALID while reducing thousands of tiny Telegram round trips.
const TELEGRAM_CHUNK_SIZE = 1024 * 1024;
const TELEGRAM_PARALLEL_REQUESTS = 5;
const TELEGRAM_OFFSET_ALIGNMENT = 4096;
const TELEGRAM_FRAGMENT_SIZE = 1024 * 1024;

const MAX_ACTIVE_MULTIPART_DOWNLOADS = 1;

// Never let a media player request make us stream hundreds of megabytes or
// gigabytes as one HTTP 206 response. Browsers commonly send ranges such as
// bytes=0-1999999999 even when they only need the first few megabytes. A huge
// response delays metadata/seek handling and can keep the old range alive for
// many minutes. Returning a bounded 206 range lets the browser issue another
// range request as soon as it needs more data.
const MAX_HTTP_RANGE_SIZE = 8 * 1024 * 1024;

const CACHE_CONTROL = "public, max-age=31536000, immutable";

// Files at or under this size are downloaded into memory and served as a
// single buffer, which makes them safely cacheable (see
// bufferFullDownload). Anything larger is streamed and not cached.
const MAX_BUFFERED_SIZE = 2 * 1024 * 1024;

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

async function getMessages(
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

    const start =
        Date.now();

    const messages =
        await client.getHistory(
            numericId,
            {
                limit: 100
            }
        );

    console.log(
        "getHistory:",
        Date.now() - start,
        "ms"
    );

    return messages;
}

async function getMessage(
    client,
    env,
    chatId,
    messageId
) {
    const numericChatId =
        Number(chatId);

    const numericMessageId =
        Number(messageId);

    if (
        !Number.isSafeInteger(
            numericChatId
        ) ||
        !Number.isSafeInteger(
            numericMessageId
        ) ||
        numericChatId === 0 ||
        numericMessageId <= 0
    ) {
        throw new Error(
            "Invalid chat or message ID."
        );
    }

    const prepareStarted =
        Date.now();

    await prepareChatPeer(
        client,
        env,
        numericChatId
    );

    const prepareTime =
        Date.now() -
        prepareStarted;

    const messageStarted =
        Date.now();

    const message =
        await client.getMessage(
            numericChatId,
            numericMessageId
        );

    const messageTime =
        Date.now() -
        messageStarted;

    console.log(
        "getMessage timing:",
        JSON.stringify({
            chatId:
                numericChatId,
            messageId:
                numericMessageId,
            prepareChatPeer:
                prepareTime,
            getMessage:
                messageTime,
            total:
                prepareTime +
                messageTime
        })
    );

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
    const match =
        /^(.+)\.part(\d+)of(\d+)$/i.exec(
            String(filename || "")
        );

    if (!match) {
        return null;
    }

    const part =
        Number(match[2]);

    const total =
        Number(match[3]);

    if (
        !Number.isSafeInteger(part) ||
        !Number.isSafeInteger(total) ||
        part < 1 ||
        total < 1 ||
        part > total
    ) {
        return null;
    }

    return {
        originalName: match[1],
        part,
        total
    };
}

async function getMultipartMediaInfo(
    client,
    env,
    chatId,
    messageId,
    existingMessage = null
) {
    const numericChatId =
        Number(chatId);

    const numericMessageId =
        Number(messageId);

    const targetMessage =
        existingMessage ||
        await getMessage(
            client,
            env,
            numericChatId,
            numericMessageId
        );

    const targetInfo =
        await getMessageMediaInfo(
            client,
            env,
            numericChatId,
            numericMessageId,
            targetMessage
        );

    const multipart =
        parseMultipartFilename(
            targetInfo.fileName
        );

    if (!multipart) {
        return null;
    }

    const found = new Map();

    function addMessageInfo(
        message,
        info
    ) {
        if (!message || !info?.fileId) {
            return;
        }

        const parsed =
            parseMultipartFilename(
                info.fileName
            );

        if (!parsed) {
            return;
        }

        if (
            parsed.originalName !==
                multipart.originalName ||
            parsed.total !==
                multipart.total
        ) {
            return;
        }

        found.set(
            parsed.part,
            {
                ...info,
                part:
                    parsed.part,
                total:
                    parsed.total
            }
        );
    }

    addMessageInfo(
        targetMessage,
        targetInfo
    );

    /*
     * The uploader creates the placeholder messages consecutively,
     * so the multipart messages normally have consecutive Telegram
     * message IDs. Check those exact IDs first. This also means old
     * multipart files continue to work even if they are no longer in
     * the most recent 100 messages.
     */
    const firstMessageId =
        numericMessageId -
        (multipart.part - 1);

    for (
        let part = 1;
        part <= multipart.total;
        part++
    ) {
        if (
            found.has(part)
        ) {
            continue;
        }
    
        const candidateId =
            firstMessageId +
            (part - 1);
    
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
            // Missing/non-media candidate; history fallback below.
        }
    }

    /*
     * If the messages weren't consecutive, search the normal history
     * window as a compatibility fallback.
     */
    if (
        found.size <
        multipart.total
    ) {
        try {
            const history =
                await client.getHistory(
                    numericChatId,
                    {
                        limit: 100
                    }
                );

            for (
                const message of
                history || []
            ) {
                if (
                    found.size >=
                    multipart.total
                ) {
                    break;
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
                "Multipart history fallback failed:",
                error?.message ||
                    String(error)
            );
        }
    }

    if (
        found.size !==
        multipart.total
    ) {
        throw new Error(
            `Could not find all parts of multipart file "${multipart.originalName}". ` +
            `Found ${found.size} of ${multipart.total}.`
        );
    }

    const parts =
        Array.from(
            found.values()
        ).sort(
            (a, b) =>
                a.part -
                b.part
        );

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
                `Multipart file "${multipart.originalName}" is missing part ${index + 1}.`
            );
        }

        if (
            !Number.isSafeInteger(
                Number(parts[index].fileSize)
            ) ||
            Number(parts[index].fileSize) <= 0
        ) {
            throw new Error(
                `Multipart file "${multipart.originalName}" has an invalid size for part ${index + 1}.`
            );
        }
    }

    let totalSize = 0;

    for (
        const part of parts
    ) {
        totalSize +=
            Number(part.fileSize);

        if (
            !Number.isSafeInteger(
                totalSize
            )
        ) {
            throw new Error(
                `Multipart file "${multipart.originalName}" is too large.`
            );
        }
    }

    return {
        multipart: true,
        originalName:
            multipart.originalName,
        totalParts:
            multipart.total,
        fileSize:
            totalSize,
        mimeType:
            parts[0].mimeType ||
            "application/octet-stream",
        parts
    };
}

function createMediaHeaders({
    mimeType,
    size,
    filename,
    start = null,
    end = null
}) {
    const headers = {
        "Content-Type": mimeType || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": CACHE_CONTROL,
        "Access-Control-Allow-Origin": "*",
        "Content-Disposition": `inline; filename="${String(filename || "media").replace(/["\\]/g, "_")}"`
    };

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
async function bufferFullDownload(
    client,
    fileId
) {
    const chunks = [];
    let total = 0;

    const iterator =
        client.download(fileId, {
            chunkSize:
                TELEGRAM_CHUNK_SIZE
        });

    try {
        while (true) {
            const result =
                await iterator.next();

            if (result.done) {
                break;
            }

            const chunk =
                result.value;

            chunks.push(chunk);
            total += chunk.length;
        }
    } finally {
        try {
            await iterator.return?.();
        } catch {}
    }

    if (chunks.length === 1) {
        return chunks[0];
    }

    const output =
        new Uint8Array(total);

    let position = 0;

    for (const chunk of chunks) {
        output.set(chunk, position);
        position += chunk.length;
    }

    return output;
}

async function streamFullDownload(
    client,
    fileId,
    onFatalError
) {
    const iterator =
        client.download(fileId, {
            chunkSize:
                TELEGRAM_CHUNK_SIZE
        });

    const startedAt =
        Date.now();

    let chunks = 0;
    let bytes = 0;
    let telegramWait = 0;
    let processingTime = 0;
    let released = false;

    // The client now lives in the Durable Object and is reused across
    // many streams over its lifetime, so a finished/cancelled/errored
    // stream must NOT disconnect it -- only release this stream's own
    // download iterator. RPC propagates cancellation of the returned
    // ReadableStream back to this cancel() automatically, so there's no
    // AbortSignal to thread through here.
    async function disconnect() {
        if (released) {
            return;
        }

        released = true;

        try {
            await iterator.return?.();
        } catch {}
    }

    function report(
        event,
        extra = {}
    ) {
        console.log(
            "media full download:",
            JSON.stringify({
                event,
                fileId:
                    String(fileId),
                chunks,
                bytes,
                telegramWait,
                processingTime,
                elapsed:
                    Date.now() -
                    startedAt,
                ...extra
            })
        );
    }

    return new ReadableStream({
        async pull(controller) {
            const pullStarted =
                Date.now();

            try {
                const telegramStarted =
                    Date.now();

                const result =
                    await iterator.next();

                telegramWait +=
                    Date.now() -
                    telegramStarted;

                if (result.done) {
                    controller.close();

                    report("complete");

                    await disconnect();
                    return;
                }

                const processStarted =
                    Date.now();

                const value =
                    result.value;

                const valueBytes =
                    value?.byteLength ??
                    value?.length ??
                    0;

                chunks++;
                bytes += valueBytes;

                controller.enqueue(
                    value
                );

                processingTime +=
                    Date.now() -
                    processStarted;

                if (
                    chunks <= 3 ||
                    chunks % 10 === 0
                ) {
                    report(
                        "chunk",
                        {
                            chunk:
                                chunks,
                            chunkBytes:
                                valueBytes,
                            pullTime:
                                Date.now() -
                                pullStarted
                        }
                    );
                }
            } catch (error) {
                report(
                    "error",
                    {
                        error:
                            error?.message ||
                            String(error)
                    }
                );

                controller.error(error);

                await disconnect();

                onFatalError?.(error);
            }
        },

        async cancel(reason) {
            report(
                "cancel",
                {
                    reason:
                        reason?.message ||
                        String(reason || "")
                }
            );

            try {
                await iterator.return?.();
            } catch {}

            await disconnect();
        }
    });
}

async function streamRangeDownload(
    client,
    fileId,
    fileSize,
    start,
    end,
    onFatalError
) {
    const alignedStart =
        Math.floor(
            start /
            TELEGRAM_OFFSET_ALIGNMENT
        ) *
        TELEGRAM_OFFSET_ALIGNMENT;

    let currentOffset = alignedStart;
    let cancelled = false;
    let activeRequests = new Set();

    const startedAt = Date.now();
    let batches = 0;
    let chunks = 0;
    let bytesReceived = 0;
    let bytesSent = 0;
    let telegramWait = 0;

    function report(event, extra = {}) {
        console.log(
            "media range download:",
            JSON.stringify({
                event,
                fileId: String(fileId),
                requestedStart: start,
                requestedEnd: end,
                alignedStart,
                currentOffset,
                batches,
                chunks,
                bytesReceived,
                bytesSent,
                telegramWait,
                elapsed: Date.now() - startedAt,
                ...extra
            })
        );
    }

    /*
     * Telegram's getFile/downloadChunk request must not cross a 1 MiB
     * fragment boundary unless precise mode is used.  Every range chunk is
     * therefore capped to one fragment and rounded to a 4 KiB multiple.
     */
    function requestSizeAt(offset, remaining) {
        const fragmentRemaining =
            TELEGRAM_FRAGMENT_SIZE -
            (offset % TELEGRAM_FRAGMENT_SIZE);

        const desired = Math.min(
            TELEGRAM_CHUNK_SIZE,
            remaining,
            fragmentRemaining
        );

        return Math.max(
            TELEGRAM_OFFSET_ALIGNMENT,
            Math.floor(
                desired /
                TELEGRAM_OFFSET_ALIGNMENT
            ) *
            TELEGRAM_OFFSET_ALIGNMENT
        );
    }

    async function fetchChunk(offset, requestedSize) {
        if (cancelled) {
            return null;
        }

        let requestPromise;
        const telegramStarted = Date.now();

        requestPromise = client.downloadChunk(
            fileId,
            {
                offset,
                chunkSize: requestedSize
            }
        );

        activeRequests.add(requestPromise);

        try {
            const bytes = await requestPromise;
            telegramWait += Date.now() - telegramStarted;

            if (cancelled) {
                return null;
            }

            if (!bytes || bytes.length === 0) {
                throw new Error(
                    "Telegram returned no data at offset " +
                    offset + "."
                );
            }

            if (
                bytes.length < requestedSize &&
                offset + bytes.length < fileSize
            ) {
                throw new Error(
                    "Telegram returned a short range at offset " +
                    offset +
                    " (requested " +
                    requestedSize +
                    ", received " +
                    bytes.length + ")."
                );
            }

            return {
                offset,
                bytes
            };
        } finally {
            activeRequests.delete(requestPromise);
        }
    }

    return new ReadableStream({
        async pull(controller) {
            if (cancelled) {
                return;
            }

            if (currentOffset > end) {
                controller.close();
                report("complete");
                return;
            }

            try {
                const batch = [];
                let batchOffset = currentOffset;

                /*
                 * Keep at most five Telegram reads in flight.  This is the
                 * read-ahead window: it turns the old one-request-at-a-time
                 * stream into a bounded parallel downloader while preserving
                 * byte order when the results are enqueued below.
                 */
                for (
                    let i = 0;
                    i < TELEGRAM_PARALLEL_REQUESTS &&
                    batchOffset <= end;
                    i++
                ) {
                    const remaining =
                        end - batchOffset + 1;

                    const requestSize =
                        requestSizeAt(
                            batchOffset,
                            remaining
                        );

                    batch.push({
                        offset: batchOffset,
                        requestSize
                    });

                    batchOffset += requestSize;
                }

                batches++;

                const results =
                    await Promise.all(
                        batch.map(item =>
                            fetchChunk(
                                item.offset,
                                item.requestSize
                            )
                        )
                    );

                if (cancelled) {
                    return;
                }

                for (let i = 0; i < results.length; i++) {
                    const result = results[i];

                    if (!result) {
                        return;
                    }

                    const chunkStart =
                        result.offset;
                    const bytes =
                        result.bytes;
                    const chunkEnd =
                        chunkStart +
                        bytes.length -
                        1;

                    const outputStart =
                        Math.max(
                            start,
                            chunkStart
                        );
                    const outputEnd =
                        Math.min(
                            end,
                            chunkEnd
                        );

                    if (outputEnd >= outputStart) {
                        const sliceStart =
                            outputStart -
                            chunkStart;
                        const sliceEnd =
                            outputEnd -
                            chunkStart +
                            1;

                        const output =
                            bytes.slice(
                                sliceStart,
                                sliceEnd
                            );

                        bytesSent +=
                            output.length;

                        controller.enqueue(output);
                    }

                    bytesReceived +=
                        bytes.length;
                    chunks++;

                    if (
                        chunks <= 5 ||
                        chunks % 20 === 0
                    ) {
                        report(
                            "chunk",
                            {
                                chunk: chunks,
                                requestedBytes:
                                    batch[i].requestSize,
                                receivedBytes:
                                    bytes.length,
                                offset: chunkStart,
                                chunkEnd,
                                batch: batches
                            }
                        );
                    }
                }

                currentOffset = batchOffset;

                if (
                    currentOffset > end ||
                    currentOffset >= fileSize
                ) {
                    controller.close();
                    report("complete");
                }
            } catch (error) {
                if (cancelled) {
                    return;
                }

                report(
                    "error",
                    {
                        error:
                            error?.message ||
                            String(error)
                    }
                );

                controller.error(error);
                onFatalError?.(error);
            }
        },

        async cancel(reason) {
            cancelled = true;

            report(
                "cancel",
                {
                    reason:
                        reason?.message ||
                        String(reason || ""),
                    activeRequests:
                        activeRequests.size
                }
            );

            /*
             * MTKruto's downloadChunk does not currently expose an AbortSignal
             * here, so an already-running Telegram RPC may finish.  The
             * cancellation flag prevents its result from being emitted and
             * prevents another batch from starting.  This keeps stale seek
             * requests bounded to at most the current five-request window.
             */
        }
    });
}

async function streamMultipartRangeDownload(
    client,
    parts,
    start,
    end,
    onFatalError,
    registerDownload = null
) {
    const normalizedParts =
        parts.map(part => ({
            fileId: part.fileId,
            fileSize: Number(part.fileSize)
        }));

    const segments = [];
    let globalOffset = 0;

    for (const part of normalizedParts) {
        const partStart = globalOffset;
        const partEnd =
            globalOffset +
            part.fileSize -
            1;

        if (end >= partStart && start <= partEnd) {
            const overlapStart =
                Math.max(start, partStart);
            const overlapEnd =
                Math.min(end, partEnd);

            segments.push({
                fileId: part.fileId,
                fileSize: part.fileSize,
                globalStart: overlapStart,
                globalEnd: overlapEnd,
                localStart:
                    overlapStart - partStart,
                localEnd:
                    overlapEnd - partStart
            });
        }

        globalOffset += part.fileSize;

        if (globalOffset > end) {
            break;
        }
    }

    if (!segments.length) {
        throw new Error(
            "Multipart range starts beyond the available file."
        );
    }

    let segmentIndex = 0;
    let currentStream = null;
    let currentReader = null;
    let cancelled = false;
    let unregister = null;

    function cancel(reason) {
        if (cancelled) {
            return;
        }

        cancelled = true;

        try {
            currentReader?.cancel(reason);
        } catch {}

        try {
            currentStream?.cancel(reason);
        } catch {}
    }

    const stream = new ReadableStream({
        async pull(controller) {
            if (cancelled) {
                return;
            }

            try {
                while (
                    segmentIndex <
                    segments.length
                ) {
                    if (cancelled) {
                        return;
                    }

                    const segment =
                        segments[segmentIndex++];

                    /*
                     * Each Telegram part is an independent physical file.
                     * A range that crosses a 2 GiB split is therefore streamed
                     * as adjacent range streams, but each stream starts at the
                     * exact local offset inside its own Telegram document.
                     */
                    currentStream =
                        await streamRangeDownload(
                            client,
                            segment.fileId,
                            segment.fileSize,
                            segment.localStart,
                            segment.localEnd,
                            onFatalError
                        );

                    currentReader =
                        currentStream.getReader();

                    while (true) {
                        if (cancelled) {
                            return;
                        }

                        const result =
                            await currentReader.read();

                        if (result.done) {
                            break;
                        }

                        controller.enqueue(
                            result.value
                        );
                    }

                    try {
                        await currentReader.cancel();
                    } catch {}

                    currentReader = null;
                    currentStream = null;
                }

                if (!cancelled) {
                    controller.close();
                    unregister?.();
                    unregister = null;
                }
            } catch (error) {
                if (cancelled) {
                    return;
                }

                unregister?.();
                unregister = null;

                console.log(
                    "media multipart range:",
                    JSON.stringify({
                        event: "error",
                        requestedStart: start,
                        requestedEnd: end,
                        segments: segments.length,
                        error:
                            error?.message ||
                            String(error)
                    })
                );

                onFatalError?.(error);
                controller.error(error);
            }
        },

        async cancel(reason) {
            cancel(reason);
            unregister?.();
            unregister = null;
        }
    });

    if (registerDownload) {
        unregister =
            registerDownload(cancel);
    }

    return stream;
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
        message.includes("network")
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

    #activeMultipartDownloads =
        new Map();

    #nextMultipartDownloadId = 1;

    #registerMultipartDownload(
    cancel
) {
    const id =
        this.#nextMultipartDownloadId++;

    while (
        this.#activeMultipartDownloads.size >=
        MAX_ACTIVE_MULTIPART_DOWNLOADS
    ) {
        const oldest =
            this.#activeMultipartDownloads
                .entries()
                .next()
                .value;

        if (!oldest) {
            break;
        }

        const [
            oldestId,
            oldestCancel
        ] = oldest;

        this.#activeMultipartDownloads
            .delete(oldestId);

        try {
            oldestCancel(
                "Replaced by a newer multipart download."
            );
        } catch {}
    }

    this.#activeMultipartDownloads.set(
        id,
        cancel
    );

    console.log(
        "multipart download queue:",
        JSON.stringify({
            event:
                "start",id,
            active:
                this.#activeMultipartDownloads.size
        })
    );

    return () => {
        if (
            !this.#activeMultipartDownloads
                .delete(id)
        ) {
            return;
        }

        console.log(
            "multipart download queue:",
            JSON.stringify({
                event:
                    "remove",
                id,
                active:
                    this.#activeMultipartDownloads.size
            })
        );
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

    // Used both when an RPC method's own call throws, and as the
    // onFatalError callback the streaming helpers invoke from inside a
    // ReadableStream's pull() -- i.e. after the client was already
    // handed out. Either way this only affects the NEXT caller; it
    // can't undo the failure the current caller already sees.
    #discardClientOnConnectionError(error) {
        if (looksLikeConnectionError(error)) {
            this.#client = null;
            this.#clientPromise = null;
        }
    }

    async #withClient(fn) {
        const client =
            await this.#ensureClient();

        try {
            return await fn(client);
        } catch (error) {
            this.#discardClientOnConnectionError(
                error
            );

            throw error;
        }
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

    // Used by /api/thumbnails: getMessage + pick-a-thumbnail + download,
    // all as one RPC call so a batch of N messages costs N stub calls
    // (cheap, local) rather than N round trips each needing its own
    // getMediaInfo-then-downloadBuffer pair.
    async getThumbnailBuffer(
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

                const thumbs =
                    getMediaThumbnails(
                        media
                    );

                if (!thumbs.length) {
                    return null;
                }

                const selected =
                    thumbs[
                        thumbs.length - 1
                    ];

                return bufferFullDownload(
                    client,
                    selected.fileId
                );
            }
        );
    }

    async downloadBuffer(fileId) {
        return this.#withClient(
            client =>
                bufferFullDownload(
                    client,
                    fileId
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
                client.downloadChunk(
                    fileId,
                    {
                        offset,
                        chunkSize
                    }
                )
        );
    }

    async downloadStream(fileId) {
        const client =
            await this.#ensureClient();

        return streamFullDownload(
            client,
            fileId,
            error =>
                this.#discardClientOnConnectionError(
                    error
                )
        );
    }

    async downloadRangeStream(
        fileId,
        fileSize,
        start,
        end
    ) {
        const client =
            await this.#ensureClient();

        return streamRangeDownload(
            client,
            fileId,
            fileSize,
            start,
            end,
            error =>
                this.#discardClientOnConnectionError(
                    error
                )
        );
    }


    async downloadMultipartRangeStream(
        parts,
        start,
        end
    ) {
        const client =
            await this.#ensureClient();

        /*
         * Register the cancellation callback INSIDE the Durable Object,
         * before the stream is returned through RPC.  The previous version
         * registered after returning the stream and tried to call
         * stream.cancel() on the RPC-transferred stream.  That does not
         * reliably cancel the producer, which is why stale Range: 0-...
         * downloads kept generating chunks during a seek.
         *
         * The callback below flips the producer's own cancellation flag and
         * cancels its current reader.  The in-flight Telegram call is allowed
         * to finish, but no further stale chunks are requested or enqueued.
         */
        return streamMultipartRangeDownload(
            client,
            parts,
            start,
            end,
            error =>
                this.#discardClientOnConnectionError(
                    error
                ),
            register =>
                this.#registerMultipartDownload(
                    register
                )
        );
    }
}

export default {
    async fetch(request, env, ctx) {
        const url =
            new URL(
                request.url
            );

        try {
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
            // Log the full error so it shows up in observability. Without
            // this, a throw surfaces only as a bare 500 with no clue what
            // failed -- which is exactly what made the shared-client bug
            // so hard to pin down.
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
