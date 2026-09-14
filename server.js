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

    console.log("Connected to Telegram.");
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
                mediaType = message.media.className ||
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
