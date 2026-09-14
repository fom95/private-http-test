export default {
    async fetch(request, env) {
        try {
            const apiId =
                await env.API_ID.get();

            const apiHash =
                await env.API_HASH.get();

            const session =
                await env.TELEGRAM_SESSION.get();

            return new Response(
                JSON.stringify({
                    worker: true,
                    apiId: !!apiId,
                    apiHash: !!apiHash,
                    session: !!session
                }),
                {
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );
        }
        catch (error) {
            return new Response(
                JSON.stringify({
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
                        "Content-Type": "application/json"
                    }
                }
            );
        }
    }
};
