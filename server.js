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

app.get("/", (req, res) => {
    res.type("text").send(
        connected
            ? "Telegram HTTP test server is running. Telegram is connected."
            : "Telegram HTTP test server is running. Telegram is not connected."
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
            "Telegram connection failed:",
            error
        );

        process.exit(1);
    });
