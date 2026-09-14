export default {
    async fetch(request, env) {

        const apiId =
            await env.TELEGRAM_SECRETS
                .get("API_ID");

        const apiHash =
            await env.TELEGRAM_SECRETS
                .get("API_HASH");

        const session =
            await env.TELEGRAM_SECRETS
                .get("TELEGRAM_SESSION");

        return new Response(
            JSON.stringify({
                worker: true,
                apiId: !!apiId,
                apiHash: !!apiHash,
                session: !!session
            }),
            {
                headers: {
                    "Content-Type":
                        "application/json"
                }
            }
        );
    }
};
