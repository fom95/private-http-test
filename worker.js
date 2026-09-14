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

export default {
    async fetch(request, env) {

        try {

            const url =
                new URL(request.url);

            if (url.pathname === "/api/chats") {

                const client =
                    await getTelegramClient(env);

                const dialogs =
                    await client.getDialogs({});

                return json(
                    dialogs.map(dialog => ({
                        id:
                            dialog.id?.toString() ??
                            null,

                        name:
                            dialog.title ??
                            dialog.name ??
                            dialog.id?.toString() ??
                            "Unknown"
                    }))
                );
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
                            chatId
                        },
                        404
                    );
                }

                const messages =
                    await client.getMessages(
                        dialog,
                        {
                            limit: 10
                        }
                    );

                return json(
                    messages.map(message => ({
                        id:
                            message.id,

                        date:
                            message.date
                                ? message.date.toISOString()
                                : null,

                        text:
                            message.message ||
                            "",

                        hasMedia:
                            !!message.media,

                        mediaType:
                            message.media
                                ? (
                                    message.media.className ||
                                    message.media.constructor?.name ||
                                    null
                                )
                                : null
                    }))
                );
            }

            return json(
                {
                    error:
                        "Not found",
                    path:
                        url.pathname
                },
                404
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
