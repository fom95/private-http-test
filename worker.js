import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

let telegramClientPromise = null;
let chatMap = new Map();

async function getTelegramClient(env) {
    if (!telegramClientPromise) {
        telegramClientPromise = (async () => {
            const apiId = Number(await env.API_ID.get());
            const apiHash = await env.API_HASH.get();
            const session = await env.TELEGRAM_SESSION.get();

            const client = new TelegramClient(
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
        JSON.stringify(data),
        {
            status,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
            }
        }
    );
}

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);

            if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type"
                    }
                });
            }

            const client = await getTelegramClient(env);

            if (url.pathname === "/api/chats") {
                chatMap = new Map();

                const chats = [];

                for await (const dialog of client.iterDialogs({})) {
                    const entity = dialog.entity;

                    if (!entity) {
                        continue;
                    }

                    const chatId =
                        entity.id?.toString() ??
                        dialog.id?.toString();

                    if (chatId == null) {
                        continue;
                    }

                    chatMap.set(chatId, dialog);

                    chats.push({
                        id: chatId,
                        name:
                            dialog.title ||
                            entity.title ||
                            entity.firstName ||
                            entity.username ||
                            chatId
                    });
                }

                return json(chats);
            }

            if (url.pathname === "/api/messages") {
                const chatId = url.searchParams.get("chatId");

                if (!chatId) {
                    return json(
                        { error: "Missing chatId" },
                        400
                    );
                }

                let dialog = chatMap.get(chatId);

                if (!dialog) {
                    for await (const candidate of client.iterDialogs({})) {
                        const entity = candidate.entity;

                        if (!entity) {
                            continue;
                        }

                        const candidateId =
                            entity.id?.toString() ??
                            candidate.id?.toString();

                        if (candidateId === chatId) {
                            dialog = candidate;
                            chatMap.set(chatId, candidate);
                            break;
                        }
                    }
                }

                if (!dialog) {
                    return json(
                        { error: "Chat not found" },
                        404
                    );
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
                    messages.push({
                        id: message.id,
                        date: message.date
                            ? message.date.toISOString()
                            : null,
                        text: message.message || "",
                        media: message.media
                            ? {
                                type:
                                    message.media.className ||
                                    message.media.constructor?.name ||
                                    null
                            }
                            : null
                    });
                }

                return json(messages);
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
                    error: error?.message || String(error),
                    name: error?.name || null,
                    stack: error?.stack || null
                },
                500
            );
        }
    }
};
