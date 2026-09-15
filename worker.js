import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import bigInt from "big-integer";

async function getTelegramClient(env) {

    const apiId =
        Number(
            await env.API_ID.get()
        );

    const apiHash =
        await env.API_HASH.get();

    const session =
        await env.TELEGRAM_SESSION.get();

    const client =
        new TelegramClient(
            new StringSession(session),
            apiId,
            apiHash,
            {
                connectionRetries: 5
            }
        );

    await client.connect();

    return client;
}

function json(data, status = 200) {

    return new Response(
        JSON.stringify(data, null, 2),
        {
            status,
            headers: {
                "Content-Type":
                    "application/json; charset=utf-8"
            }
        }
    );
}

function html(body) {

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

function errorInfo(error) {

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

function getPhotoSizes(message) {

    const sizes =
        message?.media?.photo?.sizes ||
        message?.media?.sizes ||
        [];

    return sizes
        .filter(
            size =>
                size &&
                (
                    size.className ===
                        "PhotoSize" ||
                    size.className ===
                        "PhotoCachedSize"
                )
        )
        .sort(
            (a, b) =>
                (a.w * a.h) -
                (b.w * b.h)
        );
}

function getLargestPhotoSize(message) {

    const sizes =
        getPhotoSizes(message);

    return sizes.length
        ? sizes[sizes.length - 1]
        : null;
}

function getThumbnailPhotoSize(message) {

    const sizes =
        getPhotoSizes(message);

    return sizes.length
        ? sizes[0]
        : null;
}

function getMediaInfo(message) {

    if (!message?.media) {

        return {
            supported: false,
            type: null,
            size: 0,
            hasThumbnail: false
        };
    }

    if (
        message.media.document
    ) {

        const document =
            message.media.document;

        const thumbnail =
            document.thumbs?.find(
                thumb =>
                    thumb &&
                    (
                        thumb.className ===
                            "PhotoSize" ||
                        thumb.className ===
                            "PhotoCachedSize"
                    )
            ) || null;

        return {
            supported: true,
            type: "document",
            size:
                Number(
                    document.size ||
                    0
                ),
            hasThumbnail:
                !!thumbnail
        };
    }

    if (
        message.media.photo
    ) {

        const largest =
            getLargestPhotoSize(
                message
            );

        return {
            supported:
                !!largest,

            type:
                "photo",

            size:
                Number(
                    largest?.size ||
                    0
                ),

            hasThumbnail:
                getPhotoSizes(
                    message
                ).length > 1
        };
    }

    return {
        supported: false,
        type:
            message.media.className ||
            null,
        size: 0,
        hasThumbnail: false
    };
}

async function findTelegramMessage(
    client,
    chatId,
    messageId
) {

    const dialogs =
        await client.getDialogs({
            limit: undefined
        });

    const wantedChatId =
        String(chatId);

    const dialog =
        dialogs.find(
            item =>
                String(
                    item.id
                ) === wantedChatId
        );

    if (!dialog) {

        throw new Error(
            `Telegram chat not found: ${chatId}`
        );
    }

    const messages =
        await client.getMessages(
            dialog,
            {
                ids:
                    Number(messageId)
            }
        );

    const message =
        messages?.[0];

    if (!message) {

        throw new Error(
            `Telegram message not found: ${messageId}`
        );
    }

    return {
        dialog,
        message
    };
}

function getDocumentLocation(
    document,
    thumbSize = ""
) {

    return new Api.InputDocumentFileLocation({
        id:
            document.id,

        accessHash:
            document.accessHash,

        fileReference:
            document.fileReference,

        thumbSize
    });
}

function getPhotoLocation(
    photo,
    size
) {

    return new Api.InputPhotoFileLocation({
        id:
            photo.id,

        accessHash:
            photo.accessHash,

        fileReference:
            photo.fileReference,

        thumbSize:
            size?.type || ""
    });
}

function getMediaDownloadInfo(
    message,
    thumbnail = false
) {

    if (
        message?.media?.document
    ) {

        const document =
            message.media.document;

        let thumb = null;

        if (thumbnail) {

            thumb =
                document.thumbs?.find(
                    item =>
                        item &&
                        (
                            item.className ===
                                "PhotoSize" ||
                            item.className ===
                                "PhotoCachedSize"
                        )
                );
        }

        if (thumb) {

            return {
                location:
                    getDocumentLocation(
                        document,
                        thumb.type || ""
                    ),

                size:
                    Number(
                        thumb.size ||
                        0
                    ),

                mimeType:
                    "image/jpeg",

                source:
                    "document-thumbnail"
            };
        }

        return {
            location:
                getDocumentLocation(
                    document
                ),

            size:
                Number(
                    document.size ||
                    0
                ),

            mimeType:
                document.mimeType ||
                "application/octet-stream",

            source:
                "document"
        };
    }

    if (
        message?.media?.photo
    ) {

        const sizes =
            getPhotoSizes(
                message
            );

        if (!sizes.length) {

            throw new Error(
                "Telegram photo has no downloadable PhotoSize."
            );
        }

        const size =
            thumbnail
                ? sizes[0]
                : sizes[sizes.length - 1];

        return {
            location:
                getPhotoLocation(
                    message.media.photo,
                    size
                ),

            size:
                Number(
                    size.size ||
                    0
                ),

            mimeType:
                "image/jpeg",

            source:
                "photo"
        };
    }

    throw new Error(
        "Unsupported Telegram media type."
    );
}

function parseRange(
    request,
    fileSize
) {

    const header =
        request.headers.get(
            "Range"
        );

    if (!header) {

        return {
            start: 0,
            end:
                fileSize - 1
        };
    }

    const match =
        /^bytes=(\d*)-(\d*)$/i.exec(
            header
        );

    if (!match) {

        return null;
    }

    const startText =
        match[1];

    const endText =
        match[2];

    let start;
    let end;

    if (!startText) {

        const suffix =
            Number(endText);

        if (
            !Number.isFinite(
                suffix
            ) ||
            suffix <= 0
        ) {
            return null;
        }

        start =
            Math.max(
                0,
                fileSize - suffix
            );

        end =
            fileSize - 1;

    } else {

        start =
            Number(startText);

        end =
            endText
                ? Number(endText)
                : fileSize - 1;
    }

    if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        start >= fileSize
    ) {
        return null;
    }

    end =
        Math.min(
            end,
            fileSize - 1
        );

    return {
        start,
        end
    };
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

    const {
        message
    } =
        await findTelegramMessage(
            client,
            chatId,
            messageId
        );

    const media =
        getMediaDownloadInfo(
            message,
            false
        );

    const fileSize =
        media.size;

    if (
        !fileSize
    ) {

        throw new Error(
            "Telegram returned a media object with no file size."
        );
    }

    let bytes =
        0;

    let chunks =
        0;

    const iter =
        client.iterDownload({
            file:
                media.location,

            offset:
                bigInt(0),

            limit:
                bigInt(fileSize),

            requestSize:
                2 * 1024 * 1024
        });

    for await (
        const chunk
        of iter
    ) {

        if (
            request.signal.aborted
        ) {

            return new Response(
                JSON.stringify({
                    success: false,
                    aborted: true,
                    bytes,
                    chunks,
                    fileSize,
                    elapsedMs:
                        Date.now() -
                        started
                }),
                {
                    status: 499,
                    headers: {
                        "Content-Type":
                            "application/json"
                    }
                }
            );
        }

        bytes +=
            chunk.byteLength ||
            chunk.length ||
            0;

        chunks++;

        /*
         * Deliberately discard the
         * downloaded data.
         *
         * Nothing is stored in an
         * array and nothing is sent
         * to the browser.
         */
    }

    return json({
        success: true,

        test:
            "telegram-download-discard",

        chatId:
            String(chatId),

        messageId:
            String(messageId),

        fileSize,

        bytesDownloaded:
            bytes,

        chunks,

        elapsedMs:
            Date.now() -
            started
    });
}

async function handleMedia(
    request,
    env,
    chatId,
    messageId,
    thumbnail
) {

    const client =
        await getTelegramClient(
            env
        );

    const {
        message
    } =
        await findTelegramMessage(
            client,
            chatId,
            messageId
        );

    const media =
        getMediaDownloadInfo(
            message,
            thumbnail
        );

    const range =
        thumbnail
            ? {
                start: 0,
                end:
                    media.size - 1
            }
            : parseRange(
                request,
                media.size
            );

    if (!range) {

        return new Response(
            "Invalid Range",
            {
                status: 416,
                headers: {
                    "Content-Range":
                        `bytes */${media.size}`
                }
            }
        );
    }

    const start =
        range.start;

    const end =
        range.end;

    const contentLength =
        end -
        start +
        1;

    const iter =
        client.iterDownload({
            file:
                media.location,

            offset:
                bigInt(start),

            limit:
                bigInt(contentLength),

            requestSize:
                2 * 1024 * 1024
        });

    const stream =
        new ReadableStream({

            async start(
                controller
            ) {

                try {

                    for await (
                        const chunk
                        of iter
                    ) {

                        if (
                            request.signal.aborted
                        ) {
                            return;
                        }

                        controller.enqueue(
                            chunk
                        );
                    }

                    controller.close();

                } catch (error) {

                    if (
                        !request.signal.aborted
                    ) {
                        controller.error(
                            error
                        );
                    }
                }
            },

            cancel() {}
        });

    const headers =
        new Headers();

    headers.set(
        "Content-Type",
        media.mimeType
    );

    headers.set(
        "Accept-Ranges",
        "bytes"
    );

    headers.set(
        "Content-Length",
        String(
            contentLength
        )
    );

    headers.set(
        "Cache-Control",
        "public, max-age=31536000, immutable"
    );

    if (!thumbnail) {

        headers.set(
            "Content-Range",
            `bytes ${start}-${end}/${media.size}`
        );
    }

    return new Response(
        stream,
        {
            status:
                thumbnail
                    ? 200
                    : (
                        start === 0 &&
                        end === media.size - 1
                    )
                        ? 200
                        : 206,

            headers
        }
    );
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
<title>Telegram HTTP Test</title>
<style>
body {
    font-family: sans-serif;
    max-width: 900px;
    margin: 40px auto;
    padding: 0 20px;
}
select {
    width: 100%;
    max-width: 700px;
    padding: 8px;
    margin: 6px 0 16px;
}
pre {
    white-space: pre-wrap;
    word-break: break-word;
}
a {
    display: inline-block;
    margin: 6px 10px 6px 0;
}
</style>
</head>

<body>

<h1>Telegram HTTP Test</h1>

<label>Chat</label>
<select id="chat"></select>

<label>Message</label>
<select id="message"></select>

<pre id="info">Loading...</pre>

<div id="links"></div>

<script>

const chatSelect =
    document.getElementById("chat");

const messageSelect =
    document.getElementById("message");

const info =
    document.getElementById("info");

const links =
    document.getElementById("links");

let chats = [];
let messages = [];

async function loadChats() {

    const response =
        await fetch(
            "/api/chats"
        );

    chats =
        await response.json();

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
            chat.title ||
            chat.name ||
            chat.id;

        chatSelect.appendChild(
            option
        );
    }

    await loadMessages();
}

async function loadMessages() {

    const chatId =
        chatSelect.value;

    if (!chatId) {
        return;
    }

    info.textContent =
        "Loading messages...";

    const response =
        await fetch(
            "/api/messages?chatId=" +
            encodeURIComponent(
                chatId
            )
        );

    messages =
        await response.json();

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

        option.textContent =
            "#" +
            message.id +
            " " +
            (
                message.text ||
                "[" +
                (
                    message.mediaType ||
                    "media"
                ) +
                "]"
            ).slice(0, 100);

        messageSelect.appendChild(
            option
        );
    }

    updateMessage();
}

function updateMessage() {

    const message =
        messages.find(
            item =>
                String(item.id) ===
                String(messageSelect.value)
        );

    if (!message) {
        return;
    }

    const chatId =
        chatSelect.value;

    const messageId =
        message.id;

    const mediaURL =
        "/media/" +
        encodeURIComponent(
            chatId
        ) +
        "/" +
        encodeURIComponent(
            messageId
        );

    const thumbURL =
        mediaURL +
        "?thumb=1";

    const testURL =
        "/test-download/" +
        encodeURIComponent(
            chatId
        ) +
        "/" +
        encodeURIComponent(
            messageId
        );

    info.textContent =
        JSON.stringify(
            message,
            null,
            2
        );

    links.innerHTML =
        "";

    if (
        message.hasFullMedia
    ) {

        const media =
            document.createElement(
                "a"
            );

        media.href =
            mediaURL;

        media.target =
            "_blank";

        media.textContent =
            "Open media";

        links.appendChild(
            media
        );

        const test =
            document.createElement(
                "a"
            );

        test.href =
            testURL;

        test.target =
            "_blank";

        test.textContent =
            "Test full download";

        links.appendChild(
            test
        );
    }

    if (
        message.hasThumbnail
    ) {

        const thumb =
            document.createElement(
                "a"
            );

        thumb.href =
            thumbURL;

        thumb.target =
            "_blank";

        thumb.textContent =
            "Open thumbnail";

        links.appendChild(
            thumb
        );
    }
}

chatSelect.addEventListener(
    "change",
    loadMessages
);

messageSelect.addEventListener(
    "change",
    updateMessage
);

loadChats()
    .catch(
        error => {
            info.textContent =
                error.stack ||
                String(error);
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

        const dialogs =
            await client.getDialogs({
                limit: undefined
            });

        return json(
            dialogs.map(
                dialog => ({
                    id:
                        String(
                            dialog.id
                        ),

                    title:
                        dialog.title ||
                        dialog.name ||
                        String(
                            dialog.id
                        ),

                    name:
                        dialog.name ||
                        null,

                    isUser:
                        !!dialog.isUser,

                    isGroup:
                        !!dialog.isGroup,

                    isChannel:
                        !!dialog.isChannel
                })
            )
        );
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
                    error:
                        "Missing chatId"
                },
                400
            );
        }

        const client =
            await getTelegramClient(
                env
            );

        const {
            dialog
        } =
            await findTelegramMessage(
                client,
                chatId,
                1
            ).catch(
                async error => {

                    /*
                     * Message 1 may not exist,
                     * so resolve the dialog directly.
                     */

                    const dialogs =
                        await client.getDialogs({
                            limit: undefined
                        });

                    const dialog =
                        dialogs.find(
                            item =>
                                String(
                                    item.id
                                ) ===
                                String(
                                    chatId
                                )
                        );

                    if (!dialog) {
                        throw error;
                    }

                    return {
                        dialog
                    };
                }
            );

        const messages =
            await client.getMessages(
                dialog,
                {
                    limit:
                        undefined
                }
            );

        return json(
            messages.map(
                message => {

                    const mediaInfo =
                        getMediaInfo(
                            message
                        );

                    return {
                        id:
                            String(
                                message.id
                            ),

                        date:
                            message.date
                                ? new Date(
                                    message.date *
                                    1000
                                ).toISOString()
                                : null,

                        text:
                            message.message ||
                            "",

                        hasMedia:
                            !!message.media,

                        mediaType:
                            message.media?.className ||
                            null,

                        hasFullMedia:
                            mediaInfo.supported,

                        hasThumbnail:
                            mediaInfo.hasThumbnail
                    };
                }
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

    const mediaMatch =
        path.match(
            /^\/media\/([^/]+)\/([^/]+)$/
        );

    if (mediaMatch) {

        return handleMedia(
            request,
            env,
            decodeURIComponent(
                mediaMatch[1]
            ),
            decodeURIComponent(
                mediaMatch[2]
            ),
            url.searchParams.get(
                "thumb"
            ) === "1"
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
                {
                    ...errorInfo(
                        error
                    )
                },
                500
            );
        }
    }
};
