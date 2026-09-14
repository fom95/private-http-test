import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

let telegramClientPromise = null;

async function getTelegramClient(env) {
    if (!telegramClientPromise) {
        telegramClientPromise = (async () => {
            const apiId =
                Number(await env.API_ID.get());

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
        })().catch(error => {
            telegramClientPromise = null;
            throw error;
        });
    }

    return telegramClientPromise;
}

function json(data, status = 200) {
    return new Response(
        JSON.stringify(data, null, 2),
        {
            status,
            headers: {
                "Content-Type":
                    "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
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
                "Access-Control-Allow-Origin": "*"
            }
        }
    );
}

const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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

<label for="chatSelect">Chat</label>

<select id="chatSelect">
    <option value="">Loading chats...</option>
</select>

<div id="chatInfo"></div>

<label for="messageSelect">Message</label>

<select id="messageSelect" disabled>
    <option value="">Messages will appear here</option>
</select>

<div id="messageInfo"></div>

<div id="status"></div>

<div id="error"></div>

<script>
const chatSelect =
    document.getElementById("chatSelect");

const messageSelect =
    document.getElementById("messageSelect");

const chatInfo =
    document.getElementById("chatInfo");

const messageInfo =
    document.getElementById("messageInfo");

const status =
    document.getElementById("status");

const errorBox =
    document.getElementById("error");

let currentMessages = [];

async function loadChats() {

    try {

        status.textContent =
            "Loading chats...";

        errorBox.style.display =
            "none";

        const response =
            await fetch("/api/chats");

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

        chatSelect.innerHTML =
            '<option value="">Select a chat...</option>';

        for (const chat of chats) {

            const option =
                document.createElement("option");

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
                encodeURIComponent(chatId)
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

        messageSelect.innerHTML =
            '<option value="">Select a message...</option>';

        for (const message of currentMessages) {

            const option =
                document.createElement("option");

            option.value =
                message.id;

            let label =
                "#" +
                message.id;

            if (message.media) {
                label +=
                    " [" +
                    message.media.type +
                    "]";
            }

            if (message.text) {

                const text =
                    message.text
                        .replace(/\\s+/g, " ")
                        .trim();

                if (text) {
                    label +=
                        " " +
                        text.slice(0, 100);
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

        const selected =
            chatSelect.options[
                chatSelect.selectedIndex
            ];

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

        chatInfo.style.display =
            "block";

        chatInfo.innerHTML =
            "<strong>Chat ID:</strong> " +
            chatSelect.value +
            "<br><strong>Name:</strong> " +
            selected.textContent;

        await loadMessages(
            chatSelect.value
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
                    String(messageSelect.value)
            );

        if (!message) {
            return;
        }

        messageInfo.style.display =
            "block";

        messageInfo.innerHTML =
            "<strong>Message ID:</strong> " +
            message.id +
            "<br><strong>Date:</strong> " +
            (message.date || "Unknown") +
            "<br><strong>Media:</strong> " +
            (message.media
                ? message.media.type
                : "None") +
            "<br><br><strong>Text:</strong>" +
            "<pre>" +
            escapeHtml(message.text || "") +
            "</pre>";
    }
);

function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

loadChats();
</script>

</body>
</html>`;

export default {
    async fetch(request, env) {

        try {

            const url =
                new URL(request.url);

            if (request.method === "OPTIONS") {

                return new Response(null, {
                    status: 204,
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods":
                            "GET, OPTIONS",
                        "Access-Control-Allow-Headers":
                            "Content-Type"
                    }
                });
            }

            if (
                url.pathname === "/" ||
                url.pathname === "/index.html"
            ) {
                return html(PAGE);
            }

            if (url.pathname === "/api/chats") {

                const client =
                    await getTelegramClient(env);

                const dialogs =
                    await client.getDialogs({});

                const chats =
                    dialogs.map(dialog => ({
                        id:
                            dialog.id?.toString() ??
                            null,

                        name:
                            dialog.title ??
                            dialog.name ??
                            dialog.id?.toString() ??
                            "Unknown"
                    }));

                return json(chats);
            }

            if (url.pathname === "/api/messages") {

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
                    await getTelegramClient(env);

                const dialogs =
                    await client.getDialogs({});

                const dialog =
                    dialogs.find(
                        item =>
                            String(item.id) ===
                            String(chatId)
                    );

                if (!dialog) {

                    return json(
                        {
                            error:
                                "Chat not found",

                            requestedChatId:
                                chatId,

                            availableIds:
                                dialogs.map(
                                    item =>
                                        String(item.id)
                                )
                        },
                        404
                    );
                }

                const messages = [];

                for await (
                    const message of
                    client.iterMessages(
                        dialog
                    )
                ) {

                    messages.push({
                        id:
                            message.id,

                        date:
                            message.date
                                ? message.date.toISOString()
                                : null,

                        text:
                            message.message ||
                            "",

                        media:
                            message.media
                                ? {
                                    type:
                                        message.media.className ||
                                        message.media.constructor?.name ||
                                        null
                                }
                                : null
                    });
                }

                return json(
                    messages
                );
            }

            return new Response(
                "Not found",
                {
                    status: 404,
                    headers: {
                        "Access-Control-Allow-Origin": "*"
                    }
                }
            );

        } catch (error) {

            return json(
                {
                    error:
                        error?.message ||
                        String(error),

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
};
