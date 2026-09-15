import {
    Client
} from "@mtkruto/mtkruto";

function json(
    data,
    status = 200
) {

    return new Response(
        JSON.stringify(
            data,
            null,
            2
        ),
        {
            status,
            headers: {
                "Content-Type":
                    "application/json; charset=utf-8"
            }
        }
    );
}

function html(
    body
) {

    return new Response(
        body,
        {
            headers: {
                "Content-Type":
                    "text/html; charset=utf-8"
            }
        }
    );
}

function errorInfo(
    error
) {

    return {
        error:
            error?.message ||
            String(error),

        name:
            error?.name ||
            null,

        stack:
            error?.stack ||
            null
    };
}

async function getTelegramClient(
    env
) {

    const apiId =
        Number(
            await env.API_ID.get()
        );

    const apiHash =
        await env.API_HASH.get();

    const authString =
        await env.MTKRUTO_SESSION.get();

    const client =
        new Client({
            apiId,

            apiHash,

            authString,

            persistCache:
                false,

            defaultHandlers:
                false,

            disableUpdates:
                true
        });

    await client.connect();

    return client;
}

function getMessageMedia(
    message
) {

    switch (
        message?.type
    ) {

        case "photo":
        case "livePhoto":
            return message.photo || null;

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

function getMediaThumbnails(
    media
) {

    if (
        Array.isArray(
            media?.thumbnails
        )
    ) {

        return media.thumbnails;
    }

    if (
        media?.thumbnail
    ) {

        return [
            media.thumbnail
        ];
    }

    return [];
}

function getMessageMediaInfo(
    message
) {

    const media =
        getMessageMedia(
            message
        );

    if (!media) {

        return {
            hasMedia:
                false,

            type:
                null,

            fileId:
                null,

            fileUniqueId:
                null,

            fileSize:
                0,

            fileName:
                null,

            mimeType:
                null,

            width:
                null,

            height:
                null,

            duration:
                null,

            thumbnails:
                []
        };
    }

    const thumbnails =
        getMediaThumbnails(
            media
        );

    return {
        hasMedia:
            true,

        type:
            media.type ||
            message.type ||
            null,

        fileId:
            media.fileId ||
            null,

        fileUniqueId:
            media.fileUniqueId ||
            null,

        fileSize:
            Number(
                media.fileSize ||
                0
            ),

        fileName:
            media.fileName ||
            null,

        mimeType:
            media.mimeType ||
            null,

        width:
            media.width ||
            null,

        height:
            media.height ||
            null,

        duration:
            media.duration ||
            null,

        thumbnails:
            thumbnails.map(
                (
                    thumbnail,
                    index
                ) => ({

                    index,

                    fileId:
                        thumbnail.fileId ||
                        null,

                    fileUniqueId:
                        thumbnail.fileUniqueId ||
                        null,

                    width:
                        thumbnail.width ||
                        null,

                    height:
                        thumbnail.height ||
                        null,

                    fileSize:
                        Number(
                            thumbnail.fileSize ||
                            0
                        )
                })
            )
    };
}

function detectImageMimeType(
    bytes
) {

    if (
        !bytes ||
        bytes.byteLength < 4
    ) {

        return null;
    }

    const b =
        bytes instanceof Uint8Array
            ? bytes
            : new Uint8Array(
                bytes
            );

    if (
        b[0] === 0xFF &&
        b[1] === 0xD8 &&
        b[2] === 0xFF
    ) {

        return "image/jpeg";
    }

    if (
        b.length >= 8 &&
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4E &&
        b[3] === 0x47 &&
        b[4] === 0x0D &&
        b[5] === 0x0A &&
        b[6] === 0x1A &&
        b[7] === 0x0A
    ) {

        return "image/png";
    }

    if (
        b[0] === 0x47 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x38
    ) {

        return "image/gif";
    }

    if (
        b.length >= 12 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
    ) {

        return "image/webp";
    }

    if (
        b.length >= 12 &&
        b[4] === 0x66 &&
        b[5] === 0x74 &&
        b[6] === 0x79 &&
        b[7] === 0x70
    ) {

        const brand =
            String.fromCharCode(
                b[8],
                b[9],
                b[10],
                b[11]
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

async function getChatList(
    client
) {

    const chats =
        await client.getChats({
            from:
                "main",

            limit:
                100
        });

    return chats.map(
        item => {

            const chat =
                item.chat;

            let title;

            if (
                chat.title
            ) {

                title =
                    chat.title;

            } else {

                title =
                    [
                        chat.firstName,
                        chat.lastName
                    ]
                        .filter(
                            Boolean
                        )
                        .join(
                            " "
                        );
            }

            return {
                id:
                    String(
                        chat.id
                    ),

                title:
                    title ||
                    String(
                        chat.id
                    ),

                type:
                    chat.type ||
                    null,

                username:
                    chat.username ||
                    null
            };
        }
    );
}

async function getMessages(
    client,
    chatId,
    requestUrl
) {

    try {

        const numericChatId =
            Number(
                chatId
            );

        if (
            !Number.isSafeInteger(
                numericChatId
            )
        ) {

            throw new Error(
                `Invalid numeric chat ID: ${chatId}`
            );
        }

        /*
         * Keep the known-working getChats()
         * resolution here.
         *
         * This is intentionally NOT cached
         * globally because the MTKruto client
         * itself is request-scoped.
         */

        const chats =
            await client.getChats({
                from:
                    "main",

                limit:
                    100
            });

        const chatItem =
            chats.find(
                item =>
                    Number(
                        item.chat.id
                    ) ===
                    numericChatId
            );

        if (!chatItem) {

            throw new Error(
                `Chat ${numericChatId} was not found in MTKruto getChats().`
            );
        }

        const chat =
            chatItem.chat;

        await client.getInputPeer(
            chat.id
        );

        const messages =
            await client.getHistory(
                chat.id,
                {
                    limit:
                        100
                }
            );

        const origin =
            new URL(
                requestUrl
            ).origin;

        return {
            success:
                true,

            chatId:
                String(
                    chat.id
                ),

            chatTitle:
                chat.title ||
                [
                    chat.firstName,
                    chat.lastName
                ]
                    .filter(
                        Boolean
                    )
                    .join(
                        " "
                    ) ||
                null,

            chatType:
                chat.type ||
                null,

            count:
                messages.length,

            messages:
                messages.map(
                    message => {

                        const media =
                            getMessageMediaInfo(
                                message
                            );

                        let mediaUrl =
                            null;

                        if (
                            media.fileId
                        ) {

                            mediaUrl =
                                `${origin}/media/` +
                                `${encodeURIComponent(
                                    chat.id
                                )}/` +
                                `${encodeURIComponent(
                                    message.id
                                )}`;
                        }

                        const thumbnailUrls =
                            media.thumbnails.map(
                                thumbnail => ({

                                    index:
                                        thumbnail.index,

                                    fileId:
                                        thumbnail.fileId,

                                    fileUniqueId:
                                        thumbnail.fileUniqueId,

                                    width:
                                        thumbnail.width,

                                    height:
                                        thumbnail.height,

                                    fileSize:
                                        thumbnail.fileSize,

                                    url:
                                        thumbnail.fileId
                                            ? `${origin}/media/` +
                                              `${encodeURIComponent(
                                                  chat.id
                                              )}/` +
                                              `${encodeURIComponent(
                                                  message.id
                                              )}?thumb=${thumbnail.index}`
                                            : null
                                })
                            );

                        return {
                            id:
                                String(
                                    message.id
                                ),

                            type:
                                message.type ||
                                null,

                            date:
                                message.date
                                    ? new Date(
                                        message.date
                                    ).toISOString()
                                    : null,

                            text:
                                message.text ||
                                message.caption ||
                                "",

                            link:
                                message.link ||
                                null,

                            hasMedia:
                                media.hasMedia,

                            mediaType:
                                media.type,

                            fileId:
                                media.fileId,

                            fileUniqueId:
                                media.fileUniqueId,

                            fileSize:
                                media.fileSize,

                            fileName:
                                media.fileName,

                            mimeType:
                                media.mimeType,

                            width:
                                media.width,

                            height:
                                media.height,

                            duration:
                                media.duration,

                            mediaUrl,

                            thumbnails:
                                thumbnailUrls
                        };
                    }
                )
        };

    } catch (
        error
    ) {

        return {
            success:
                false,

            chatId:
                String(
                    chatId
                ),

            error:
                error?.message ||
                String(
                    error
                ),

            name:
                error?.name ||
                null,

            stack:
                error?.stack ||
                null
        };
    }
}

async function handleMediaRequest(
    request,
    env,
    chatId,
    messageId
) {

    const numericChatId =
        Number(
            chatId
        );

    const numericMessageId =
        Number(
            messageId
        );

    if (
        !Number.isSafeInteger(
            numericChatId
        )
    ) {

        return new Response(
            "Invalid chat ID.",
            {
                status: 400
            }
        );
    }

    if (
        !Number.isSafeInteger(
            numericMessageId
        )
    ) {

        return new Response(
            "Invalid message ID.",
            {
                status: 400
            }
        );
    }

    const client =
        await getTelegramClient(
            env
        );

    /*
     * Unlike /api/messages, do not call
     * getChats() here.
     *
     * This is important for video seeking:
     * every Range request can go directly
     * through getInputPeer() and getMessage().
     */

    await client.getInputPeer(
        numericChatId
    );

    const message =
        await client.getMessage(
            numericChatId,
            numericMessageId
        );

    if (!message) {

        return new Response(
            "Message not found.",
            {
                status: 404
            }
        );
    }

    const media =
        getMessageMedia(
            message
        );

    if (!media) {

        return new Response(
            "Message has no supported media.",
            {
                status: 404
            }
        );
    }

    const url =
        new URL(
            request.url
        );

    const thumbParam =
        url.searchParams.get(
            "thumb"
        );

    let fileId =
        media.fileId;

    let contentType =
        media.mimeType ||
        "application/octet-stream";

    let fileSize =
        Number(
            media.fileSize ||
            0
        );

    let isThumbnail =
        false;

    if (
        thumbParam !== null
    ) {

        const thumbIndex =
            Number(
                thumbParam
            );

        const thumbnails =
            getMediaThumbnails(
                media
            );

        if (
            !Number.isInteger(
                thumbIndex
            ) ||
            thumbIndex < 0 ||
            thumbIndex >=
                thumbnails.length
        ) {

            return new Response(
                "Thumbnail not found.",
                {
                    status: 404
                }
            );
        }

        const thumbnail =
            thumbnails[
                thumbIndex
            ];

        if (
            !thumbnail.fileId
        ) {

            return new Response(
                "Thumbnail has no file ID.",
                {
                    status: 404
                }
            );
        }

        fileId =
            thumbnail.fileId;

        fileSize =
            Number(
                thumbnail.fileSize ||
                0
            );

        isThumbnail =
            true;
    }

    if (!fileId) {

        return new Response(
            "Media has no downloadable file ID.",
            {
                status: 404
            }
        );
    }

    if (
        !Number.isFinite(
            fileSize
        ) ||
        fileSize < 0
    ) {

        return new Response(
            "Media has an invalid file size.",
            {
                status: 500
            }
        );
    }

    const rangeHeader =
        request.headers.get(
            "Range"
        );

    let rangeStart =
        0;

    let rangeEnd =
        fileSize - 1;

    let status =
        200;

    if (
        rangeHeader
    ) {

        const match =
            rangeHeader.match(
                /^bytes=(\d*)-(\d*)$/
            );

        if (!match) {

            return new Response(
                "Invalid Range.",
                {
                    status: 416,

                    headers: {
                        "Content-Range":
                            `bytes */${fileSize}`
                    }
                }
            );
        }

        if (
            match[1]
        ) {

            rangeStart =
                Number(
                    match[1]
                );
        }

        if (
            match[2]
        ) {

            rangeEnd =
                Number(
                    match[2]
                );

        } else {

            rangeEnd =
                fileSize - 1;
        }

        if (
            !match[1] &&
            match[2]
        ) {

            const requestedLength =
                Number(
                    match[2]
                );

            rangeStart =
                Math.max(
                    0,
                    fileSize -
                    requestedLength
                );

            rangeEnd =
                fileSize - 1;
        }

        if (
            !Number.isSafeInteger(
                rangeStart
            ) ||
            !Number.isSafeInteger(
                rangeEnd
            ) ||
            rangeStart > rangeEnd ||
            rangeStart >= fileSize
        ) {

            return new Response(
                "Requested range not satisfiable.",
                {
                    status: 416,

                    headers: {
                        "Content-Range":
                            `bytes */${fileSize}`
                    }
                }
            );
        }

        rangeEnd =
            Math.min(
                rangeEnd,
                fileSize - 1
            );

        status =
            206;
    }

    const responseLength =
        fileSize === 0
            ? 0
            : rangeEnd -
              rangeStart +
              1;

    const headers =
        new Headers();

    headers.set(
        "Content-Type",
        contentType
    );

    headers.set(
        "Accept-Ranges",
        "bytes"
    );

    headers.set(
        "Content-Length",
        String(
            responseLength
        )
    );

    headers.set(
        "Cache-Control",
        "public, max-age=31536000, immutable"
    );

    if (
        status === 206
    ) {

        headers.set(
            "Content-Range",
            `bytes ${rangeStart}-${rangeEnd}/${fileSize}`
        );
    }

    if (
        request.method ===
        "HEAD"
    ) {

        return new Response(
            null,
            {
                status,
                headers
            }
        );
    }

    const iterator =
        client.download(
            fileId,
            {
                offset:
                    rangeStart,

                signal:
                    request.signal
            }
        );

    /*
     * For thumbnails, inspect the first
     * downloaded bytes before sending them.
     *
     * The bytes are then immediately placed
     * back into the HTTP stream, so detection
     * does not discard anything.
     */

    let firstChunk =
        null;

    if (
        isThumbnail
    ) {

        const firstResult =
            await iterator.next();

        if (
            firstResult.done
        ) {

            return new Response(
                "Thumbnail download returned no data.",
                {
                    status: 502
                }
            );
        }

        firstChunk =
            firstResult.value;

        const detectedType =
            detectImageMimeType(
                firstChunk
            );

        if (
            detectedType
        ) {

            contentType =
                detectedType;

        } else if (
            !contentType ||
            contentType ===
                "application/octet-stream"
        ) {

            contentType =
                "image/jpeg";
        }

        headers.set(
            "Content-Type",
            contentType
        );
    }

    let bytesSent =
        0;

    const stream =
        new ReadableStream({

            async start(
                controller
            ) {

                try {

                    if (
                        firstChunk
                    ) {

                        let chunk =
                            firstChunk;

                        const remaining =
                            responseLength -
                            bytesSent;

                        if (
                            chunk.byteLength >
                            remaining
                        ) {

                            chunk =
                                chunk.slice(
                                    0,
                                    remaining
                                );
                        }

                        if (
                            chunk.byteLength
                        ) {

                            controller.enqueue(
                                chunk
                            );

                            bytesSent +=
                                chunk.byteLength;
                        }

                        if (
                            bytesSent >=
                            responseLength
                        ) {

                            controller.close();

                            return;
                        }
                    }

                    for await (
                        const chunk
                        of iterator
                    ) {

                        if (
                            bytesSent >=
                            responseLength
                        ) {

                            break;
                        }

                        const remaining =
                            responseLength -
                            bytesSent;

                        let output =
                            chunk;

                        if (
                            output.byteLength >
                            remaining
                        ) {

                            output =
                                output.slice(
                                    0,
                                    remaining
                                );
                        }

                        if (
                            output.byteLength
                        ) {

                            controller.enqueue(
                                output
                            );

                            bytesSent +=
                                output.byteLength;
                        }

                        if (
                            bytesSent >=
                            responseLength
                        ) {

                            break;
                        }
                    }

                    controller.close();

                } catch (
                    error
                ) {

                    controller.error(
                        error
                    );
                }
            }
        });

    return new Response(
        stream,
        {
            status,
            headers
        }
    );
}

async function testDownload(
    request,
    env,
    chatId,
    messageId
) {

    const started =
        Date.now();

    const client =
        await getTelegramClient(
            env
        );

    const numericChatId =
        Number(
            chatId
        );

    const numericMessageId =
        Number(
            messageId
        );

    await client.getInputPeer(
        numericChatId
    );

    const message =
        await client.getMessage(
            numericChatId,
            numericMessageId
        );

    if (!message) {

        throw new Error(
            `Telegram message not found: ${messageId}`
        );
    }

    const media =
        getMessageMediaInfo(
            message
        );

    if (!media.fileId) {

        throw new Error(
            "The selected message does not contain downloadable media."
        );
    }

    if (!media.fileSize) {

        throw new Error(
            "MTKruto returned media without a file size."
        );
    }

    let bytes =
        0;

    let chunks =
        0;

    const iterator =
        client.download(
            media.fileId,
            {
                signal:
                    request.signal
            }
        );

    for await (
        const chunk
        of iterator
    ) {

        if (
            request.signal.aborted
        ) {

            return json(
                {
                    success:
                        false,

                    aborted:
                        true,

                    bytesDownloaded:
                        bytes,

                    chunks,

                    fileSize:
                        media.fileSize,

                    elapsedMs:
                        Date.now() -
                        started
                },
                499
            );
        }

        bytes +=
            chunk.byteLength;

        chunks++;
    }

    return json({
        success:
            true,

        test:
            "mtkruto-download-discard",

        chatId:
            String(
                chatId
            ),

        messageId:
            String(
                messageId
            ),

        fileId:
            media.fileId,

        fileSize:
            media.fileSize,

        bytesDownloaded:
            bytes,

        chunks,

        elapsedMs:
            Date.now() -
            started
    });
}

async function handleRequest(
    request,
    env
) {

    const url =
        new URL(
            request.url
        );

    const path =
        url.pathname;

    if (
        path === "/"
    ) {

        return html(`
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<title>
MTKruto Telegram Test
</title>

<style>

body {
    font-family: sans-serif;
    max-width: 900px;
    margin: 40px auto;
    padding: 0 20px;
}

select {
    width: 100%;
    max-width: 750px;
    padding: 8px;
    margin: 6px 0 16px;
}

a {
    display: inline-block;
    margin: 8px 12px 8px 0;
}

pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: #f4f4f4;
    padding: 12px;
}

.status {
    margin: 15px 0;
    font-weight: bold;
}

</style>

</head>

<body>

<h1>
MTKruto Telegram Test
</h1>

<div
    class="status"
    id="status"
>
Loading chats...
</div>

<label>
Chat
</label>

<select id="chat">
</select>

<label>
Message
</label>

<select id="message">
</select>

<div id="buttons">
</div>

<pre id="info">
</pre>

<script>

const chatSelect =
    document.getElementById(
        "chat"
    );

const messageSelect =
    document.getElementById(
        "message"
    );

const status =
    document.getElementById(
        "status"
    );

const info =
    document.getElementById(
        "info"
    );

const buttons =
    document.getElementById(
        "buttons"
    );

let chats = [];

let messages = [];

async function loadChats() {

    status.textContent =
        "Loading chats...";

    const response =
        await fetch(
            "/api/chats"
        );

    const text =
        await response.text();

    let data;

    try {

        data =
            JSON.parse(
                text
            );

    } catch {

        throw new Error(
            "Non-JSON response from /api/chats:\\n\\n" +
            text
        );
    }

    if (!response.ok) {

        throw new Error(
            JSON.stringify(
                data,
                null,
                2
            )
        );
    }

    if (
        !Array.isArray(
            data
        )
    ) {

        throw new Error(
            "Unexpected /api/chats response:\\n\\n" +
            JSON.stringify(
                data,
                null,
                2
            )
        );
    }

    chats =
        data;

    chatSelect.innerHTML =
        "";

    for (
        const chat
        of chats
    ) {

        const option =
            document.createElement(
                "option"
            );

        option.value =
            chat.id;

        option.textContent =
            chat.title +
            " [" +
            (
                chat.type ||
                "unknown"
            ) +
            "] — ID: " +
            chat.id;

        chatSelect.appendChild(
            option
        );
    }

    status.textContent =
        chats.length +
        " chats loaded.";

    await loadMessages();
}

async function loadMessages() {

    const chatId =
        chatSelect.value;

    if (!chatId) {

        return;
    }

    status.textContent =
        "Loading messages...";

    buttons.innerHTML =
        "";

    const apiLink =
        document.createElement(
            "a"
        );

    apiLink.href =
        "/api/messages?chatId=" +
        encodeURIComponent(
            chatId
        );

    apiLink.target =
        "_blank";

    apiLink.textContent =
        "Open Messages API";

    buttons.appendChild(
        apiLink
    );

    const chatLink =
        document.createElement(
            "a"
        );

    chatLink.href =
        "/api/chat?chatId=" +
        encodeURIComponent(
            chatId
        );

    chatLink.target =
        "_blank";

    chatLink.textContent =
        "Open Chat API";

    buttons.appendChild(
        chatLink
    );

    try {

        const response =
            await fetch(
                "/api/messages?chatId=" +
                encodeURIComponent(
                    chatId
                )
            );

        const text =
            await response.text();

        let data;

        try {

            data =
                JSON.parse(
                    text
                );

        } catch {

            throw new Error(
                "Non-JSON response:\\n\\n" +
                text
            );
        }

        info.textContent =
            JSON.stringify(
                data,
                null,
                2
            );

        if (
            !response.ok ||
            data.success === false
        ) {

            status.textContent =
                "MESSAGE ERROR";

            messages =
                [];

            messageSelect.innerHTML =
                "";

            return;
        }

        messages =
            data.messages ||
            [];

        messageSelect.innerHTML =
            "";

        for (
            const message
            of messages
        ) {

            const option =
                document.createElement(
                    "option"
                );

            option.value =
                message.id;

            let label =
                "#" +
                message.id;

            if (
                message.fileName
            ) {

                label +=
                    " " +
                    message.fileName;

            } else if (
                message.text
            ) {

                label +=
                    " " +
                    message.text
                        .replace(
                            /\s+/g,
                            " "
                        )
                        .slice(
                            0,
                            100
                        );

            } else if (
                message.mediaType
            ) {

                label +=
                    " [" +
                    message.mediaType +
                    "]";

            } else if (
                message.type
            ) {

                label +=
                    " [" +
                    message.type +
                    "]";
            }

            option.textContent =
                label;

            messageSelect.appendChild(
                option
            );
        }

        status.textContent =
            data.count +
            " messages loaded. Chat ID: " +
            data.chatId;

        updateMessage();

    } catch (
        error
    ) {

        status.textContent =
            "MESSAGE LOAD ERROR";

        info.textContent =
            error.stack ||
            String(
                error
            );
    }
}

function updateMessage() {

    const message =
        messages.find(
            item =>
                String(
                    item.id
                ) ===
                String(
                    messageSelect.value
                )
        );

    if (!message) {

        info.textContent =
            "";

        buttons.innerHTML =
            "";

        return;
    }

    info.textContent =
        JSON.stringify(
            message,
            null,
            2
        );

    buttons.innerHTML =
        "";

    if (
        message.mediaUrl
    ) {

        const media =
            document.createElement(
                "a"
            );

        media.href =
            message.mediaUrl;

        media.target =
            "_blank";

        media.textContent =
            "Open media";

        buttons.appendChild(
            media
        );
    }

    if (
        message.thumbnails &&
        message.thumbnails.length
    ) {

        for (
            const thumbnail
            of message.thumbnails
        ) {

            if (
                !thumbnail.url
            ) {

                continue;
            }

            const link =
                document.createElement(
                    "a"
            );

            link.href =
                thumbnail.url;

            link.target =
                "_blank";

            link.textContent =
                "Thumbnail " +
                thumbnail.index +
                " (" +
                thumbnail.width +
                "×" +
                thumbnail.height +
                ")";

            buttons.appendChild(
                link
            );
        }
    }

    if (
        message.fileId
    ) {

        const test =
            document.createElement(
                "a"
            );

        test.href =
            "/test-download/" +
            encodeURIComponent(
                chatSelect.value
            ) +
            "/" +
            encodeURIComponent(
                message.id
            );

        test.target =
            "_blank";

        test.textContent =
            "Test full download";

        buttons.appendChild(
            test
        );
    }
}

chatSelect.addEventListener(
    "change",
    () => {

        loadMessages()
            .catch(
                error => {

                    status.textContent =
                        "ERROR";

                    info.textContent =
                        error.stack ||
                        String(
                            error
                        );
                }
            );
    }
);

messageSelect.addEventListener(
    "change",
    updateMessage
);

loadChats()
    .catch(
        error => {

            status.textContent =
                "LOAD CHATS ERROR";

            info.textContent =
                error.stack ||
                String(
                    error
                );
        }
    );

</script>

</body>

</html>
        `);
    }

    if (
        path === "/api/chats"
    ) {

        const client =
            await getTelegramClient(
                env
            );

        return json(
            await getChatList(
                client
            )
        );
    }

    if (
        path === "/api/chat"
    ) {

        const chatId =
            url.searchParams.get(
                "chatId"
            );

        if (!chatId) {

            return json(
                {
                    success:
                        false,

                    error:
                        "Missing chatId."
                },
                400
            );
        }

        try {

            const client =
                await getTelegramClient(
                    env
                );

            const numericChatId =
                Number(
                    chatId
                );

            await client.getInputPeer(
                numericChatId
            );

            const chats =
                await client.getChats({
                    from:
                        "main",

                    limit:
                        100
                });

            const chatItem =
                chats.find(
                    item =>
                        Number(
                            item.chat.id
                        ) ===
                        numericChatId
                );

            if (!chatItem) {

                throw new Error(
                    `Chat ${chatId} was not found.`
                );
            }

            const chat =
                chatItem.chat;

            return json({
                success:
                    true,

                requestedChatId:
                    chatId,

                chat
            });

        } catch (
            error
        ) {

            return json(
                {
                    success:
                        false,

                    requestedChatId:
                        chatId,

                    error:
                        error?.message ||
                        String(
                            error
                        ),

                    name:
                        error?.name ||
                        null,

                    stack:
                        error?.stack ||
                        null
                },
                500
            );
        }
    }

    if (
        path === "/api/messages"
    ) {

        const chatId =
            url.searchParams.get(
                "chatId"
            );

        if (!chatId) {

            return json(
                {
                    success:
                        false,

                    error:
                        "Missing chatId."
                },
                400
            );
        }

        const client =
            await getTelegramClient(
                env
            );

        const result =
            await getMessages(
                client,
                chatId,
                request.url
            );

        return json(
            result,
            result.success
                ? 200
                : 500
        );
    }

    const mediaMatch =
        path.match(
            /^\/media\/([^/]+)\/([^/]+)$/
        );

    if (mediaMatch) {

        return handleMediaRequest(
            request,
            env,
            decodeURIComponent(
                mediaMatch[1]
            ),
            decodeURIComponent(
                mediaMatch[2]
            )
        );
    }

    const testMatch =
        path.match(
            /^\/test-download\/([^/]+)\/([^/]+)$/
        );

    if (testMatch) {

        return testDownload(
            request,
            env,
            decodeURIComponent(
                testMatch[1]
            ),
            decodeURIComponent(
                testMatch[2]
            )
        );
    }

    return new Response(
        "Not Found",
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

        try {

            return await handleRequest(
                request,
                env
            );

        } catch (error) {

            return json(
                errorInfo(
                    error
                ),
                500
            );
        }
    }
};
