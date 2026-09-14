export default {
    async fetch(request, env) {
        return new Response(
            JSON.stringify({
                worker: true,
                apiId: !!env.API_ID,
                apiHash: !!env.API_HASH,
                session: !!env.TELEGRAM_SESSION
            }),
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
    }
};
