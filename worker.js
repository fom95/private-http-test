import { Client } from "@mtkruto/mtkruto";

const TELEGRAM_CHUNK_SIZE = 256 * 1024;
const TELEGRAM_OFFSET_ALIGNMENT = 4096;

const CACHE_CONTROL = "public, max-age=31536000, immutable";

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

async function createClient(env) {
    const apiId = Number(await env.API_ID.get());
    const apiHash = await env.API_HASH.get();
    const session = await env.MTKRUTO_SESSION.get();

    if (!apiId || !apiHash || !session) {
        throw new Error("Telegram credentials are not configured.");
    }

    if (!env.MTKRUTO_CACHE) {
        throw new Error(
            "MTKRUTO_CACHE KV binding is not configured."
        );
    }

    const storage =
        new CloudflareKVStorage(
            env.MTKRUTO_CACHE
        );

    const client = new Client({
        apiId,
        apiHash,
        authString: session,
        storage,
        persistCache: true
    });

    await client.start();

    return client;
}

async function getChatForId(client, chatId) {
    const numericId = Number(chatId);
    const start = Date.now();

    const chatsStart = Date.now();

    const chats = await client.getChats({
        from: "main",
        limit: 100
    });

    const chatsTime = Date.now() - chatsStart;

    const item = chats.find(
        item => item?.chat && Number(item.chat.id) === numericId
    );

    if (!item?.chat) {
        throw new Error(`Chat ${chatId} was not found.`);
    }

    item.chat._debugTimings = {
        getChats: `${chatsTime} ms`,
        total: `${Date.now() - start} ms`
    };

    return item.chat;
}

async function getMessages(client, chatId) {
    const chat = await getChatForId(client, chatId);

    await client.getInputPeer(chat.id);

    return await client.getHistory(chat.id, {
        limit: 100
    });
}

async function getMessage(client, chatId, messageId) {
    const numericChatId = Number(chatId);
    const numericMessageId = Number(messageId);

    if (
        !Number.isSafeInteger(numericChatId) ||
        !Number.isSafeInteger(numericMessageId)
    ) {
        throw new Error("Invalid chat or message ID.");
    }

    const message =
        await client.getMessage(
            numericChatId,
            numericMessageId
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

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

    if (!match) {
        return null;
    }

    let start;
    let end;

    if (match[1] === "") {
        const suffixLength = Number(match[2]);

        if (!suffixLength || suffixLength < 0) {
            return null;
        }

        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(match[1]);

        if (match[2] === "") {
            end = size - 1;
        } else {
            end = Number(match[2]);
        }
    }

    if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        start >= size
    ) {
        return null;
    }

    end = Math.min(end, size - 1);

    return {
        start,
        end,
        length: end - start + 1
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

async function streamFullDownload(
    client,
    fileId,
    signal
) {
    const iterator =
        client.download(fileId, {
            chunkSize:
                TELEGRAM_CHUNK_SIZE,
            signal
        });

    let disconnected = false;

    async function disconnect() {
        if (disconnected) {
            return;
        }

        disconnected = true;

        try {
            await client.disconnect();
        } catch {}
    }

    return new ReadableStream({
        async pull(controller) {
            try {
                const result =
                    await iterator.next();

                if (result.done) {
                    controller.close();
                    await disconnect();
                    return;
                }

                controller.enqueue(
                    result.value
                );
            } catch (error) {
                controller.error(error);
                await disconnect();
            }
        },

        async cancel() {
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
    signal
) {
    const alignedStart =
        Math.floor(start / TELEGRAM_OFFSET_ALIGNMENT) *
        TELEGRAM_OFFSET_ALIGNMENT;

    const requestedLength = end - start + 1;

    let currentOffset = alignedStart;
    let remaining =
        requestedLength +
        (start - alignedStart);

    const stream = new ReadableStream({
        async pull(controller) {
            if (remaining <= 0) {
                controller.close();
                return;
            }

            try {
                const bytes = await client.downloadChunk(fileId, {
                    offset: currentOffset,
                    limit: TELEGRAM_CHUNK_SIZE,
                    chunkSize: TELEGRAM_CHUNK_SIZE,
                    signal
                });

                if (!bytes || bytes.length === 0) {
                    controller.close();
                    return;
                }

                const chunkStart = currentOffset;
                const chunkEnd =
                    currentOffset +
                    bytes.length;

                const wantedStart =
                    Math.max(
                        start,
                        chunkStart
                    );

                const wantedEnd =
                    Math.min(
                        end + 1,
                        chunkEnd
                    );

                if (wantedEnd > wantedStart) {
                    const sliceStart =
                        wantedStart -
                        chunkStart;

                    const sliceEnd =
                        wantedEnd -
                        chunkStart;

                    controller.enqueue(
                        bytes.slice(
                            sliceStart,
                            sliceEnd
                        )
                    );
                }

                currentOffset += bytes.length;
                remaining -= bytes.length;

                if (
                    currentOffset >= fileSize ||
                    currentOffset > end
                ) {
                    controller.close();
                }
            } catch (error) {
                controller.error(error);
            }
        }
    });

    return stream;
}

async function getMessageMediaInfo(client, chatId, messageId) {
    const message = await getMessage(
        client,
        chatId,
        messageId
    );

    const media = getMessageMedia(message);

    if (!media) {
        return {
            messageId: Number(messageId),
            chatId: Number(chatId),
            type: message?.type || null,
            media: null
        };
    }

    const thumbnails =
        getMediaThumbnails(media);

    return {
        messageId: Number(messageId),
        chatId: Number(chatId),
        messageType: message.type,
        mediaType:
            media.constructor?.name || null,
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
            thumbnails.map(item => ({
                fileId:
                    item.fileId ?? null,
                fileUniqueId:
                    item.fileUniqueId ?? null,
                fileSize:
                    item.fileSize ?? null,
                width:
                    item.width ?? null,
                height:
                    item.height ?? null
            }))
    };
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
    const chat =
        ${JSON.stringify(chat)};

    const message =
        ${JSON.stringify(message)};

    const status =
        document.getElementById("status");

    try {
        const infoResponse =
            await fetch(
                "/api/media-info?chat=" +
                encodeURIComponent(chat) +
                "&message=" +
                encodeURIComponent(message),
                {
                    cache: "force-cache"
                }
            );

        if (!infoResponse.ok) {
            throw new Error(
                "Media information request failed: HTTP " +
                infoResponse.status
            );
        }

        const info =
            await infoResponse.json();

        if (
            !info.success ||
            !info.fileId
        ) {
            throw new Error(
                info.error ||
                "This message has no supported media."
            );
        }

        const fileSize =
            Number(info.fileSize);

        const mimeType =
            info.mimeType ||
            "application/octet-stream";

        if (
            !Number.isSafeInteger(fileSize) ||
            fileSize <= 0
        ) {
            throw new Error(
                "Invalid media size."
            );
        }

        if (
            !mimeType.startsWith("image/")
        ) {
            throw new Error(
                "This viewer only supports images."
            );
        }

        const alignment =
            ${TELEGRAM_OFFSET_ALIGNMENT};

        const partCount =
            fileSize >= alignment * 4
                ? 4
                : 1;

        const boundaries =
            [0];

        for (
            let i = 1;
            i < partCount;
            i++
        ) {
            boundaries.push(
                Math.floor(
                    (
                        fileSize *
                        i /
                        partCount
                    ) /
                    alignment
                ) *
                alignment
            );
        }

        boundaries.push(
            fileSize
        );

        async function fetchPart(index) {
            const start =
                boundaries[index];

            const end =
                boundaries[index + 1];

            const params =
                new URLSearchParams({
                    fileId:
                        info.fileId,
                    fileSize:
                        String(fileSize),
                    mime:
                        mimeType,
                    offset:
                        String(start),
                    length:
                        String(end - start)
                });

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
                throw new Error(
                    "Image part " +
                    (index + 1) +
                    " failed: HTTP " +
                    response.status
                );
            }

            return await response.arrayBuffer();
        }

        status.textContent =
            partCount === 4
                ? "Downloading image in 4 parts..."
                : "Downloading image...";

        const parts =
            await Promise.all(
                Array.from(
                    {
                        length:
                            partCount
                    },
                    (_, index) =>
                        fetchPart(index)
                )
            );

        const blob =
            new Blob(
                parts,
                {
                    type:
                        mimeType
                }
            );

        const image =
            document.createElement(
                "img"
            );

        image.src =
            URL.createObjectURL(
                blob
            );

        image.onload = () => {
            status.remove();
        };

        document.body.appendChild(
            image
        );
    } catch (error) {
        status.textContent =
            error.message ||
            String(error);
    }
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

async function handleDirectMediaRequest(
    request,
    env,
    url
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

    const pathParts =
        url.pathname
            .split("/")
            .filter(Boolean);

    let chatId =
        url.searchParams.get("chat");

    let messageId =
        url.searchParams.get("message");

    if (
        pathParts[0] === "media" &&
        pathParts.length >= 3
    ) {
        chatId = pathParts[1];
        messageId = pathParts[2];
    }

    const thumbnail =
        url.searchParams.has("thumb") ||
        url.searchParams.has("thumbnail");

    const photo =
        url.searchParams.get("photo");

    if (!chatId || !messageId) {
        return json({
            success: false,
            error:
                "Missing chat or message."
        }, 400);
    }

    const client =
        await createClient(env);

    try {
        const message =
            await getMessage(
                client,
                chatId,
                messageId
            );

        let media =
            getMessageMedia(message);

        if (!media) {
            return json({
                success: false,
                error:
                    "Message does not contain supported media."
            }, 404);
        }

        let fileId =
            media.fileId;

        let fileSize =
            media.fileSize;

        let mimeType =
            getMediaMimeType(
                media,
                message
            );

        let filename =
            media.fileName ||
            `telegram-${chatId}-${messageId}`;

        if (thumbnail) {
            const thumbnails =
                getMediaThumbnails(media);

            if (!thumbnails.length) {
                return json({
                    success: false,
                    error:
                        "Media has no thumbnail."
                }, 404);
            }

            const selected =
                thumbnails[
                    thumbnails.length - 1
                ] || thumbnails[0];

            fileId =
                selected.fileId;

            fileSize =
                selected.fileSize;

            mimeType =
                "image/jpeg";

            filename +=
                "-thumbnail.jpg";
        } else if (photo) {
            mimeType =
                "image/jpeg";

            filename += ".jpg";
        }

        if (
            !fileId ||
            !Number.isSafeInteger(
                Number(fileSize)
            ) ||
            Number(fileSize) <= 0
        ) {
            return json({
                success: false,
                error:
                    "Media does not contain a downloadable file."
            }, 500);
        }

        fileSize =
            Number(fileSize);

        if (request.method === "HEAD") {
            return new Response(null, {
                status: 200,
                headers:
                    createMediaHeaders({
                        mimeType,
                        size: fileSize,
                        filename
                    })
            });
        }

        const stream =
            await streamFullDownload(
                client,
                fileId,
                request.signal
            );

        return new Response(
            stream,
            {
                status: 200,
                headers:
                    createMediaHeaders({
                        mimeType,
                        size: fileSize,
                        filename
                    })
            }
        );
    } finally {
        if (request.method !== "GET") {
            try {
                await client.disconnect();
            } catch {}
        }
    }
}

async function handlePieceRequest(
    request,
    env,
    url
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

    const fileId =
        url.searchParams.get("fileId");

    const fileSizeParam =
        url.searchParams.get("fileSize");

    const offsetParam =
        url.searchParams.get("offset");

    const lengthParam =
        url.searchParams.get("length");

    const mimeType =
        url.searchParams.get("mime") ||
        "application/octet-stream";

    if (
        !fileId ||
        fileSizeParam === null ||
        offsetParam === null ||
        lengthParam === null
    ) {
        return json({
            success: false,
            error:
                "Missing fileId, fileSize, offset, or length."
        }, 400);
    }

    const fileSize =
        Number(fileSizeParam);

    const offset =
        Number(offsetParam);

    const length =
        Number(lengthParam);

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
        offset % TELEGRAM_OFFSET_ALIGNMENT !== 0
    ) {
        return json({
            success: false,
            error:
                `Offset must be divisible by ${TELEGRAM_OFFSET_ALIGNMENT}.`
        }, 400);
    }

    if (offset >= fileSize) {
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

    const actualLength =
        Math.min(
            length,
            fileSize - offset
        );

    if (request.method === "HEAD") {
        return new Response(null, {
            status: 200,
            headers: {
                "Content-Type":
                    mimeType,
                "Content-Length":
                    String(actualLength),
                "Cache-Control":
                    CACHE_CONTROL,
                "Accept-Ranges":
                    "bytes",
                "Content-Range":
                    `bytes ${offset}-${offset + actualLength - 1}/${fileSize}`
            }
        });
    }

    const client =
        await createClient(env);

    try {
        const chunks = [];
        let downloaded = 0;
        let currentOffset = offset;

        while (
            downloaded < actualLength
        ) {
            const bytes =
                await client.downloadChunk(
                    fileId,
                    {
                        offset:
                            currentOffset,
                        limit:
                            TELEGRAM_CHUNK_SIZE,
                        chunkSize:
                            TELEGRAM_CHUNK_SIZE,
                        signal:
                            request.signal
                    }
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

            const needed =
                Math.min(
                    bytes.length,
                    actualLength -
                        downloaded
                );

            chunks.push(
                needed === bytes.length
                    ? bytes
                    : bytes.slice(
                        0,
                        needed
                    )
            );

            downloaded +=
                needed;

            currentOffset +=
                bytes.length;

            if (
                needed < bytes.length
            ) {
                break;
            }
        }

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

        return new Response(
            output,
            {
                status: 200,
                headers: {
                    "Content-Type":
                        mimeType,
                    "Content-Length":
                        String(
                            output.length
                        ),
                    "Cache-Control":
                        CACHE_CONTROL,
                    "Accept-Ranges":
                        "bytes",
                    "Content-Range":
                        `bytes ${offset}-${offset + output.length - 1}/${fileSize}`,
                    "X-Telegram-File-Size":
                        String(fileSize),
                    "X-Telegram-Piece-Offset":
                        String(offset)
                }
            }
        );
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

async function testDownload(
    client,
    fileId,
    signal
) {
    const iterator =
        client.download(
            fileId,
            {
                chunkSize:
                    TELEGRAM_CHUNK_SIZE,
                signal
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

    if (path === "/api/chats") {
        const client =
            await createClient(env);

        try {
            const chats =
                await client.getChats({
                    from: "main",
                    limit: 100
                });

            return json({
                success: true,
                chats:
                    chats.map(item => {
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
                    })
            });
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
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

        const client =
            await createClient(env);

        try {
            const chat =
                await getChatForId(
                    client,
                    chatId
                );

            return json({
                success: true,
                chat: {
                    id: chat.id,
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
                }
            });
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
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

        const client =
            await createClient(env);

        try {
            const messages =
                await getMessages(
                    client,
                    chatId
                );

            return json({
                success: true,
                chatId:
                    Number(chatId),
                messages:
                    messages.map(
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
                    )
            });
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
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

        const client =
            await createClient(env);

        try {
            return json({
                success: true,
                ...(
                    await getMessageMediaInfo(
                        client,
                        chatId,
                        messageId
                    )
                )
            });
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
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

        const client =
            await createClient(env);

        try {
            const message =
                await getMessage(
                    client,
                    chatId,
                    messageId
                );

            return json({
                success: true,
                message: {
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
                    media:
                        await getMessageMediaInfo(
                            client,
                            chatId,
                            messageId
                        )
                }
            });
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
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

        const client =
            await createClient(env);

        try {
            const message =
                await getMessage(
                    client,
                    chatId,
                    messageId
                );

            const media =
                getMessageMedia(
                    message
                );

            if (!media?.fileId) {
                return json({
                    success: false,
                    error:
                        "Message has no downloadable media."
                }, 404);
            }

            const result =
                await testDownload(
                    client,
                    media.fileId,
                    request.signal
                );

            return json({
                success: true,
                fileId:
                    media.fileId,
                fileSize:
                    media.fileSize ??
                    null,
                ...result
            });
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
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
const PIECE_CONCURRENCY = 4;

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

    return await response.arrayBuffer();
}

async function fetchImageParts(
    fileId,
    fileSize,
    mimeType,
    token
) {
    const alignment =
        ${TELEGRAM_OFFSET_ALIGNMENT};

    const partCount =
        fileSize >= alignment * 4
            ? 4
            : 1;

    const boundaries =
        [0];

    for (
        let i = 1;
        i < partCount;
        i++
    ) {
        boundaries.push(
            Math.floor(
                (
                    fileSize *
                    i /
                    partCount
                ) /
                alignment
            ) *
            alignment
        );
    }

    boundaries.push(
        fileSize
    );

    const parts =
        new Array(partCount);

    async function fetchPart(
        index
    ) {
        if (
            token !==
            mediaLoadToken
        ) {
            throw new Error(
                "Media load cancelled."
            );
        }

        const start =
            boundaries[index];

        const end =
            boundaries[index + 1];

        const length =
            end - start;

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

        return buffer;
    }

    mediaStatus.textContent =
        partCount === 4
            ? "Downloading image in 4 parts..."
            : "Downloading image...";

    const completed =
        new Array(partCount);

    const results =
        await Promise.all(
            Array.from(
                {
                    length:
                        partCount
                },
                (_, index) =>
                    fetchPart(
                        index
                    ).then(
                        buffer => {
                            completed[
                                index
                            ] = buffer;

                            const total =
                                completed
                                    .filter(
                                        Boolean
                                    )
                                    .reduce(
                                        (
                                            sum,
                                            part
                                        ) =>
                                            sum +
                                            part.byteLength,
                                        0
                                    );

                            const count =
                                completed
                                    .filter(
                                        Boolean
                                    )
                                    .length;

                            mediaProgress.style.width =
                                (
                                    total /
                                    fileSize *
                                    100
                                ) +
                                "%";

                            mediaStatus.textContent =
                                "Downloaded " +
                                formatBytes(
                                    total
                                ) +
                                " / " +
                                formatBytes(
                                    fileSize
                                ) +
                                " (" +
                                count +
                                " / " +
                                partCount +
                                " parts)";

                            return buffer;
                        }
                    )
            )
        );

    return results;
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

        currentObjectUrl =
            null;
    }

    mediaContainer.innerHTML = "";
    mediaInfo.innerHTML = "";
    mediaStatus.textContent = "";
    mediaProgress.style.width =
        "0%";

    mediaPanel.classList.remove(
        "hidden"
    );

    mediaStatus.textContent =
        "Getting media information...";

    const info =
        await api(
            "/api/media-info?chat=" +
            encodeURIComponent(
                chatId
            ) +
            "&message=" +
            encodeURIComponent(
                messageId
            )
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

        mediaStatus.textContent =
            "";

        return;
    }

    const size =
        Number(
            info.fileSize
        );

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
        escapeHtml(
            info.mimeType || ""
        ) +
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
        !Number.isFinite(size) ||
        size <= 0
    ) {
        mediaStatus.textContent =
            "Invalid media size.";

        return;
    }

    mediaStatus.textContent =
        "Downloading media in separate pieces...";

    try {
        const mime =
            info.mimeType || "";
        
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
        } else {
            const pieces =
                await fetchMediaPieces(
                    info.fileId,
                    size,
                    info.mimeType,
                    token
                );
        
            if (
                token !==
                mediaLoadToken
            ) {
                return;
            }
        
            const blob =
                combinePieces(
                    pieces,
                    info.mimeType
                );
        
            currentObjectUrl =
                URL.createObjectURL(
                    blob
                );
        
            if (
                mime.startsWith(
                    "video/"
                )
            ) {
                const video =
                    document.createElement(
                        "video"
                    );
        
                video.controls = true;
                video.preload =
                    "metadata";
                video.src =
                    currentObjectUrl;
        
                mediaContainer.appendChild(
                    video
                );
        
                mediaStatus.textContent =
                    "Video loaded.";
            } else if (
                mime.startsWith(
                    "audio/"
                )
            ) {
                const audio =
                    document.createElement(
                        "audio"
                    );
        
                audio.controls = true;
                audio.src =
                    currentObjectUrl;
        
                mediaContainer.appendChild(
                    audio
                );
        
                mediaStatus.textContent =
                    "Audio loaded.";
            } else {
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
            error.message;
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

    await loadMedia(
        selectedChatId,
        selectedMessageId
    );
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

export default {
    async fetch(request, env) {
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
                    url
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
                    url
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
                    url
                );
            }

            return new Response(
                "Not found",
                {
                    status: 404
                }
            );
        } catch (error) {
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
