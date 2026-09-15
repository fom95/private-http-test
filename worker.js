import { Client } from "@mtkruto/mtkruto";

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

    return {
        hasMedia:true,
        type:message.type,
        fileId:media.fileId||null,
        fileSize:media.fileSize??null,
        fileName:media.fileName||null,
        mimeType:media.mimeType||null,
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

async function streamTelegramFile(
    request,
    client,
    fileId,
    fileSize,
    contentType,
    fileName,
    isThumbnail=false,
    thumbnailMimeDetect=false
) {
    const range=parseRange(
        request.headers.get("Range"),
        fileSize
    );

    if(request.headers.has("Range") && !range) {
        return new Response(null,{
            status:416,
            headers:{
                "Content-Range":`bytes */${fileSize}`
            }
        });
    }

    const start=range?.start||0;
    const end=range?.end??(
        fileSize>0
            ?fileSize-1
            :null
    );

    const partial=range?.partial||false;

    const requestedLength=
        end===null
            ?null
            :end-start+1;

    const headers={
        "Accept-Ranges":"bytes",
        "Cache-Control":"public, max-age=31536000, immutable",
        "Content-Type":contentType
    };

    if(fileName) {
        headers["Content-Disposition"]=
            `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }

    if(fileSize>0 && end!==null) {
        headers["Content-Length"]=String(requestedLength);

        if(partial) {
            headers["Content-Range"]=
                `bytes ${start}-${end}/${fileSize}`;
        }
    }

    if(request.method==="HEAD") {
        return new Response(null,{
            status:partial?206:200,
            headers
        });
    }

    const download=client.download(fileId,{
        offset:start,
        signal:request.signal
    });

    if(thumbnailMimeDetect) {
        const iterator=download[Symbol.asyncIterator]();
        const first=await iterator.next();

        if(first.done)
            return new Response(null,{
                status:404,
                headers:{
                    "Content-Type":"text/plain; charset=utf-8"
                }
            });

        const firstChunk=first.value;
        const detected=detectImageMimeType(firstChunk);

        if(detected)
            headers["Content-Type"]=detected;

        const stream=new ReadableStream({
            async start(controller) {
                let remaining=requestedLength;

                try {
                    let bytes=firstChunk;

                    if(remaining!==null) {
                        if(remaining<=0) {
                            controller.close();
                            return;
                        }

                        if(bytes.length>remaining)
                            bytes=bytes.slice(0,remaining);

                        remaining-=bytes.length;
                    }

                    controller.enqueue(bytes);

                    if(remaining===0) {
                        controller.close();
                        return;
                    }

                    while(true) {
                        const next=await iterator.next();

                        if(next.done)
                            break;

                        bytes=next.value;

                        if(remaining!==null) {
                            if(remaining<=0)
                                break;

                            if(bytes.length>remaining)
                                bytes=bytes.slice(0,remaining);

                            remaining-=bytes.length;
                        }

                        controller.enqueue(bytes);

                        if(remaining===0)
                            break;
                    }

                    controller.close();
                } catch(error) {
                    controller.error(error);
                }
            }
        });

        return new Response(stream,{
            status:partial?206:200,
            headers
        });
    }

    const stream=new ReadableStream({
        async start(controller) {
            let remaining=requestedLength;

            try {
                for await(const chunk of download) {
                    let bytes=chunk;

                    if(remaining!==null) {
                        if(remaining<=0)
                            break;

                        if(bytes.length>remaining)
                            bytes=bytes.slice(0,remaining);

                        remaining-=bytes.length;
                    }

                    controller.enqueue(bytes);

                    if(remaining===0)
                        break;
                }

                controller.close();
            } catch(error) {
                controller.error(error);
            }
        }
    });

    return new Response(stream,{
        status:partial?206:200,
        headers
    });
}

/*
 * New media endpoint.
 *
 * The fileId was already obtained from Telegram while building the
 * message API response. This endpoint therefore does NOT need to:
 *
 *   getChats()
 *   getInputPeer()
 *   getMessage()
 *
 * This is important for video Range requests.
 */
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

    const client=await getTelegramClient(env);

    try {
        return await streamTelegramFile(
            request,
            client,
            fileId,
            Number(fileSize||0),
            contentType||"application/octet-stream",
            fileName||null,
            isThumbnail,
            isThumbnail
        );
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

/*
 * Compatibility endpoint for old /media/chat/message URLs.
 *
 * New links do not use this path. It remains here so existing links
 * continue to work.
 */
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

            return await streamTelegramFile(
                request,
                client,
                thumb.fileId,
                Number(thumb.fileSize||0),
                "application/octet-stream",
                null,
                true,
                true
            );
        }

        /*
         * IMPORTANT:
         * Use the document/photo/video's original MIME type here.
         * Do not sniff the full document just because its contents
         * happen to be an image.
         */
        return await streamTelegramFile(
            request,
            client,
            media.fileId,
            Number(media.fileSize||0),
            media.mimeType||"application/octet-stream",
            media.fileName||null,
            false,
            false
        );
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

async function testDownload(env,fileId,fileSize) {
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

        const download=client.download(fileId);

        for await(const chunk of download) {
            bytesDownloaded+=chunk.length;
            chunks++;
        }

        return {
            success:true,
            test:"mtkruto-download-discard",
            fileId,
            fileSize:Number(fileSize||0),
            bytesDownloaded,
            chunks,
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
    background:#111315;
    color:#e7e7e7;
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

h2{
    margin-bottom:10px;
}

h3{
    margin-top:0;
    color:#fff;
}

.panel{
    background:#191c20;
    border:1px solid #30343a;
    border-radius:8px;
    padding:18px;
    margin:16px 0;
}

.section{
    margin-top:18px;
    padding-top:16px;
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
    color:#78b7ff;
    display:block;
    margin:9px 0;
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
    background:#0c0e10;
    border:1px solid #292d32;
    border-radius:5px;
    padding:12px;
    overflow:auto;
}

.warning{
    color:#bbb;
    font-size:14px;
    line-height:1.5;
}

.meta{
    color:#aaa;
    font-size:14px;
}

.empty{
    color:#888;
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
        '<div class="panel"><div class="empty">Loading messages...</div></div>';

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

function mediaUrl(media){
    if(!media?.fileId)
        return null;

    const params=new URLSearchParams();

    params.set("file",media.fileId);

    if(media.fileSize!=null)
        params.set("size",String(media.fileSize));

    if(media.mimeType)
        params.set("type",media.mimeType);

    if(media.fileName)
        params.set("name",media.fileName);

    return location.origin+"/media?"+params.toString();
}

function thumbnailUrl(media,index){
    const thumb=media?.thumbnails?.[index];

    if(!thumb?.fileId)
        return null;

    const params=new URLSearchParams();

    params.set("file",thumb.fileId);

    if(thumb.fileSize!=null)
        params.set("size",String(thumb.fileSize));

    params.set("thumb","1");

    return location.origin+"/media?"+params.toString();
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
        out+="<div class=\\"section\\">";
        out+="<h3>Message text</h3>";
        out+="<pre>"+
            escapeHtml(message.text)+
            "</pre>";
        out+="</div>";
    }

    /*
     * CONTENT LINKS
     */
    out+='<div class="section">';
    out+="<h3>Message content</h3>";

    if(!media) {
        out+='<div class="empty">No supported media.</div>';
    } else {
        const fullUrl=mediaUrl(media);

        if(fullUrl) {
            out+=
                '<a class="media-link" '+
                'href="'+fullUrl+'" '+
                'target="_blank" '+
                'rel="noopener">Open full media</a>';

            out+=
                '<a href="'+fullUrl+'" '+
                'target="_blank" '+
                'rel="noopener">Open media in new tab</a>';
        }

        if(media.thumbnails?.length) {
            out+="<h3>Thumbnails</h3>";

            for(const thumb of media.thumbnails) {
                const u=thumbnailUrl(
                    media,
                    thumb.index
                );

                if(!u)
                    continue;

                out+=
                    '<a href="'+u+'" '+
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

    /*
     * API LINKS
     */
    out+='<div class="section">';
    out+="<h3>API / diagnostics</h3>";

    const chat=Number(chatSelect.value);
    const id=Number(message.id);

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
            '<a href="/media-info?'+params.toString()+'" '+
            'target="_blank" rel="noopener">'+
            "Inspect media info</a>";

        out+=
            '<a href="/test-download?'+params.toString()+'" '+
            'target="_blank" rel="noopener">'+
            "Test full Telegram download</a>";
    }

    out+="</div>";

    /*
     * MEDIA METADATA
     */
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
        "<strong>Nothing above automatically loads media.</strong> "+
        "Opening a media link starts the actual Telegram download "+
        "in a separate tab.";
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

    /*
     * API: chat list
     */
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

    /*
     * API: individual chat
     */
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

    /*
     * API: messages
     */
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

                                /*
                                 * The important part:
                                 * media URLs contain the Telegram fileId,
                                 * so subsequent Range requests don't need
                                 * to retrieve the message again.
                                 */
                                url:
                                    `${url.origin}/media?`+
                                    `file=${encodeURIComponent(media.fileId)}`+
                                    `&size=${encodeURIComponent(media.fileSize??0)}`+
                                    `&type=${encodeURIComponent(media.mimeType||"application/octet-stream")}`+
                                    (media.fileName
                                        ?`&name=${encodeURIComponent(media.fileName)}`
                                        :""),

                                thumbnails:media.thumbnails.map(thumb=>({
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
     * Direct media endpoint.
     *
     * This is now the preferred path:
     *
     * /media?file=<telegram-file-id>&size=<size>&type=<mime>
     *
     * No Telegram message lookup occurs here.
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

    /*
     * Media metadata endpoint.
     *
     * This does not download anything from Telegram.
     */
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

    /*
     * Full-download diagnostic.
     */
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
     * Old media URL compatibility.
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
