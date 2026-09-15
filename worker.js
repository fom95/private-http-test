import { Client } from "@mtkruto/mtkruto";

const TELEGRAM_CHUNK_SIZE=256*1024;

function json(data,status=200,headers={}) {
    return new Response(JSON.stringify(data,null,2),{
        status,
        headers:{
            "Content-Type":"application/json; charset=utf-8",
            ...headers
        }
    });
}

function html(body,status=200) {
    return new Response(body,{
        status,
        headers:{"Content-Type":"text/html; charset=utf-8"}
    });
}

function errorInfo(error) {
    return {
        error:String(error?.message||error),
        name:error?.name||null,
        stack:error?.stack||null
    };
}

async function getTelegramClient(env) {
    const apiId=Number(await env.API_ID.get());
    const apiHash=await env.API_HASH.get();
    const authString=await env.MTKRUTO_SESSION.get();

    const client=new Client({
        apiId,
        apiHash,
        authString,
        persistCache:false,
        defaultHandlers:false,
        disableUpdates:true
    });

    await client.connect();

    return client;
}

function getMessageMedia(message) {
    switch(message?.type) {
        case "photo":
        case "livePhoto":
            return message.photo||null;

        case "document":
            return message.document||null;

        case "video":
            return message.video||null;

        case "animation":
            return message.animation||null;

        case "audio":
            return message.audio||null;

        case "voice":
            return message.voice||null;

        case "videoNote":
            return message.videoNote||null;

        case "sticker":
            return message.sticker||null;

        default:
            return null;
    }
}

function getMediaThumbnails(media) {
    if(Array.isArray(media?.thumbnails) && media.thumbnails.length)
        return media.thumbnails;

    if(media?.thumbnail)
        return [media.thumbnail];

    return [];
}

function getMessageMediaInfo(message) {
    const media=getMessageMedia(message);

    if(!media) {
        return {
            hasMedia:false,
            type:null
        };
    }

    const thumbnails=getMediaThumbnails(media);

    let mimeType=media.mimeType||null;

    /*
     * Telegram Photo media is image data, but MTKruto's Photo object
     * does not expose mimeType. Telegram photos are JPEG files.
     */
    if(!mimeType &&
       (message.type==="photo"||message.type==="livePhoto"))
        mimeType="image/jpeg";

    return {
        hasMedia:true,
        type:message.type,
        fileId:media.fileId||null,
        fileSize:media.fileSize??null,
        fileName:media.fileName||null,
        mimeType,
        width:media.width??null,
        height:media.height??null,
        duration:media.duration??null,
        thumbnailCount:thumbnails.length,
        thumbnails:thumbnails.map((thumb,index)=>({
            index,
            fileId:thumb.fileId||null,
            fileUniqueId:thumb.fileUniqueId||null,
            fileSize:thumb.fileSize??null,
            width:thumb.width??null,
            height:thumb.height??null
        }))
    };
}

function detectImageMimeType(bytes) {
    if(bytes.length>=3 &&
       bytes[0]===0xff &&
       bytes[1]===0xd8 &&
       bytes[2]===0xff)
        return "image/jpeg";

    if(bytes.length>=8 &&
       bytes[0]===0x89 &&
       bytes[1]===0x50 &&
       bytes[2]===0x4e &&
       bytes[3]===0x47 &&
       bytes[4]===0x0d &&
       bytes[5]===0x0a &&
       bytes[6]===0x1a &&
       bytes[7]===0x0a)
        return "image/png";

    if(bytes.length>=6) {
        const s=new TextDecoder().decode(bytes.slice(0,6));

        if(s==="GIF87a"||s==="GIF89a")
            return "image/gif";
    }

    if(bytes.length>=12 &&
       bytes[0]===0x52 &&
       bytes[1]===0x49 &&
       bytes[2]===0x46 &&
       bytes[3]===0x46 &&
       bytes[8]===0x57 &&
       bytes[9]===0x45 &&
       bytes[10]===0x42 &&
       bytes[11]===0x50)
        return "image/webp";

    if(bytes.length>=12) {
        const s=new TextDecoder().decode(bytes.slice(4,12));

        if(s==="ftypavif"||s==="ftypavis")
            return "image/avif";

        if(s==="ftypheic"||
           s==="ftypheix"||
           s==="ftyphevc"||
           s==="ftyphevx")
            return "image/heic";
    }

    return null;
}

async function getChatForId(client,chatId) {
    const numericChatId=Number(chatId);

    if(!Number.isSafeInteger(numericChatId))
        throw new Error(`Invalid chat ID: ${chatId}`);

    const result=await client.getChats({
        from:"main",
        limit:100
    });

    const items=Array.isArray(result)
        ?result
        :(result?.chats||[]);

    for(const item of items) {
        const chat=item?.chat||item;

        if(chat && Number(chat.id)===numericChatId)
            return chat;
    }

    throw new Error(
        `Chat ${numericChatId} was not found in the accessible chat list.`
    );
}

async function getMessages(client,chatId) {
    const numericChatId=Number(chatId);

    if(!Number.isSafeInteger(numericChatId))
        throw new Error(`Invalid chat ID: ${chatId}`);

    const chat=await getChatForId(client,numericChatId);

    await client.getInputPeer(chat.id);

    const messages=await client.getHistory(chat.id,{
        limit:100
    });

    return {
        chat,
        messages
    };
}

function parseRange(rangeHeader,fileSize) {
    if(!rangeHeader)
        return {
            partial:false,
            start:0,
            end:fileSize>0?fileSize-1:null
        };

    if(!fileSize)
        return null;

    const match=/^bytes=(\d*)-(\d*)$/i.exec(
        rangeHeader.trim()
    );

    if(!match)
        return null;

    const startText=match[1];
    const endText=match[2];

    let start;
    let end;

    if(startText==="") {
        const suffixLength=Number(endText);

        if(!Number.isSafeInteger(suffixLength) ||
           suffixLength<=0)
            return null;

        start=Math.max(0,fileSize-suffixLength);
        end=fileSize-1;
    } else {
        start=Number(startText);

        if(!Number.isSafeInteger(start) ||
           start<0 ||
           start>=fileSize)
            return null;

        if(endText==="") {
            end=fileSize-1;
        } else {
            end=Number(endText);

            if(!Number.isSafeInteger(end) ||
               end<start)
                return null;

            end=Math.min(end,fileSize-1);
        }
    }

    return {
        partial:true,
        start,
        end
    };
}

function createResponseHeaders(
    fileSize,
    range,
    contentType,
    fileName
) {
    const start=range?.start||0;
    const end=range?.end??(
        fileSize>0
            ?fileSize-1
            :null
    );

    const partial=range?.partial||false;

    const headers={
        "Accept-Ranges":"bytes",
        "Cache-Control":"public, max-age=31536000, immutable",
        "Content-Type":contentType
    };

    if(fileName) {
        /*
         * Explicitly inline rather than attachment.
         */
        headers["Content-Disposition"]=
            `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }

    if(fileSize>0 && end!==null) {
        headers["Content-Length"]=
            String(end-start+1);

        if(partial) {
            headers["Content-Range"]=
                `bytes ${start}-${end}/${fileSize}`;
        }
    }

    return {
        headers,
        start,
        end,
        partial,
        length:
            end===null
                ?null
                :end-start+1
    };
}

/*
 * Download the exact HTTP range using MTKruto's downloadChunk().
 *
 * This deliberately does NOT use client.download().
 * downloadChunk() returns one Uint8Array for the requested portion,
 * avoiding the async-generator streaming behavior that was producing
 * the 0-byte request.
 *
 * MTKruto's current documentation explicitly provides downloadChunk()
 * for downloading a specific chunk and shows 256 KiB as its example.
 */
async function streamRange(
    request,
    client,
    fileId,
    start,
    length,
    signal
) {
    const stream=new ReadableStream({
        async start(controller) {
            let offset=start;
            let remaining=length;

            try {
                while(remaining>0) {
                    const amount=Math.min(
                        TELEGRAM_CHUNK_SIZE,
                        remaining
                    );

                    const chunk=
                        await client.downloadChunk(
                            fileId,
                            {
                                chunkSize:amount,
                                offset,
                                signal
                            }
                        );

                    if(!chunk || chunk.length===0)
                        throw new Error(
                            `Telegram returned an empty chunk at offset ${offset}.`
                        );

                    /*
                     * Telegram/MTKruto should return no more than the
                     * requested chunk, but don't trust that blindly.
                     */
                    const bytes=
                        chunk.length>remaining
                            ?chunk.slice(0,remaining)
                            :chunk;

                    controller.enqueue(bytes);

                    offset+=bytes.length;
                    remaining-=bytes.length;

                    if(bytes.length===0)
                        throw new Error(
                            `Telegram returned a zero-byte chunk at offset ${offset}.`
                        );
                }

                controller.close();
            } catch(error) {
                controller.error(error);
            }
        }
    });

    return stream;
}

async function handleDirectMediaRequest(
    request,
    env,
    fileId,
    fileSize,
    contentType,
    fileName,
    isThumbnail=false
) {
    if(!fileId)
        return json({
            success:false,
            error:"Missing Telegram file ID."
        },400);

    const numericSize=Number(fileSize||0);

    const range=parseRange(
        request.headers.get("Range"),
        numericSize
    );

    if(request.headers.has("Range") && !range) {
        return new Response(null,{
            status:416,
            headers:{
                "Content-Range":
                    `bytes */${numericSize}`
            }
        });
    }

    const info=createResponseHeaders(
        numericSize,
        range,
        contentType,
        fileName
    );

    if(request.method==="HEAD") {
        return new Response(null,{
            status:info.partial?206:200,
            headers:info.headers
        });
    }

    const client=await getTelegramClient(env);

    /*
     * IMPORTANT:
     *
     * Do not disconnect here after returning the Response.
     * The stream still needs the Telegram client.
     *
     * The stream's cancellation/completion lifecycle owns the client.
     */
    try {
        let actualContentType=contentType;

        /*
         * Only thumbnails are MIME-sniffed.
         *
         * Full Telegram Photos are already explicitly image/jpeg.
         * Full Documents retain their Telegram-provided MIME type.
         */
        if(isThumbnail) {
            const probe=await client.downloadChunk(
                fileId,
                {
                    chunkSize:Math.min(
                        TELEGRAM_CHUNK_SIZE,
                        info.length||TELEGRAM_CHUNK_SIZE
                    ),
                    offset:info.start,
                    signal:request.signal
                }
            );

            const detected=detectImageMimeType(probe);

            if(detected)
                actualContentType=detected;

            info.headers["Content-Type"]=
                actualContentType;

            /*
             * The probe already contains the first bytes.
             * Rather than download them again, build a stream which
             * emits the probe and then requests only the remainder.
             */
            const stream=new ReadableStream({
                async start(controller) {
                    let remaining=info.length;
                    let offset=info.start;

                    try {
                        let first=probe;

                        if(first.length>remaining)
                            first=first.slice(0,remaining);

                        if(first.length>0) {
                            controller.enqueue(first);
                            remaining-=first.length;
                            offset+=first.length;
                        }

                        while(remaining>0) {
                            const amount=Math.min(
                                TELEGRAM_CHUNK_SIZE,
                                remaining
                            );

                            const chunk=
                                await client.downloadChunk(
                                    fileId,
                                    {
                                        chunkSize:amount,
                                        offset,
                                        signal:request.signal
                                    }
                                );

                            if(!chunk || chunk.length===0)
                                throw new Error(
                                    `Telegram returned an empty thumbnail chunk at offset ${offset}.`
                                );

                            const bytes=
                                chunk.length>remaining
                                    ?chunk.slice(0,remaining)
                                    :chunk;

                            controller.enqueue(bytes);

                            offset+=bytes.length;
                            remaining-=bytes.length;
                        }

                        controller.close();
                    } catch(error) {
                        controller.error(error);
                    } finally {
                        try {
                            await client.disconnect();
                        } catch {}
                    }
                },

                async cancel() {
                    try {
                        await client.disconnect();
                    } catch {}
                }
            });

            return new Response(stream,{
                status:info.partial?206:200,
                headers:info.headers
            });
        }

        /*
         * Normal media.
         *
         * Keep the MTKruto client alive until the stream finishes.
         */
        const stream=new ReadableStream({
            async start(controller) {
                try {
                    const body=await streamRange(
                        request,
                        client,
                        fileId,
                        info.start,
                        info.length,
                        request.signal
                    );

                    const reader=body.getReader();

                    try {
                        while(true) {
                            const result=
                                await reader.read();

                            if(result.done)
                                break;

                            controller.enqueue(
                                result.value
                            );
                        }

                        controller.close();
                    } finally {
                        try {
                            reader.releaseLock();
                        } catch {}
                    }
                } catch(error) {
                    controller.error(error);
                } finally {
                    try {
                        await client.disconnect();
                    } catch {}
                }
            },

            async cancel() {
                try {
                    await client.disconnect();
                } catch {}
            }
        });

        return new Response(stream,{
            status:info.partial?206:200,
            headers:info.headers
        });
    } catch(error) {
        try {
            await client.disconnect();
        } catch {}

        throw error;
    }
}

async function handleLegacyMediaRequest(
    request,
    env,
    chatId,
    messageId
) {
    const numericChatId=Number(chatId);
    const numericMessageId=Number(messageId);

    if(!Number.isSafeInteger(numericChatId) ||
       !Number.isSafeInteger(numericMessageId))
        return json({
            success:false,
            error:"Invalid chat or message ID."
        },400);

    const client=await getTelegramClient(env);

    try {
        const chat=await getChatForId(
            client,
            numericChatId
        );

        await client.getInputPeer(chat.id);

        const message=await client.getMessage(
            chat.id,
            numericMessageId
        );

        if(!message)
            return json({
                success:false,
                error:"Message not found."
            },404);

        const media=getMessageMedia(message);

        if(!media)
            return json({
                success:false,
                error:"Message has no supported media."
            },404);

        const thumbnails=getMediaThumbnails(media);
        const url=new URL(request.url);
        const thumbParam=url.searchParams.get("thumb");

        if(thumbParam!==null) {
            const index=Number(thumbParam);

            if(!Number.isInteger(index) ||
               index<0 ||
               index>=thumbnails.length)
                return json({
                    success:false,
                    error:"Invalid thumbnail index."
                },400);

            const thumb=thumbnails[index];

            const response=await handleDirectMediaRequest(
                request,
                env,
                thumb.fileId,
                Number(thumb.fileSize||0),
                "application/octet-stream",
                null,
                true
            );

            /*
             * handleDirectMediaRequest creates its own client.
             */
            try {
                await client.disconnect();
            } catch {}

            return response;
        }

        let mimeType=media.mimeType||
            "application/octet-stream";

        if(!mimeType &&
           (message.type==="photo"||
            message.type==="livePhoto"))
            mimeType="image/jpeg";

        try {
            await client.disconnect();
        } catch {}

        return handleDirectMediaRequest(
            request,
            env,
            media.fileId,
            Number(media.fileSize||0),
            mimeType,
            media.fileName||null,
            false
        );
    } catch(error) {
        try {
            await client.disconnect();
        } catch {}

        throw error;
    }
}

async function testDownload(
    env,
    fileId,
    fileSize
) {
    if(!fileId)
        return {
            success:false,
            error:"Missing file ID."
        };

    const client=await getTelegramClient(env);

    try {
        const started=Date.now();
        let bytesDownloaded=0;
        let chunks=0;
        let offset=0;

        const size=Number(fileSize||0);

        /*
         * Use downloadChunk for the diagnostic as well, so this
         * test exercises the same path as media requests.
         */
        while(offset<size) {
            const amount=Math.min(
                TELEGRAM_CHUNK_SIZE,
                size-offset
            );

            const chunk=
                await client.downloadChunk(
                    fileId,
                    {
                        chunkSize:amount,
                        offset
                    }
                );

            if(!chunk || chunk.length===0)
                throw new Error(
                    `Telegram returned an empty chunk at offset ${offset}.`
                );

            bytesDownloaded+=chunk.length;
            offset+=chunk.length;
            chunks++;
        }

        return {
            success:true,
            test:"mtkruto-downloadChunk-discard",
            fileId,
            fileSize:size,
            bytesDownloaded,
            chunks,
            chunkSize:TELEGRAM_CHUNK_SIZE,
            elapsedMs:Date.now()-started
        };
    } catch(error) {
        return {
            success:false,
            ...errorInfo(error)
        };
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

async function main(request,env) {
    const url=new URL(request.url);
    const path=url.pathname;

    if(path==="/") {
        return html(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Media Test</title>

<style>
:root{
    color-scheme:dark;
}

*{
    box-sizing:border-box;
}

body{
    margin:0;
    padding:32px;
    background:#101214;
    color:#e5e7eb;
    font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}

main{
    max-width:1000px;
    margin:0 auto;
}

h1{
    margin-top:0;
    color:#fff;
}

h2,h3{
    color:#fff;
}

.panel{
    background:#181b1f;
    border:1px solid #30343a;
    border-radius:8px;
    padding:18px;
    margin:16px 0;
}

.section{
    margin-top:20px;
    padding-top:18px;
    border-top:1px solid #30343a;
}

.section:first-child{
    margin-top:0;
    padding-top:0;
    border-top:0;
}

label{
    display:block;
    margin-bottom:8px;
    color:#aaa;
}

select{
    width:100%;
    max-width:700px;
    background:#22262b;
    color:#eee;
    border:1px solid #41464d;
    border-radius:5px;
    padding:8px;
    font-size:15px;
}

a{
    display:block;
    margin:9px 0;
    color:#79b9ff;
    text-decoration:none;
}

a:hover{
    text-decoration:underline;
}

.media-link{
    color:#8ed1ff;
    font-size:17px;
    font-weight:600;
}

pre{
    white-space:pre-wrap;
    word-break:break-word;
    background:#0b0d0f;
    border:1px solid #292d32;
    border-radius:5px;
    padding:12px;
    overflow:auto;
}

.warning{
    color:#999;
    font-size:14px;
    line-height:1.5;
}

.empty{
    color:#777;
}
</style>
</head>

<body>
<main>

<h1>Telegram Media Test</h1>

<div class="panel">

<div class="section">
<label for="chat">Chat</label>
<select id="chat"></select>
</div>

<div class="section">
<label for="message">Message</label>
<select id="message"></select>
</div>

</div>

<div id="details"></div>

</main>

<script>
const chatSelect=document.getElementById("chat");
const messageSelect=document.getElementById("message");
const details=document.getElementById("details");

let chats=[];
let messages=[];

async function loadChats(){
    const r=await fetch("/api/chats");
    const data=await r.json();

    chats=data.chats||[];

    chatSelect.innerHTML="";

    for(const chat of chats){
        const o=document.createElement("option");

        o.value=chat.id;

        o.textContent=
            chat.title||
            [chat.firstName,chat.lastName]
                .filter(Boolean)
                .join(" ")||
            String(chat.id);

        chatSelect.appendChild(o);
    }

    await loadMessages();
}

async function loadMessages(){
    const id=Number(chatSelect.value);

    details.innerHTML=
        '<div class="panel">'+
        '<div class="empty">Loading messages...</div>'+
        '</div>';

    const r=await fetch(
        "/api/messages?chat="+encodeURIComponent(id)
    );

    const data=await r.json();

    if(!data.success){
        details.innerHTML=
            '<div class="panel"><pre>'+
            escapeHtml(JSON.stringify(data,null,2))+
            "</pre></div>";
        return;
    }

    messages=data.messages||[];
    messageSelect.innerHTML="";

    for(const message of messages){
        const o=document.createElement("option");

        o.value=message.id;

        const media=message.media;

        o.textContent=
            "#"+message.id+
            (media?.fileName
                ?" - "+media.fileName
                :"")+
            (media?.type
                ?" ["+media.type+"]"
                :"");

        messageSelect.appendChild(o);
    }

    showMessage();
}

function escapeHtml(s){
    return s.replace(/[&<>"']/g,c=>({
        "&":"&amp;",
        "<":"&lt;",
        ">":"&gt;",
        '"':"&quot;",
        "'":"&#39;"
    }[c]));
}

function showMessage(){
    const message=messages.find(
        m=>Number(m.id)===Number(messageSelect.value)
    );

    if(!message){
        details.innerHTML="";
        return;
    }

    const media=message.media;

    let out='<div class="panel">';

    out+="<h2>Message #"+message.id+"</h2>";

    if(message.text){
        out+='<div class="section">';
        out+="<h3>Message text</h3>";
        out+="<pre>"+
            escapeHtml(message.text)+
            "</pre>";
        out+="</div>";
    }

    out+='<div class="section">';
    out+="<h3>Message content</h3>";

    if(!media) {
        out+='<div class="empty">No supported media.</div>';
    } else {
        if(media.url) {
            out+=
                '<a class="media-link" '+
                'href="'+media.url+'" '+
                'target="_blank" '+
                'rel="noopener">'+
                "Open full media</a>";
        }

        if(media.thumbnails?.length) {
            out+="<h3>Thumbnails</h3>";

            for(const thumb of media.thumbnails) {
                if(!thumb.url)
                    continue;

                out+=
                    '<a href="'+thumb.url+'" '+
                    'target="_blank" '+
                    'rel="noopener">'+
                    "Open thumbnail "+
                    thumb.index+
                    " ("+
                    thumb.width+
                    "x"+
                    thumb.height+
                    ")</a>";
            }
        }
    }

    out+="</div>";

    out+='<div class="section">';
    out+="<h3>API / diagnostics</h3>";

    const chat=Number(chatSelect.value);

    out+=
        '<a href="/api/messages?chat='+chat+'" '+
        'target="_blank" rel="noopener">'+
        "Open Messages API</a>";

    out+=
        '<a href="/api/chat?chat='+chat+'" '+
        'target="_blank" rel="noopener">'+
        "Open Chat API</a>";

    if(media?.fileId) {
        const params=new URLSearchParams();

        params.set("file",media.fileId);

        if(media.fileSize!=null)
            params.set("size",String(media.fileSize));

        if(media.mimeType)
            params.set("type",media.mimeType);

        if(media.fileName)
            params.set("name",media.fileName);

        out+=
            '<a href="/media-info?'+
            params.toString()+
            '" target="_blank" rel="noopener">'+
            "Inspect media info</a>";

        out+=
            '<a href="/test-download?'+
            params.toString()+
            '" target="_blank" rel="noopener">'+
            "Test full Telegram download</a>";
    }

    out+="</div>";

    out+='<div class="section">';
    out+="<h3>Media information</h3>";

    out+="<pre>"+
        escapeHtml(
            JSON.stringify(media,null,2)
        )+
        "</pre>";

    out+="</div>";

    out+='<div class="section warning">';
    out+=
        "<strong>Media is never loaded automatically.</strong> "+
        "Clicking a content link starts the actual Telegram "+
        "download in a separate tab.";
    out+="</div>";

    out+="</div>";

    details.innerHTML=out;
}

chatSelect.addEventListener(
    "change",
    loadMessages
);

messageSelect.addEventListener(
    "change",
    showMessage
);

loadChats();
</script>

</body>
</html>`);
    }

    if(path==="/api/chats") {
        const client=await getTelegramClient(env);

        try {
            const result=await client.getChats({
                from:"main",
                limit:100
            });

            const items=Array.isArray(result)
                ?result
                :(result?.chats||[]);

            const chats=items.map(item=>{
                const chat=item?.chat||item;

                return {
                    id:chat?.id??null,
                    title:chat?.title??null,
                    firstName:chat?.firstName??null,
                    lastName:chat?.lastName??null,
                    username:chat?.username??null,
                    type:chat?.type??null
                };
            });

            return json({
                success:true,
                chats
            });
        } catch(error) {
            return json({
                success:false,
                ...errorInfo(error)
            },500);
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
    }

    if(path==="/api/chat") {
        const chatId=url.searchParams.get("chat");

        if(chatId===null)
            return json({
                success:false,
                error:"Missing chat parameter."
            },400);

        const client=await getTelegramClient(env);

        try {
            const chat=await getChatForId(
                client,
                Number(chatId)
            );

            return json({
                success:true,
                chat
            });
        } catch(error) {
            return json({
                success:false,
                ...errorInfo(error)
            },500);
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
    }

    if(path==="/api/messages") {
        const chatId=url.searchParams.get("chat");

        if(chatId===null)
            return json({
                success:false,
                error:"Missing chat parameter."
            },400);

        const client=await getTelegramClient(env);

        try {
            const {chat,messages}=await getMessages(
                client,
                Number(chatId)
            );

            return json({
                success:true,

                chat:{
                    id:chat.id,
                    title:chat.title??null,
                    firstName:chat.firstName??null,
                    lastName:chat.lastName??null,
                    username:chat.username??null,
                    type:chat.type??null
                },

                messages:messages.map(message=>{
                    const media=getMessageMediaInfo(message);

                    return {
                        id:message.id,
                        date:message.date??null,
                        type:message.type??null,
                        text:message.text??message.caption??"",

                        media:media.hasMedia
                            ?{
                                ...media,

                                url:
                                    `${url.origin}/media?`+
                                    `file=${encodeURIComponent(media.fileId)}`+
                                    `&size=${encodeURIComponent(media.fileSize??0)}`+
                                    `&type=${encodeURIComponent(media.mimeType||"application/octet-stream")}`+
                                    (media.fileName
                                        ?`&name=${encodeURIComponent(media.fileName)}`
                                        :""),

                                thumbnails:
                                    media.thumbnails.map(thumb=>({
                                        ...thumb,

                                        url:
                                            `${url.origin}/media?`+
                                            `file=${encodeURIComponent(thumb.fileId)}`+
                                            `&size=${encodeURIComponent(thumb.fileSize??0)}`+
                                            `&thumb=1`
                                    }))
                            }
                            :null
                    };
                })
            });
        } catch(error) {
            return json({
                success:false,
                chatId:String(chatId),
                ...errorInfo(error)
            },500);
        } finally {
            try {
                await client.disconnect();
            } catch {}
        }
    }

    /*
     * Preferred media endpoint.
     */
    if(path==="/media") {
        const fileId=url.searchParams.get("file");

        if(!fileId)
            return json({
                success:false,
                error:"Missing file parameter."
            },400);

        const fileSize=Number(
            url.searchParams.get("size")||0
        );

        const contentType=
            url.searchParams.get("type")||
            "application/octet-stream";

        const fileName=
            url.searchParams.get("name")||
            null;

        const isThumbnail=
            url.searchParams.has("thumb");

        return handleDirectMediaRequest(
            request,
            env,
            fileId,
            fileSize,
            contentType,
            fileName,
            isThumbnail
        );
    }

    if(path==="/media-info") {
        const fileId=url.searchParams.get("file");

        if(!fileId)
            return json({
                success:false,
                error:"Missing file parameter."
            },400);

        return json({
            success:true,
            fileId,
            fileSize:Number(
                url.searchParams.get("size")||0
            ),
            mimeType:
                url.searchParams.get("type")||
                null,
            fileName:
                url.searchParams.get("name")||
                null,
            thumbnail:url.searchParams.has("thumb")
        });
    }

    if(path==="/test-download") {
        const fileId=url.searchParams.get("file");

        const result=await testDownload(
            env,
            fileId,
            url.searchParams.get("size")
        );

        return json(
            result,
            result.success?200:500
        );
    }

    /*
     * Old URL compatibility.
     */
    const legacyMediaMatch=
        path.match(/^\/media\/(-?\d+)\/(\d+)$/);

    if(legacyMediaMatch) {
        return handleLegacyMediaRequest(
            request,
            env,
            legacyMediaMatch[1],
            legacyMediaMatch[2]
        );
    }

    return new Response("Not found",{
        status:404
    });
}

export default {
    async fetch(request,env) {
        try {
            return await main(request,env);
        } catch(error) {
            return json({
                success:false,
                ...errorInfo(error)
            },500);
        }
    }
};
