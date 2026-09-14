const express = require("express");
const { TelegramClient } = require("telegram");
const bigInt = require("big-integer");
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

const chatMap = new Map();

async function startTelegram() {
    await client.connect();

    console.log(
        "Connected to Telegram."
    );
}

app.use(express.static("."));

app.get("/api/chats", async (req, res) => {
    try {
        const dialogs =
            await client.getDialogs({});

        chatMap.clear();

        const chats =
            dialogs.map(
                (dialog, index) => {

                    const id =
                        String(dialog.id);

                    chatMap.set(
                        id,
                        dialog
                    );

                    return {
                        index,
                        id,
                        title:
                            dialog.title ||
                            dialog.name ||
                            "Untitled chat"
                    };
                }
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
        const chatId =
            String(req.query.chatId);

        if (!chatId) {
            return res.status(400).json({
                error: "Invalid chat."
            });
        }

        const dialog =
            chatMap.get(chatId);

        if (!dialog) {
            return res.status(404).json({
                error:
                    "Chat not found. Reload the chat list first."
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

async function getTelegramDocument(
    dialog,
    messageId
) {
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
        throw new Error(
            "Message not found."
        );
    }

    if (!message.media) {
        throw new Error(
            "Message does not contain media."
        );
    }

    if (!message.document) {
        throw new Error(
            "This test currently supports Telegram documents."
        );
    }

    return {
        message,
        document:
            message.document
    };
}

async function downloadTelegramLocation(
    location,
    size
) {
    const chunks = [];

    let offset = 0n;
    let remaining = size;

    const chunkSize =
        512 * 1024;

    while (remaining > 0) {

        const limit =
            Math.min(
                chunkSize,
                remaining
            );

        const downloaded = [];

        for await (
            const chunk of client.iterDownload({
                file: location,
                offset: bigInt(offset),
                limit,
                chunkSize
            })
        ) {
            downloaded.push(
                Buffer.from(chunk)
            );
        }

        if (!downloaded.length) {
            break;
        }

        let length = 0;

        for (
            const chunk of downloaded
        ) {
            length +=
                chunk.length;
        }

        if (!length) {
            break;
        }

        for (
            const chunk of downloaded
        ) {
            chunks.push(chunk);
        }

        offset +=
            BigInt(length);

        remaining -=
            length;

        if (
            length < limit
        ) {
            break;
        }
    }

    const total =
        chunks.reduce(
            (sum, chunk) =>
                sum + chunk.length,
            0
        );

    const result =
        Buffer.allocUnsafe(total);

    let position = 0;

    for (
        const chunk of chunks
    ) {
        chunk.copy(
            result,
            position
        );

        position +=
            chunk.length;
    }

    return result;
}

app.get(
    "/media/:chatId/:messageId",
    async (req, res) => {

        try {

            const chatId =
                String(req.params.chatId);

            const messageId =
                Number(
                    req.params.messageId
                );

            if (
                !chatId ||
                !Number.isSafeInteger(
                    messageId
                ) ||
                messageId <= 0
            ) {
                return res.status(400).send(
                    "Invalid chat or message."
                );
            }

            const dialog =
                chatMap.get(chatId);

            if (!dialog) {
                return res.status(404).send(
                    "Chat not found. Reload the chat list first."
                );
            }

            const {
                message,
                document
            } =
                await getTelegramDocument(
                    dialog,
                    messageId
                );

            const mimeType =
                document.mimeType ||
                "application/octet-stream";

            /*
             * Thumbnail request.
             *
             * This deliberately does not use HTTP Range.
             * Telegram's document thumbnail is a separate
             * file location inside the document metadata.
             */
            if (
                req.query.thumb === "1"
            ) {
            
                const thumbs =
                    Array.isArray(
                        document.thumbs
                    )
                        ? document.thumbs
                        : [];
            
                const usableThumbs =
                    thumbs.filter(
                        thumb =>
                            thumb &&
                            (
                                thumb.className ===
                                    "PhotoSize" ||
                                thumb.className ===
                                    "PhotoCachedSize"
                            )
                    );
            
                if (!usableThumbs.length) {
                    return res.status(404).send(
                        "Telegram document has no usable thumbnail."
                    );
                }
            
                const thumbnail =
                    usableThumbs
                        .slice()
                        .sort(
                            (a, b) =>
                                (
                                    (a.w || 0) *
                                    (a.h || 0)
                                ) -
                                (
                                    (b.w || 0) *
                                    (b.h || 0)
                                )
                        )[0];
            
                /*
                 * PhotoSize thumbnails must be downloaded through
                 * inputDocumentFileLocation.
                 */
                if (
                    thumbnail.className ===
                        "PhotoSize"
                ) {
            
                    if (
                        !document.fileReference
                    ) {
                        return res.status(500).send(
                            "Telegram document has no file reference."
                        );
                    }
            
                    const location = {
                        _: "inputDocumentFileLocation",
            
                        id:
                            document.id,
            
                        access_hash:
                            document.accessHash,
            
                        file_reference:
                            document.fileReference,
            
                        thumb_size:
                            thumbnail.type || ""
                    };
            
                    console.log(
                        `Streaming thumbnail ${messageId}: ` +
                        `${thumbnail.w || 0}x${thumbnail.h || 0}`
                    );
            
                    const chunks = [];

                    let offset = 0n;
                    
                    while (true) {
                    
                        const result =
                            await client.invoke({
                                _: "upload.getFile",
                    
                                precise: true,
                    
                                location,
                    
                                offset,
                    
                                limit: 512 * 1024,
                    
                                cdn_supported: true
                            });
                    
                        if (
                            result?._ !==
                            "upload.file"
                        ) {
                            throw new Error(
                                "Telegram returned an unexpected thumbnail response."
                            );
                        }
                    
                        const bytes =
                            Buffer.from(
                                result.bytes
                            );
                    
                        if (!bytes.length) {
                            break;
                        }
                    
                        chunks.push(
                            bytes
                        );
                    
                        offset +=
                            BigInt(
                                bytes.length
                            );
                    
                        if (
                            bytes.length <
                            512 * 1024
                        ) {
                            break;
                        }
                    }
            
                    const total =
                        chunks.reduce(
                            (sum, chunk) =>
                                sum + chunk.length,
                            0
                        );
            
                    if (!total) {
                        return res.status(404).send(
                            "Telegram returned an empty thumbnail."
                        );
                    }
            
                    const buffer =
                        Buffer.concat(
                            chunks,
                            total
                        );
            
                    res.status(200);
            
                    res.setHeader(
                        "Content-Type",
                        "image/jpeg"
                    );
            
                    res.setHeader(
                        "Content-Length",
                        String(buffer.length)
                    );
            
                    res.setHeader(
                        "Cache-Control",
                        "public, max-age=31536000, immutable"
                    );
            
                    return res.end(
                        buffer
                    );
                }
            
                return res.status(404).send(
                    "Unsupported Telegram thumbnail type."
                );
            }

            /*
             * Normal full-file request.
             */

            const fileSize =
                Number(
                    document.size
                );

            if (
                !Number.isSafeInteger(
                    fileSize
                ) ||
                fileSize < 0
            ) {
                return res.status(500).send(
                    "Invalid Telegram file size."
                );
            }

            const range =
                req.headers.range;

            let start = 0;
            let end =
                fileSize - 1;

            if (range) {

                const match =
                    /^bytes=(\d*)-(\d*)$/.exec(
                        range
                    );

                if (!match) {
                    return res.status(416).send(
                        "Invalid Range."
                    );
                }

                if (
                    match[1] === "" &&
                    match[2] === ""
                ) {
                    return res.status(416).send(
                        "Invalid Range."
                    );
                }

                if (
                    match[1] === ""
                ) {

                    const suffixLength =
                        Number(
                            match[2]
                        );

                    if (
                        !Number.isSafeInteger(
                            suffixLength
                        ) ||
                        suffixLength <= 0
                    ) {
                        return res.status(416).send(
                            "Invalid Range."
                        );
                    }

                    start =
                        Math.max(
                            0,
                            fileSize -
                                suffixLength
                        );
                }
                else {

                    start =
                        Number(
                            match[1]
                        );

                    if (
                        !Number.isSafeInteger(
                            start
                        ) ||
                        start >= fileSize
                    ) {

                        res.status(416);

                        res.setHeader(
                            "Content-Range",
                            `bytes */${fileSize}`
                        );

                        return res.end();
                    }

                    if (
                        match[2] !== ""
                    ) {

                        end =
                            Number(
                                match[2]
                            );

                        if (
                            !Number.isSafeInteger(
                                end
                            ) ||
                            end < start
                        ) {

                            res.status(416);

                            res.setHeader(
                                "Content-Range",
                                `bytes */${fileSize}`
                            );

                            return res.end();
                        }

                        end =
                            Math.min(
                                end,
                                fileSize - 1
                            );
                    }
                }
            }

            const contentLength =
                end - start + 1;

            res.setHeader(
                "Content-Type",
                mimeType
            );

            res.setHeader(
                "Accept-Ranges",
                "bytes"
            );

            res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable"
            );

            if (range) {

                res.status(206);

                res.setHeader(
                    "Content-Range",
                    `bytes ${start}-${end}/${fileSize}`
                );

            }
            else {

                res.status(200);

            }

            res.setHeader(
                "Content-Length",
                String(contentLength)
            );

            console.log(
                `Streaming ${messageId}: ` +
                `${start}-${end} / ${fileSize}`
            );

            const chunkSize =
                512 * 1024;

            for await (
                const chunk of client.iterDownload({
                    file: message.media,
                    offset: bigInt(start),
                    limit: contentLength,
                    chunkSize
                })
            ) {

                if (
                    !res.write(
                        Buffer.from(chunk)
                    )
                ) {

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

                res.destroy(
                    error
                );

            }
        }
    }
);

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
