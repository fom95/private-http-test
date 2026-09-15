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
        await env.TELEGRAM_SESSION.get();

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

function getMessageMediaInfo(
    message
) {

    const media =
        message?.media;

    if (!media) {

        return {
            hasMedia:
                false,

            type:
                null,

            fileId:
                null,

            fileSize:
                0,

            fileName:
                null,

            mimeType:
                null
        };
    }

    return {
        hasMedia:
            true,

        type:
            media.type ||
            null,

        fileId:
            media.fileId ||
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
            null
    };
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
        chat => ({
            id:
                String(
                    chat.id
                ),

            title:
                chat.title ||
                chat.name ||
                String(
                    chat.id
                ),

            type:
                chat.type ||
                null,

            username:
                chat.username ||
                null
        })
    );
}

async function getMessages(
    client,
    chatId
) {

    const messages =
        await client.getHistory(
            chatId,
            {
                limit:
                    100
            }
        );

    return messages.map(
        message => {

            const media =
                getMessageMediaInfo(
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
                    message.text ||
                    "",

                hasMedia:
                    media.hasMedia,

                mediaType:
                    media.type,

                fileId:
                    media.fileId,

                fileSize:
                    media.fileSize,

                fileName:
                    media.fileName,

                mimeType:
                    media.mimeType
            };
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

    const message =
        await client.getMessage(
            chatId,
            Number(
                messageId
            )
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
                chunkSize:
                    2 * 1024 * 1024,

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

        /*
         * Deliberately discard
         * every downloaded chunk.
         */
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
            "]";

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
            "Non-JSON response from /api/messages:\\n\\n" +
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

    messages =
        data;

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
                        /\\s+/g,
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

        }

        option.textContent =
            label;

        messageSelect.appendChild(
            option
        );
    }

    status.textContent =
        messages.length +
        " messages loaded.";

    updateMessage();
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
                        "Missing chatId."
                },
                400
            );
        }

        const client =
            await getTelegramClient(
                env
            );

        return json(
            await getMessages(
                client,
                chatId
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
