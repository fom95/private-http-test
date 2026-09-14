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
        JSON.stringify(
            data,
            null,
            2
        ),
        {
            status,

            headers: {
                "Content-Type":
                    "application/json; charset=utf-8",

                "Access-Control-Allow-Origin":
                    "*"
            }
        }
    );
}

function html(content, status = 200) {

    return new Response(
        content,
        {
            status,

            headers: {
                "Content-Type":
                    "text/html; charset=utf-8",

                "Access-Control-Allow-Origin":
                    "*"
            }
        }
    );
}

function errorInfo(error) {

    return {
        message:
            error?.message ??
            String(error),

        name:
            error?.name ??
            null,

        stack:
            error?.stack ??
            null,

        constructor:
            error?.constructor?.name ??
            null
    };
}

function parseRange(rangeHeader, size) {

    if (!rangeHeader) {
        return null;
    }

    const match =
        /^bytes=(\d*)-(\d*)$/i.exec(
            rangeHeader.trim()
        );

    if (!match) {
        return null;
    }

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
            !Number.isSafeInteger(
                start
            ) ||
            start < 0 ||
            start >= size
        ) {
            return null;
        }

        if (match[2] === "") {

            end =
                size - 1;

        } else {

            end =
                Number(match[2]);

            if (
                !Number.isSafeInteger(
                    end
                ) ||
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
        end
    };
}

async function findTelegramMessage(
    client,
    chatId,
    messageId
) {

    const dialogs =
        await client.getDialogs(
            {}
        );

    const dialog =
        dialogs.find(
            item =>
                String(item.id) ===
                String(chatId)
        );

    if (!dialog) {
        return null;
    }

    const inputEntity =
        await client.getInputEntity(
            dialog
        );

    const messages =
        await client.getMessages(
            inputEntity,
            {
                ids: Number(messageId)
            }
        );

    return {
        dialog,
        message:
            messages?.[0] ??
            null
    };
}

const PAGE = `<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1"
>

<title>Telegram HTTP Test</title>

<style>

body {
    font-family: Arial, sans-serif;
    max-width: 900px;
    margin: 40px auto;
    padding: 0 20px;
    background: #111;
    color: #eee;
}

h1 {
    margin-bottom: 30px;
}

label {
    display: block;
    margin: 20px 0 8px;
    font-weight: bold;
}

select {
    width: 100%;
    padding: 10px;
    font-size: 16px;
    background: #222;
    color: #eee;
    border: 1px solid #555;
    border-radius: 4px;
}

a {
    color: #6cb6ff;
}

#status {
    margin-top: 20px;
    color: #aaa;
}

#error {
    margin-top: 20px;
    padding: 12px;
    background: #401515;
    color: #ffaaaa;
    white-space: pre-wrap;
    display: none;
}

#chatInfo,
#messageInfo {
    margin-top: 20px;
    padding: 15px;
    background: #1c1c1c;
    border-radius: 5px;
    display: none;
}

pre {
    white-space: pre-wrap;
    word-break: break-word;
}

</style>

</head>

<body>

<h1>Telegram HTTP Test</h1>

<label for="chatSelect">
    Chat
</label>

<select id="chatSelect">

    <option value="">
        Loading chats...
    </option>

</select>

<div id="chatInfo"></div>

<label for="messageSelect">
    Message
</label>

<select
    id="messageSelect"
    disabled
>

    <option value="">
        Messages will appear here
    </option>

</select>

<div id="messageInfo"></div>

<div id="status"></div>

<div id="error"></div>

<script>

const chatSelect =
    document.getElementById(
        "chatSelect"
    );

const messageSelect =
    document.getElementById(
        "messageSelect"
    );

const chatInfo =
    document.getElementById(
        "chatInfo"
    );

const messageInfo =
    document.getElementById(
        "messageInfo"
    );

const status =
    document.getElementById(
        "status"
    );

const errorBox =
    document.getElementById(
        "error"
    );

let currentMessages = [];

async function loadChats() {

    try {

        status.textContent =
            "Loading chats...";

        errorBox.style.display =
            "none";

        const response =
            await fetch(
                "/api/chats"
            );

        const text =
            await response.text();

        if (!response.ok) {

            throw new Error(
                "HTTP " +
                response.status +
                "\\n\\n" +
                text
            );
        }

        const chats =
            JSON.parse(text);

        if (!Array.isArray(chats)) {

            throw new Error(
                "Unexpected chats response:\\n\\n" +
                text
            );
        }

        chatSelect.innerHTML =
            '<option value="">Select a chat...</option>';

        for (
            const chat of chats
        ) {

            const option =
                document.createElement(
                    "option"
                );

            option.value =
                chat.id;

            option.textContent =
                chat.name +
                " [" +
                chat.id +
                "]";

            chatSelect.appendChild(
                option
            );
        }

        status.textContent =
            chats.length +
            " chats loaded.";

    } catch (error) {

        status.textContent =
            "Failed to load chats.";

        errorBox.textContent =
            error.stack ||
            error.message ||
            String(error);

        errorBox.style.display =
            "block";
    }
}

async function loadMessages(chatId) {

    try {

        status.textContent =
            "Loading messages...";

        errorBox.style.display =
            "none";

        messageSelect.disabled =
            true;

        messageSelect.innerHTML =
            '<option value="">Loading messages...</option>';

        messageInfo.style.display =
            "none";

        const response =
            await fetch(
                "/api/messages?chatId=" +
                encodeURIComponent(
                    chatId
                )
            );

        const text =
            await response.text();

        if (!response.ok) {

            throw new Error(
                "HTTP " +
                response.status +
                "\\n\\n" +
                text
            );
        }

        currentMessages =
            JSON.parse(text);

        if (
            !Array.isArray(
                currentMessages
            )
        ) {

            throw new Error(
                "Unexpected messages response:\\n\\n" +
                text
            );
        }

        messageSelect.innerHTML =
            '<option value="">Select a message...</option>';

        for (
            const message of currentMessages
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

            if (message.hasMedia) {

                label +=
                    " [" +
                    message.mediaType +
                    "]";
            }

            if (message.text) {

                const messageText =
                    message.text
                        .replace(
                            /\\s+/g,
                            " "
                        )
                        .trim();

                if (messageText) {

                    label +=
                        " " +
                        messageText.slice(
                            0,
                            100
                        );
                }
            }

            option.textContent =
                label;

            messageSelect.appendChild(
                option
            );
        }

        messageSelect.disabled =
            false;

        status.textContent =
            currentMessages.length +
            " messages loaded.";

    } catch (error) {

        messageSelect.disabled =
            true;

        messageSelect.innerHTML =
            '<option value="">Failed to load messages</option>';

        status.textContent =
            "Failed to load messages.";

        errorBox.textContent =
            error.stack ||
            error.message ||
            String(error);

        errorBox.style.display =
            "block";
    }
}

chatSelect.addEventListener(
    "change",
    async () => {

        if (!chatSelect.value) {

            chatInfo.style.display =
                "none";

            messageSelect.disabled =
                true;

            messageSelect.innerHTML =
                '<option value="">Messages will appear here</option>';

            messageInfo.style.display =
                "none";

            return;
        }

        const chatId =
            chatSelect.value;

        const selected =
            chatSelect.options[
                chatSelect.selectedIndex
            ];

        chatInfo.style.display =
            "block";

        chatInfo.innerHTML =
            "<strong>Chat ID:</strong> " +
            escapeHtml(chatId) +
            "<br><strong>Name:</strong> " +
            escapeHtml(
                selected.textContent
            ) +
            "<br><br>" +
            '<a href="/api/chat?chatId=' +
            encodeURIComponent(chatId) +
            '" target="_blank">' +
            "Open chat diagnostic" +
            "</a>" +
            "<br>" +
            '<a href="/api/messages?chatId=' +
            encodeURIComponent(chatId) +
            '" target="_blank">' +
            "Open messages API" +
            "</a>";

        await loadMessages(
            chatId
        );
    }
);

messageSelect.addEventListener(
    "change",
    () => {

        if (!messageSelect.value) {

            messageInfo.style.display =
                "none";

            return;
        }

        const message =
            currentMessages.find(
                item =>
                    String(item.id) ===
                    String(
                        messageSelect.value
                    )
            );

        if (!message) {
            return;
        }

        let mediaLink =
            "";

        if (message.hasMedia) {

            mediaLink =
                "<br><br>" +
                '<a href="/media/' +
                encodeURIComponent(
                    chatSelect.value
                ) +
                "/" +
                encodeURIComponent(
                    message.id
                ) +
                '" target="_blank">' +
                "Open media" +
                "</a>";
        }

        messageInfo.style.display =
            "block";

        messageInfo.innerHTML =
            "<strong>Message ID:</strong> " +
            escapeHtml(message.id) +
            "<br><strong>Date:</strong> " +
            escapeHtml(
                message.date ||
                "Unknown"
            ) +
            "<br><strong>Media:</strong> " +
            escapeHtml(
                message.hasMedia
                    ? message.mediaType
                    : "None"
            ) +
            mediaLink +
            "<br><br><strong>Text:</strong>" +
            "<pre>" +
            escapeHtml(
                message.text ||
                ""
            ) +
            "</pre>";
    }
);

function escapeHtml(value) {

    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}

loadChats();

</script>

</body>

</html>`;

export default {

    async fetch(request, env) {

        try {

            const url =
                new URL(
                    request.url
                );

            if (
                url.pathname === "/" ||
                url.pathname === "/index.html"
            ) {

                return html(PAGE);
            }

            if (
                url.pathname === "/api/chats"
            ) {

                const client =
                    await getTelegramClient(
                        env
                    );

                const dialogs =
                    await client.getDialogs(
                        {}
                    );

                const chats =
                    dialogs.map(
                        dialog => ({
                            id:
                                dialog.id?.toString() ??
                                null,

                            name:
                                dialog.title ??
                                dialog.name ??
                                dialog.id?.toString() ??
                                "Unknown"
                        })
                    );

                return json(
                    chats
                );
            }

            if (
                url.pathname === "/api/chat"
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

                const dialogs =
                    await client.getDialogs(
                        {}
                    );

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

                    return json(
                        {
                            error:
                                "Chat not found",

                            chatId
                        },
                        404
                    );
                }

                const entity =
                    dialog.entity;

                return json({
                    id:
                        dialog.id?.toString() ??
                        null,

                    name:
                        dialog.title ??
                        dialog.name ??
                        null,

                    username:
                        entity?.username ??
                        null,

                    type:
                        entity?.className ??
                        entity?.constructor?.name ??
                        null,

                    unreadCount:
                        dialog.unreadCount ??
                        0
                });
            }

            if (
                url.pathname === "/api/messages"
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

                const dialogs =
                    await client.getDialogs(
                        {}
                    );

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

                    return json(
                        {
                            error:
                                "Chat not found",

                            chatId
                        },
                        404
                    );
                }

                const inputEntity =
                    await client.getInputEntity(
                        dialog
                    );

                const messages =
                    await client.getMessages(
                        inputEntity,
                        {
                            limit: 10
                        }
                    );

                const output =
                    messages.map(
                        message => ({
                            id:
                                String(
                                    message.id
                                ),

                            date:
                                message.date
                                    ? new Date(
                                        message.date
                                    ).toISOString()
                                    : null,

                            text:
                                message.message ??
                                "",

                            hasMedia:
                                !!message.media,

                            mediaType:
                                message.media
                                    ?.className ??
                                null
                        })
                    );

                return json(
                    output
                );
            }

            if (
                url.pathname.startsWith(
                    "/media/"
                )
            ) {
            
                const parts =
                    url.pathname
                        .split("/")
                        .filter(Boolean);
            
                if (
                    parts.length !== 3
                ) {
            
                    return new Response(
                        "Invalid media URL",
                        {
                            status: 400
                        }
                    );
                }
            
                const chatId =
                    decodeURIComponent(
                        parts[1]
                    );
            
                const messageId =
                    decodeURIComponent(
                        parts[2]
                    );
            
                if (
                    !chatId ||
                    !messageId
                ) {
            
                    return new Response(
                        "Missing chat or message ID",
                        {
                            status: 400
                        }
                    );
                }
            
                const client =
                    await getTelegramClient(
                        env
                    );
            
                const found =
                    await findTelegramMessage(
                        client,
                        chatId,
                        messageId
                    );
            
                if (!found) {
            
                    return new Response(
                        "Chat not found",
                        {
                            status: 404
                        }
                    );
                }
            
                const message =
                    found.message;
            
                if (!message) {
            
                    return new Response(
                        "Message not found",
                        {
                            status: 404
                        }
                    );
                }
            
                const media =
                    message.media;
            
                if (!media) {
            
                    return new Response(
                        "Message does not contain media",
                        {
                            status: 415
                        }
                    );
                }
            
                const isDocument =
                    !!media.document;
            
                const isPhoto =
                    !!media.photo;
            
                if (
                    !isDocument &&
                    !isPhoto
                ) {
            
                    return new Response(
                        "Unsupported Telegram media type",
                        {
                            status: 415
                        }
                    );
                }
            
                let location;
                let size;
                let mimeType;
            
                if (isDocument) {
            
                    const document =
                        media.document;
            
                    size =
                        Number(
                            document.size.toString()
                        );
            
                    if (
                        !Number.isSafeInteger(
                            size
                        ) ||
                        size < 0
                    ) {
            
                        return new Response(
                            "Unsupported file size",
                            {
                                status: 500
                            }
                        );
                    }
            
                    location =
                        new Api.InputDocumentFileLocation({
                            id:
                                document.id,
            
                            accessHash:
                                document.accessHash,
            
                            fileReference:
                                document.fileReference,
            
                            thumbSize:
                                ""
                        });
            
                    mimeType =
                        document.mimeType ||
                        "application/octet-stream";
            
                } else {
            
                    const photo =
                        media.photo;
            
                    const sizes =
                        Array.isArray(
                            photo.sizes
                        )
                            ? photo.sizes
                            : [];
            
                    if (!sizes.length) {
            
                        return new Response(
                            "Telegram photo has no downloadable sizes",
                            {
                                status: 500
                            }
                        );
                    }
            
                    const downloadableSizes =
                        sizes.filter(
                            item =>
                                item &&
                                (
                                    item.size != null ||
                                    Array.isArray(
                                        item.sizes
                                    )
                                )
                        );
            
                    if (
                        !downloadableSizes.length
                    ) {
            
                        return new Response(
                            "Telegram photo has no downloadable size",
                            {
                                status: 500
                            }
                        );
                    }
            
                    const requestedThumb =
                        url.searchParams.get(
                            "thumb"
                        );
            
                    let selectedSize;
            
                    if (requestedThumb === "1") {
            
                        selectedSize =
                            downloadableSizes.find(
                                item =>
                                    item.type === "m"
                            ) ||
                            downloadableSizes.find(
                                item =>
                                    item.type === "x"
                            ) ||
                            downloadableSizes[
                                0
                            ];
            
                    } else {
            
                        selectedSize =
                            downloadableSizes[
                                downloadableSizes.length - 1
                            ];
                    }
            
                    let photoSize =
                        selectedSize.size;
            
                    if (
                        photoSize == null &&
                        Array.isArray(
                            selectedSize.sizes
                        )
                    ) {
            
                        photoSize =
                            selectedSize.sizes[
                                selectedSize.sizes.length - 1
                            ];
                    }
            
                    size =
                        Number(
                            photoSize
                        );
            
                    if (
                        !Number.isSafeInteger(
                            size
                        ) ||
                        size < 0
                    ) {
            
                        return new Response(
                            "Unsupported Telegram photo size",
                            {
                                status: 500
                            }
                        );
                    }
            
                    location =
                        new Api.InputPhotoFileLocation({
                            id:
                                photo.id,
            
                            accessHash:
                                photo.accessHash,
            
                            fileReference:
                                photo.fileReference,
            
                            thumbSize:
                                selectedSize.type
                        });
            
                    mimeType =
                        "image/jpeg";
                }
            
                const range =
                    parseRange(
                        request.headers.get(
                            "Range"
                        ),
                        size
                    );
            
                if (
                    request.headers.has(
                        "Range"
                    ) &&
                    !range
                ) {
            
                    return new Response(
                        null,
                        {
                            status: 416,
            
                            headers: {
                                "Content-Range":
                                    "bytes */" +
                                    size
                            }
                        }
                    );
                }
            
                const start =
                    range
                        ? range.start
                        : 0;
            
                const end =
                    range
                        ? range.end
                        : size - 1;
            
                const contentLength =
                    end -
                    start +
                    1;
            
                const iter =
                    client.iterDownload({
                        file:
                            location,
            
                        offset:
                            bigInt(
                                start
                            ),
            
                        limit:
                            bigInt(
                                contentLength
                            ),
            
                        requestSize:
                            512 * 1024
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
            
                                    controller.enqueue(
                                        new Uint8Array(
                                            chunk
                                        )
                                    );
                                }
            
                                controller.close();
            
                            } catch (error) {
            
                                controller.error(
                                    error
                                );
                            }
                        }
            
                    });
            
                const headers =
                    new Headers();
            
                headers.set(
                    "Content-Type",
                    mimeType
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
            
                if (range) {
            
                    headers.set(
                        "Content-Range",
                        "bytes " +
                        start +
                        "-" +
                        end +
                        "/" +
                        size
                    );
                }
            
                return new Response(
                    stream,
                    {
                        status:
                            range
                                ? 206
                                : 200,
            
                        headers
                    }
                );
            }

            return new Response(
                "Not found",
                {
                    status: 404,

                    headers: {
                        "Access-Control-Allow-Origin":
                            "*"
                    }
                }
            );

        } catch (error) {

            return json(
                {
                    stage:
                        "outer-worker-catch",

                    error:
                        errorInfo(
                            error
                        )
                },
                500
            );
        }
    }
};
