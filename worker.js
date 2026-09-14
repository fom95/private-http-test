import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

export default {
    async fetch(request, env) {
        try {
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
                        connectionRetries: 1
                    }
                );

            await client.connect();

            return new Response(
                JSON.stringify({
                    worker: true,
                    telegram: true
                }),
                {
                    headers: {
                        "Content-Type":
                            "application/json"
                    }
                }
            );
        }
        catch (error) {
            return new Response(
                JSON.stringify({
                    telegram: false,
                    error:
                        error?.message ||
                        String(error),
                    name:
                        error?.name ||
                        null,
                    stack:
                        error?.stack ||
                        null
                }),
                {
                    status: 500,
                    headers: {
                        "Content-Type":
                            "application/json"
                    }
                }
            );
        }
    }
};
