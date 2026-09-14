const express = require("express");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const app = express();

const PORT = process.env.PORT || 3000;

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const session = process.env.TELEGRAM_SESSION;

if (!apiId || !apiHash || !session) {
    throw new Error(
        "Missing API_ID, API_HASH, or TELEGRAM_SESSION."
    );
}

const client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    {
        connectionRetries: 5
    }
);

let connected = false;

async function startTelegram() {
    await client.connect();

    connected = true;

    console.log(
        "Connected to Telegram."
    );
}

app.use(express.static("."));

app.get("/api/chats", async (req, res) => {
    try {
        const dialogs =
            await client.getDialogs({});

        const chats = dialogs.map(
            (dialog, index) => ({
                index,
                id: String(dialog.id),
                title:
                    dialog.title ||
                    dialog.name ||
                    "Untitled chat"
            })
        );

        res.json(chats);
    }
    catch (error) {
        console.error(
            "Failed to load chats:",
            error
        );

        res.status(500).json({
            error:
                error?.message ||
                String(error)
        });
    }
});

app.get("/api/messages", async (req, res) => {
    try {
        const chatIndex =
            Number(req.query.chat);

        if (
            !Number.isInteger(chatIndex) ||
            chatIndex < 0
        ) {
            return res.status(400).json({
                error: "Invalid chat."
            });
        }

        const dialogs =
            await client.getDialogs({});

        const dialog =
            dialogs[chatIndex];

        if (!dialog) {
            return res.status(404).json({
                error: "Chat not found."
            });
        }

        const messages = [];

        for await (
            const message of client.iterMessages(
                dialog,
                {
                    limit: 100
                }
            )
        ) {
            let mediaType = null;

            if (message.photo) {
                mediaType = "photo";
            }
            else if (message.document) {
                mediaType = "document";
            }
            else if (message.video) {
                mediaType = "video";
            }
            else if (message.audio) {
                mediaType = "audio";
            }
            else if (message.media) {
                mediaType =
                    message.media.className ||
                    message.media.constructor?.name ||
                    "media";
            }

            messages.push({
                id: message.id,
                date: message.date
                    ? new Date(
                        message.date * 1000
                    ).toISOString()
                    : null,
                text: message.text || "",
                mediaType,
                hasMedia: !!message.media
            });
        }

        res.json({
            chat: {
                index: chatIndex,
                id: String(dialog.id),
                title:
                    dialog.title ||
                    dialog.name ||
                    "Untitled chat"
            },
            messages
        });
    }
    catch (error) {
        console.error(
            "Failed to load messages:",
            error
        );

        res.status(500).json({
            error:
                error?.message ||
                String(error)
        });
    }
});

app.get("/media/:chat/:message", async (req, res) => {
    try {
        const chatIndex =
            Number(req.params.chat);

        const messageId =
            Number(req.params.message);

        if (
            !Number.isInteger(chatIndex) ||
            chatIndex < 0 ||
            !Number.isInteger(messageId) ||
            messageId <= 0
        ) {
            return res.status(400).send(
                "Invalid chat or message."
            );
        }

        const dialogs =
            await client.getDialogs({});

        const dialog =
            dialogs[chatIndex];

        if (!dialog) {
            return res.status(404).send(
                "Chat not found."
            );
        }

        const messages =
            await client.getMessages(
                dialog,
                {
                    ids: messageId
                }
            );

        const message =
            messages[0];

        if (!message) {
            return res.status(404).send(
                "Message not found."
            );
        }

        if (!message.media) {
            return res.status(400).send(
                "Message does not contain media."
            );
        }

        if (!message.document) {
            return res.status(400).send(
                "This first test only supports Telegram documents."
            );
        }

        const document =
            message.document;

        const mimeType =
            document.mimeType ||
            "application/octet-stream";

        res.status(200);

        res.setHeader(
            "Content-Type",
            mimeType
        );

        if (document.size !== undefined) {
            res.setHeader(
                "Content-Length",
                String(document.size)
            );
        }

        res.setHeader(
            "Accept-Ranges",
            "bytes"
        );

        console.log(
            `Streaming message ${messageId}: ` +
            `${document.size} bytes`
        );

        for await (
            const chunk of client.iterDownload({
                file: message.media,
                chunkSize: 512 * 1024
            })
        ) {
            if (!res.write(
                Buffer.from(chunk)
            )) {
                await new Promise(
                    resolve =>
                        res.once(
                            "drain",
                            resolve
                        )
                );
            }
        }

        res.end();
    }
    catch (error) {
        console.error(
            "Media request failed:",
            error
        );

        if (!res.headersSent) {
            res.status(500).send(
                error?.message ||
                String(error)
            );
        }
        else {
            res.destroy(error);
        }
    }
});

app.get("/", (req, res) => {
    res.sendFile(
        __dirname + "/index.html"
    );
});

startTelegram()
    .then(() => {
        app.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log(
                    `Server listening on port ${PORT}`
                );
            }
        );
    })
    .catch(error => {
        console.error(
            "Startup failed:",
            error
        );

        process.exit(1);
    });
