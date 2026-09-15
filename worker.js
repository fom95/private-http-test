import { Client } from "@mtkruto/mtkruto";

const TELEGRAM_CHUNK_SIZE = 256 * 1024;
const TELEGRAM_OFFSET_ALIGNMENT = 4096;

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...extraHeaders
        }
    });
}

function html(body, status = 200) {
    return new Response(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Media Test</title>
<style>
*{box-sizing:border-box}

body{
    margin:0;
    padding:24px;
    background:#111;
    color:#ddd;
    font:14px system-ui,sans-serif;
}

main{
    max-width:1000px;
    margin:auto;
}

h1,h2{
    color:#fff;
}

h1{
    margin-top:0;
}

section{
    background:#1b1b1b;
    border:1px solid #333;
    border-radius:8px;
    padding:16px;
    margin:16px 0;
}

select{
    width:100%;
    max-width:800px;
    background:#222;
    color:#eee;
    border:1px solid #555;
    border-radius:5px;
    padding:8px 10px;
}

a{
    color:#7db7ff;
    display:block;
    margin:9px 0;
    overflow-wrap:anywhere;
}

pre{
    white-space:pre-wrap;
    overflow-wrap:anywhere;
    background:#0b0b0b;
    border:1px solid #292929;
    padding:12px;
    border-radius:5px;
    max-height:500px;
    overflow:auto;
}

.small{
    color:#999;
}

.error{
    color:#ff7777;
}

.info{
    color:#aaa;
    margin-top:8px;
}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8"
        }
    });
}

function errorInfo(error) {
    return {
        success: false,
        error: error?.message || String(error),
        name: error?.name || "Error",
        stack: error?.stack
    };
}

async function getTelegramClient(env) {
    const apiId = Number(await env.API_ID.get());
    const apiHash = await env.API_HASH.get();
    const authString = await env.MTKRUTO_SESSION.get();

    if (!apiId || !apiHash || !authString) {
        throw new Error("Missing Telegram credentials or MTKruto session.");
    }

    const client = new Client({
        apiId,
        apiHash,
        authString,
        persistCache: false,
        defaultHandlers: false,
        disableUpdates: true
    });

    await client.connect();

    return client;
}

function getMessageMedia(message) {
    if (!message) return null;

    if (message.type === "photo" && message.photo) {
        return {
            type: "photo",
            media: message.photo,
            mimeType: "image/jpeg",
            fileName: null
        };
    }

    if (message.type === "livePhoto") {
        if (message.photo) {
            return {
                type: "photo",
                media: message.photo,
                mimeType: "image/jpeg",
                fileName: null
            };
        }

        if (message.video) {
            return {
                type: "video",
                media: message.video,
                mimeType: message.video.mimeType || "video/mp4",
                fileName: message.video.fileName || null
            };
        }
    }

    const types = [
        ["document", "document"],
        ["video", "video"],
        ["animation", "animation"],
        ["audio", "audio"],
        ["voice", "voice"],
        ["videoNote", "videoNote"],
        ["sticker", "sticker"]
    ];

    for (const [messageType, property] of types) {
        if (message.type === messageType && message[property]) {
            const media = message[property];

            return {
                type: messageType,
                media,
                mimeType: media.mimeType || null,
                fileName: media.fileName || null
            };
        }
    }

    return null;
}

function getMediaThumbnails(media) {
    if (!media) return [];

    const thumbnails = [];

    if (Array.isArray(media.thumbnails)) {
        for (const thumbnail of media.thumbnails) {
            if (thumbnail?.fileId) {
                thumbnails.push(thumbnail);
            }
        }
    }

    if (media.thumbnail?.fileId) {
        thumbnails.push(media.thumbnail);
    }

    return thumbnails;
}

function getMessageMediaInfo(message) {
    const info = getMessageMedia(message);

    if (!info) return null;

    const media = info.media;

    return {
        type: info.type,
        fileId: media.fileId || null,
        fileUniqueId: media.fileUniqueId || null,
        fileSize: media.fileSize ?? null,
        fileName: info.fileName,
        mimeType: info.mimeType,
        width: media.width ?? null,
        height: media.height ?? null,
        duration: media.duration ?? null,
        thumbnails: getMediaThumbnails(media).map((thumbnail, index) => ({
            index,
            fileId: thumbnail.fileId,
            fileUniqueId: thumbnail.fileUniqueId || null,
            fileSize: thumbnail.fileSize ?? null,
            width: thumbnail.width ?? null,
            height: thumbnail.height ?? null
        }))
    };
}

function detectImageMimeType(bytes) {
    if (!bytes || bytes.length < 4) return null;

    if (
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "image/jpeg";
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
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38
    ) {
        return "image/gif";
    }

    if (
        bytes.length >= 12 &&
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

    if (
        bytes.length >= 12 &&
        bytes[4] === 0x66 &&
        bytes[5] === 0x74 &&
        bytes[6] === 0x79 &&
        bytes[7] === 0x70
    ) {
        const brand = String.fromCharCode(
            bytes[8],
            bytes[9],
            bytes[10],
            bytes[11]
        );

        if (
            brand === "avif" ||
            brand === "avis"
        ) {
            return "image/avif";
        }

        if (
            brand === "heic" ||
            brand === "heix" ||
            brand === "hevc" ||
            brand === "hevx"
        ) {
            return "image/heic";
        }
    }

    return null;
}

async function getChatForId(client, chatId) {
    const numericId = Number(chatId);

    if (!Number.isFinite(numericId)) {
        throw new Error(`Invalid chat ID: ${chatId}`);
    }

    const chats = await client.getChats({
        from: "main",
        limit: 100
    });

    const item = chats.find(
        item =>
            item?.chat &&
            Number(item.chat.id) === numericId
    );

    if (!item?.chat) {
        throw new Error(`Chat ${chatId} was not found.`);
    }

    return item.chat;
}

async function getMessages(client, chatId) {
    const chat = await getChatForId(
        client,
        chatId
    );

    /*
     * This is deliberately the same working history
     * resolution path used before the media changes.
     */
    await client.getInputPeer(chat.id);

    return await client.getHistory(
        chat.id,
        {
            limit: 100
        }
    );
}

function parseRange(rangeHeader, fileSize) {
    if (!rangeHeader) return null;

    const match =
        /^bytes=(\d*)-(\d*)$/.exec(
            rangeHeader.trim()
        );

    if (!match) {
        return {
            error: "Invalid Range header."
        };
    }

    const startText = match[1];
    const endText = match[2];

    if (!startText && !endText) {
        return {
            error: "Invalid Range header."
        };
    }

    let start;
    let end;

    if (!startText) {
        const suffixLength = Number(endText);

        if (
            !Number.isSafeInteger(suffixLength) ||
            suffixLength <= 0
        ) {
            return {
                error: "Invalid suffix Range."
            };
        }

        start = Math.max(
            0,
            fileSize - suffixLength
        );

        end = fileSize - 1;
    } else {
        start = Number(startText);

        if (
            !Number.isSafeInteger(start) ||
            start < 0
        ) {
            return {
                error: "Invalid Range start."
            };
        }

        if (start >= fileSize) {
            return {
                unsatisfied: true
            };
        }

        if (endText) {
            end = Number(endText);

            if (
                !Number.isSafeInteger(end) ||
                end < start
            ) {
                return {
                    error: "Invalid Range end."
                };
            }

            end = Math.min(
                end,
                fileSize - 1
            );
        } else {
            end = fileSize - 1;
        }
    }

    return {
        start,
        end
    };
}

function createMediaHeaders({
    contentType,
    contentLength,
    fileSize,
    start,
    end,
    fileName
}) {
    const headers = new Headers();

    headers.set(
        "Content-Type",
        contentType || "application/octet-stream"
    );

    headers.set(
        "Content-Length",
        String(contentLength)
    );

    headers.set(
        "Accept-Ranges",
        "bytes"
    );

    headers.set(
        "Cache-Control",
        "public, max-age=31536000, immutable"
    );

    headers.set(
        "Content-Disposition",
        fileName
            ? `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`
            : "inline"
    );

    if (
        start !== undefined &&
        end !== undefined
    ) {
        headers.set(
            "Content-Range",
            `bytes ${start}-${end}/${fileSize}`
        );
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
            chunkSize: TELEGRAM_CHUNK_SIZE,
            signal
        });

    let closed = false;

    const cleanup = async () => {
        if (closed) return;
        closed = true;

        try {
            await client.disconnect();
        } catch {}
    };

    return new ReadableStream({
        async start(controller) {
            try {
                for await (const chunk of iterator) {
                    if (
                        signal?.aborted
                    ) {
                        throw new DOMException(
                            "The request was aborted.",
                            "AbortError"
                        );
                    }

                    if (
                        !chunk ||
                        chunk.length === 0
                    ) {
                        continue;
                    }

                    controller.enqueue(chunk);
                }

                controller.close();

                await cleanup();
            } catch (error) {
                try {
                    controller.error(error);
                } finally {
                    await cleanup();
                }
            }
        },

        async cancel() {
            try {
                if (
                    typeof iterator.return ===
                    "function"
                ) {
                    await iterator.return();
                }
            } catch {}

            await cleanup();
        }
    });
}

async function streamRangeDownload(
    client,
    fileId,
    httpStart,
    httpEnd,
    signal
) {
    /*
     * Telegram offsets are aligned down independently
     * of the browser's HTTP Range.
     */
    let telegramOffset =
        Math.floor(
            httpStart /
            TELEGRAM_OFFSET_ALIGNMENT
        ) *
        TELEGRAM_OFFSET_ALIGNMENT;

    let discardBefore =
        httpStart - telegramOffset;

    let remaining =
        httpEnd - httpStart + 1;

    let closed = false;

    const cleanup = async () => {
        if (closed) return;
        closed = true;

        try {
            await client.disconnect();
        } catch {}
    };

    return new ReadableStream({
        async start(controller) {
            try {
                while (remaining > 0) {
                    if (
                        signal?.aborted
                    ) {
                        throw new DOMException(
                            "The request was aborted.",
                            "AbortError"
                        );
                    }

                    /*
                     * Always request exactly 256 KiB.
                     * Never pass `remaining` as chunkSize.
                     */
                    const chunk =
                        await client.downloadChunk(
                            fileId,
                            {
                                chunkSize:
                                    TELEGRAM_CHUNK_SIZE,
                                offset:
                                    telegramOffset,
                                signal
                            }
                        );

                    if (
                        !chunk ||
                        chunk.length === 0
                    ) {
                        throw new Error(
                            `Telegram returned an empty chunk at offset ${telegramOffset}.`
                        );
                    }

                    const from =
                        discardBefore;

                    if (
                        from >= chunk.length
                    ) {
                        throw new Error(
                            `Telegram returned too little data at offset ${telegramOffset}.`
                        );
                    }

                    const available =
                        chunk.length - from;

                    const sendLength =
                        Math.min(
                            available,
                            remaining
                        );

                    const output =
                        from === 0 &&
                        sendLength === chunk.length
                            ? chunk
                            : chunk.slice(
                                from,
                                from + sendLength
                            );

                    controller.enqueue(
                        output
                    );

                    remaining -=
                        sendLength;

                    telegramOffset +=
                        chunk.length;

                    discardBefore = 0;
                }

                controller.close();

                await cleanup();
            } catch (error) {
                try {
                    controller.error(error);
                } finally {
                    await cleanup();
                }
            }
        },

        async cancel() {
            await cleanup();
        }
    });
}

async function handleDirectMediaRequest(
    request,
    env
) {
    const url =
        new URL(request.url);

    const fileId =
        url.searchParams.get("file");

    if (!fileId) {
        return json({
            success: false,
            error: "Missing file parameter."
        }, 400);
    }

    const sizeParam =
        url.searchParams.get("size");

    if (!sizeParam) {
        return json({
            success: false,
            error: "Missing size parameter."
        }, 400);
    }

    const fileSize =
        Number(sizeParam);

    if (
        !Number.isSafeInteger(fileSize) ||
        fileSize < 0
    ) {
        return json({
            success: false,
            error: "Invalid size parameter."
        }, 400);
    }

    let contentType =
        url.searchParams.get("type");

    /*
     * Telegram Photo objects do not expose a MIME type.
     * They are JPEGs when served as their file representation.
     */
    if (
        !contentType ||
        contentType ===
            "application/octet-stream"
    ) {
        contentType =
            url.searchParams.get("photo") === "1"
                ? "image/jpeg"
                : "application/octet-stream";
    }

    const fileName =
        url.searchParams.get("name") ||
        null;

    const isHead =
        request.method === "HEAD";

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

    const client =
        await getTelegramClient(env);

    try {
        const range =
            parseRange(
                request.headers.get("Range"),
                fileSize
            );

        if (range?.error) {
            await client.disconnect();

            return json({
                success: false,
                error: range.error
            }, 416);
        }

        if (range?.unsatisfied) {
            await client.disconnect();

            return new Response(null, {
                status: 416,
                headers: {
                    "Content-Range":
                        `bytes */${fileSize}`,
                    "Accept-Ranges":
                        "bytes"
                }
            });
        }

        /*
         * A normal GET gets the entire file through
         * MTKruto's normal streaming download().
         */
        if (!range) {
            const headers =
                createMediaHeaders({
                    contentType,
                    contentLength: fileSize,
                    fileSize,
                    fileName
                });

            if (isHead) {
                await client.disconnect();

                return new Response(null, {
                    status: 200,
                    headers
                });
            }

            if (fileSize === 0) {
                await client.disconnect();

                return new Response(null, {
                    status: 200,
                    headers
                });
            }

            /*
             * The client is intentionally NOT disconnected here.
             * streamFullDownload() owns it until the stream finishes.
             */
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
                    headers
                }
            );
        }

        const start =
            range.start;

        const end =
            range.end;

        const contentLength =
            end - start + 1;

        const headers =
            createMediaHeaders({
                contentType,
                contentLength,
                fileSize,
                start,
                end,
                fileName
            });

        if (isHead) {
            await client.disconnect();

            return new Response(null, {
                status: 206,
                headers
            });
        }

        const stream =
            await streamRangeDownload(
                client,
                fileId,
                start,
                end,
                request.signal
            );

        return new Response(
            stream,
            {
                status: 206,
                headers
            }
        );
    } catch (error) {
        try {
            await client.disconnect();
        } catch {}

        throw error;
    }
}

async function handleLegacyMediaRequest(
    request,
    env,
    chatId,
    messageId
) {
    const client =
        await getTelegramClient(env);

    let info;

    try {
        const chat =
            await getChatForId(
                client,
                chatId
            );

        const message =
            await client.getMessage(
                chat.id,
                Number(messageId)
            );

        info =
            getMessageMediaInfo(
                message
            );

        if (!info?.fileId) {
            return json({
                success: false,
                error:
                    "Message does not contain downloadable media."
            }, 404);
        }
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }

    const url =
        new URL(request.url);

    url.pathname = "/media";
    url.search = "";

    url.searchParams.set(
        "file",
        info.fileId
    );

    url.searchParams.set(
        "size",
        String(info.fileSize || 0)
    );

    if (info.mimeType) {
        url.searchParams.set(
            "type",
            info.mimeType
        );
    }

    if (info.type === "photo") {
        url.searchParams.set(
            "photo",
            "1"
        );
    }

    if (info.fileName) {
        url.searchParams.set(
            "name",
            info.fileName
        );
    }

    return await handleDirectMediaRequest(
        new Request(
            url.toString(),
            request
        ),
        env
    );
}

async function testDownload(
    request,
    env
) {
    const url =
        new URL(request.url);

    const fileId =
        url.searchParams.get("file");

    const sizeParam =
        url.searchParams.get("size");

    if (!fileId) {
        return json({
            success: false,
            error: "Missing file parameter."
        }, 400);
    }

    if (!sizeParam) {
        return json({
            success: false,
            error: "Missing size parameter."
        }, 400);
    }

    const fileSize =
        Number(sizeParam);

    if (
        !Number.isSafeInteger(fileSize) ||
        fileSize < 0
    ) {
        return json({
            success: false,
            error: "Invalid size parameter."
        }, 400);
    }

    const client =
        await getTelegramClient(env);

    try {
        let total = 0;
        let chunks = 0;

        const started =
            Date.now();

        for await (
            const chunk of client.download(
                fileId,
                {
                    chunkSize:
                        TELEGRAM_CHUNK_SIZE,
                    signal:
                        request.signal
                }
            )
        ) {
            if (
                request.signal.aborted
            ) {
                throw new DOMException(
                    "The request was aborted.",
                    "AbortError"
                );
            }

            total +=
                chunk.length;

            chunks++;
        }

        return json({
            success: true,
            fileId,
            expectedSize: fileSize,
            downloadedBytes: total,
            chunks,
            chunkSize:
                TELEGRAM_CHUNK_SIZE,
            elapsedMs:
                Date.now() - started
        });
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

async function getChatsApi(env) {
    const client =
        await getTelegramClient(env);

    try {
        const result =
            await client.getChats({
                from: "main",
                limit: 100
            });

        return result.map(item => {
            const chat =
                item.chat;

            return {
                id: chat.id,
                title:
                    chat.title || null,
                firstName:
                    chat.firstName || null,
                lastName:
                    chat.lastName || null,
                username:
                    chat.username || null,
                type:
                    chat.type || null
            };
        });
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

function buildMediaUrl(
    request,
    media,
    extra = {}
) {
    if (
        !media?.fileId ||
        media.fileSize == null
    ) {
        return null;
    }

    const url =
        new URL(
            "/media",
            request.url
        );

    url.searchParams.set(
        "file",
        media.fileId
    );

    url.searchParams.set(
        "size",
        String(media.fileSize)
    );

    if (media.mimeType) {
        url.searchParams.set(
            "type",
            media.mimeType
        );
    }

    if (media.type === "photo") {
        url.searchParams.set(
            "photo",
            "1"
        );
    }

    if (media.fileName) {
        url.searchParams.set(
            "name",
            media.fileName
        );
    }

    for (const [key, value] of
        Object.entries(extra)) {
        if (value != null) {
            url.searchParams.set(
                key,
                String(value)
            );
        }
    }

    return url.toString();
}

function buildThumbnailUrl(
    request,
    thumbnail
) {
    if (!thumbnail?.fileId) {
        return null;
    }

    const url =
        new URL(
            "/media",
            request.url
        );

    url.searchParams.set(
        "file",
        thumbnail.fileId
    );

    url.searchParams.set(
        "size",
        String(
            thumbnail.fileSize || 0
        )
    );

    /*
     * Telegram thumbnails are served as JPEG here.
     * This is important because otherwise Firefox sees
     * application/octet-stream and downloads the thumbnail.
     */
    url.searchParams.set(
        "type",
        "image/jpeg"
    );

    return url.toString();
}

async function getChatMessagesApi(
    env,
    chatId,
    request
) {
    const client =
        await getTelegramClient(env);

    try {
        const messages =
            await getMessages(
                client,
                chatId
            );

        return messages.map(
            message => {
                const media =
                    getMessageMediaInfo(
                        message
                    );

                const result = {
                    id: message.id,
                    type:
                        message.type,
                    text:
                        message.text ||
                        message.caption ||
                        "",
                    date:
                        message.date ||
                        null
                };

                if (media) {
                    result.media =
                        media;

                    result.media.url =
                        buildMediaUrl(
                            request,
                            {
                                ...media,
                                type:
                                    media.type
                            }
                        );

                    result.media.thumbnails =
                        media.thumbnails.map(
                            thumbnail => ({
                                ...thumbnail,
                                url:
                                    buildThumbnailUrl(
                                        request,
                                        thumbnail
                                    )
                            })
                        );
                }

                return result;
            }
        );
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

function escapeHtml(value) {
    return String(value)
        .replaceAll(
            "&",
            "&amp;"
        )
        .replaceAll(
            "<",
            "&lt;"
        )
        .replaceAll(
            ">",
            "&gt;"
        )
        .replaceAll(
            '"',
            "&quot;"
        )
        .replaceAll(
            "'",
            "&#39;"
        );
}

function escapeAttribute(value) {
    return escapeHtml(value);
}

function getMessageName(message) {
    const media =
        message.media;

    if (
        media?.fileName
    ) {
        return media.fileName;
    }

    if (
        media?.type
    ) {
        return media.type;
    }

    return `Message ${message.id}`;
}

function renderSelectedMessage(
    message,
    request
) {
    const media =
        message.media;

    let body = `
<section>
<h2>Selected Message</h2>

<div>
<strong>Message ${escapeHtml(message.id)}</strong>
</div>

<div class="small">
Type: ${escapeHtml(message.type || "unknown")}
</div>
`;

    if (message.text) {
        body += `
<pre>${escapeHtml(message.text)}</pre>
`;
    }

    if (media) {
        body += `
<div class="info">
Media type:
${escapeHtml(media.type || "unknown")}
</div>
`;

        if (
            media.fileSize != null
        ) {
            body += `
<div class="info">
Size:
${escapeHtml(media.fileSize)} bytes
</div>
`;
        }

        if (
            media.fileName
        ) {
            body += `
<div class="info">
Filename:
${escapeHtml(media.fileName)}
</div>
`;
        }
    }

    body += `
</section>

<section>
<h2>Message content</h2>
`;

    if (media?.url) {
        body += `
<a href="${escapeAttribute(media.url)}"
   target="_blank"
   rel="noopener">
    Open full media${media.fileName ? ` — ${escapeHtml(media.fileName)}` : ""}
</a>
`;
    }

    if (
        media?.thumbnails?.length
    ) {
        media.thumbnails.forEach(
            (thumbnail, index) => {
                if (!thumbnail.url) {
                    return;
                }

                body += `
<a href="${escapeAttribute(thumbnail.url)}"
   target="_blank"
   rel="noopener">
    Open thumbnail ${index + 1}
</a>
`;
            }
        );
    }

    if (
        !media?.url &&
        !media?.thumbnails?.length
    ) {
        body += `
<div class="small">
This message has no downloadable media.
</div>
`;
    }

    body += `
</section>
`;

    body += `
<section>
<h2>API / diagnostics</h2>

<a href="${escapeAttribute(
        new URL(
            `/api/messages?chat=${encodeURIComponent(
                request.selectedChatId
            )}`,
            request.url
        ).toString()
    )}"
   target="_blank"
   rel="noopener">
    Open Messages API
</a>
`;

    if (media?.fileId) {
        const infoUrl =
            new URL(
                "/media-info",
                request.url
            );

        infoUrl.searchParams.set(
            "file",
            media.fileId
        );

        infoUrl.searchParams.set(
            "size",
            String(
                media.fileSize || 0
            )
        );

        if (media.mimeType) {
            infoUrl.searchParams.set(
                "type",
                media.mimeType
            );
        }

        if (media.fileName) {
            infoUrl.searchParams.set(
                "name",
                media.fileName
            );
        }

        const testUrl =
            new URL(
                "/test-download",
                request.url
            );

        testUrl.searchParams.set(
            "file",
            media.fileId
        );

        testUrl.searchParams.set(
            "size",
            String(
                media.fileSize || 0
            )
        );

        body += `
<a href="${escapeAttribute(infoUrl.toString())}"
   target="_blank"
   rel="noopener">
    Inspect media info
</a>

<a href="${escapeAttribute(testUrl.toString())}"
   target="_blank"
   rel="noopener">
    Test full Telegram download
</a>
`;
    }

    body += `
</section>
`;

    return body;
}

async function renderHome(
    request,
    env
) {
    const url =
        new URL(request.url);

    const selectedChatId =
        url.searchParams.get("chat") ||
        "";

    const selectedMessageId =
        url.searchParams.get("message") ||
        "";

    let chats = [];
    let messages = [];
    let error = null;

    try {
        chats =
            await getChatsApi(
                env
            );

        if (selectedChatId) {
            messages =
                await getChatMessagesApi(
                    env,
                    selectedChatId,
                    request
                );
        }
    } catch (err) {
        error =
            errorInfo(err);
    }

    let body = `
<h1>Telegram Media Test</h1>

<section>
<h2>Chat</h2>

<form method="get">
<label for="chat">
Select chat
</label>

<select
    id="chat"
    name="chat"
    onchange="this.form.submit()"
>
<option value="">
Select a chat
</option>
`;

    for (const chat of chats) {
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

        body += `
<option
    value="${escapeAttribute(chat.id)}"
    ${
        String(chat.id) ===
        String(selectedChatId)
            ? "selected"
            : ""
    }
>
${escapeHtml(name)}
</option>
`;
    }

    body += `
</select>
</form>
`;

    if (selectedChatId) {
        body += `
<div class="info">
Chat ID:
${escapeHtml(selectedChatId)}
</div>
`;
    }

    body += `
</section>
`;

    if (selectedChatId) {
        body += `
<section>
<h2>Message</h2>

<form method="get">
<input
    type="hidden"
    name="chat"
    value="${escapeAttribute(selectedChatId)}"
>

<select
    name="message"
    onchange="this.form.submit()"
>
<option value="">
Select a message
</option>
`;

        for (const message of messages) {
            body += `
<option
    value="${escapeAttribute(message.id)}"
    ${
        String(message.id) ===
        String(selectedMessageId)
            ? "selected"
            : ""
    }
>
${escapeHtml(
    `#${message.id} — ${getMessageName(message)}`
)}
</option>
`;
        }

        body += `
</select>
</form>
</section>
`;
    }

    if (error) {
        body += `
<section>
<h2 class="error">
Error
</h2>

<pre>${escapeHtml(
    JSON.stringify(
        error,
        null,
        2
    )
)}</pre>
</section>
`;
    }

    if (
        selectedChatId &&
        selectedMessageId &&
        !error
    ) {
        const selectedMessage =
            messages.find(
                message =>
                    String(message.id) ===
                    String(selectedMessageId)
            );

        if (selectedMessage) {
            const renderRequest =
                new Request(
                    request
                );

            renderRequest.selectedChatId =
                selectedChatId;

            body +=
                renderSelectedMessage(
                    selectedMessage,
                    renderRequest
                );
        }
    }

    body += `
<section>
<h2>API / diagnostics</h2>

<a href="${escapeAttribute(
        new URL(
            "/api/chats",
            request.url
        ).toString()
    )}"
   target="_blank"
   rel="noopener">
    Open Chats API
</a>
`;

    if (selectedChatId) {
        body += `
<a href="${escapeAttribute(
            new URL(
                `/api/chat?chat=${encodeURIComponent(
                    selectedChatId
                )}`,
                request.url
            ).toString()
        )}"
   target="_blank"
   rel="noopener">
    Open Chat API
</a>

<a href="${escapeAttribute(
            new URL(
                `/api/messages?chat=${encodeURIComponent(
                    selectedChatId
                )}`,
                request.url
            ).toString()
        )}"
   target="_blank"
   rel="noopener">
    Open Messages API
</a>
`;
    }

    body += `
</section>
`;

    return html(
        body
    );
}

async function main(
    request,
    env
) {
    const url =
        new URL(request.url);

    const pathname =
        url.pathname;

    if (
        pathname === "/" ||
        pathname === ""
    ) {
        return await renderHome(
            request,
            env
        );
    }

    if (
        pathname === "/api/chats" ||
        pathname === "/api/chats/"
    ) {
        try {
            const chats =
                await getChatsApi(
                    env
                );

            return json({
                success: true,
                chats
            });
        } catch (error) {
            return json(
                errorInfo(error),
                500
            );
        }
    }

    if (
        pathname === "/api/chat" ||
        pathname === "/api/chat/"
    ) {
        const chatId =
            url.searchParams.get(
                "chat"
            );

        if (!chatId) {
            return json({
                success: false,
                error:
                    "Missing chat parameter."
            }, 400);
        }

        const client =
            await getTelegramClient(
                env
            );

        try {
            const chat =
                await getChatForId(
                    client,
                    chatId
                );

            return json({
                success: true,
                chat
            });
        } catch (error) {
            return json(
                errorInfo(error),
                500
            );
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
    }

    if (
        pathname === "/api/messages" ||
        pathname === "/api/messages/"
    ) {
        const chatId =
            url.searchParams.get(
                "chat"
            );

        if (!chatId) {
            return json({
                success: false,
                error:
                    "Missing chat parameter."
            }, 400);
        }

        try {
            const messages =
                await getChatMessagesApi(
                    env,
                    chatId,
                    request
                );

            return json({
                success: true,
                chatId:
                    Number(chatId),
                messages
            });
        } catch (error) {
            return json(
                errorInfo(error),
                500
            );
        }
    }

    if (
        pathname === "/media-info" ||
        pathname === "/media-info/"
    ) {
        const fileId =
            url.searchParams.get(
                "file"
            );

        if (!fileId) {
            return json({
                success: false,
                error:
                    "Missing file parameter."
            }, 400);
        }

        return json({
            success: true,
            fileId,
            size:
                url.searchParams.get(
                    "size"
                ),
            type:
                url.searchParams.get(
                    "type"
                ),
            name:
                url.searchParams.get(
                    "name"
                )
        });
    }

    if (
        pathname === "/test-download" ||
        pathname === "/test-download/"
    ) {
        try {
            return await testDownload(
                request,
                env
            );
        } catch (error) {
            return json(
                errorInfo(error),
                500
            );
        }
    }

    if (
        pathname === "/media" ||
        pathname === "/media/"
    ) {
        try {
            return await handleDirectMediaRequest(
                request,
                env
            );
        } catch (error) {
            return json(
                errorInfo(error),
                500
            );
        }
    }

    const legacyMatch =
        /^\/media\/(-?\d+)\/(\d+)$/.exec(
            pathname
        );

    if (legacyMatch) {
        try {
            return await handleLegacyMediaRequest(
                request,
                env,
                legacyMatch[1],
                legacyMatch[2]
            );
        } catch (error) {
            return json(
                errorInfo(error),
                500
            );
        }
    }

    return new Response(
        "Not found",
        {
            status: 404
        }
    );
}

export default {
    async fetch(
        request,
        env
    ) {
        return await main(
            request,
            env
        );
    }
};
