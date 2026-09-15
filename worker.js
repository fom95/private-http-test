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

async function handleMediaRequest(request,env,chatId,messageId) {
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
        const chat=await getChatForId(client,numericChatId);

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
        const isThumbnail=thumbParam!==null;

        let fileId=media.fileId;
        let fileSize=Number(media.fileSize||0);
        let contentType=media.mimeType||"application/octet-stream";
        let fileName=media.fileName||null;

        if(isThumbnail) {
            const thumbIndex=Number(thumbParam);

            if(!Number.isInteger(thumbIndex) ||
               thumbIndex<0 ||
               thumbIndex>=thumbnails.length)
                return json({
                    success:false,
                    error:"Invalid thumbnail index."
                },400);

            const thumb=thumbnails[thumbIndex];

            if(!thumb?.fileId)
                return json({
                    success:false,
                    error:"Thumbnail has no file ID."
                },404);

            fileId=thumb.fileId;
            fileSize=Number(thumb.fileSize||0);
            contentType=thumb.mimeType||
                media.mimeType||
                "application/octet-stream";
            fileName=null;
        }

        if(!fileId)
            return json({
                success:false,
                error:"Media has no file ID."
            },404);

        const rangeHeader=request.headers.get("Range");

        let rangeStart=0;
        let rangeEnd=fileSize>0?fileSize-1:null;
        let partial=false;

        if(rangeHeader) {
            const match=/^bytes=(\d*)-(\d*)$/i.exec(
                rangeHeader.trim()
            );

            if(!match)
                return new Response(null,{
                    status:416,
                    headers:{
                        "Content-Range":`bytes */${fileSize}`
                    }
                });

            const startText=match[1];
            const endText=match[2];

            if(startText==="") {
                const suffixLength=Number(endText);

                if(!Number.isFinite(suffixLength) ||
                   suffixLength<=0 ||
                   fileSize<=0)
                    return new Response(null,{
                        status:416,
                        headers:{
                            "Content-Range":`bytes */${fileSize}`
                        }
                    });

                rangeStart=Math.max(0,fileSize-suffixLength);
                rangeEnd=fileSize-1;
            } else {
                rangeStart=Number(startText);

                if(!Number.isSafeInteger(rangeStart) ||
                   rangeStart<0 ||
                   rangeStart>=fileSize)
                    return new Response(null,{
                        status:416,
                        headers:{
                            "Content-Range":`bytes */${fileSize}`
                        }
                    });

                if(endText==="") {
                    rangeEnd=fileSize-1;
                } else {
                    rangeEnd=Number(endText);

                    if(!Number.isSafeInteger(rangeEnd) ||
                       rangeEnd<rangeStart)
                        return new Response(null,{
                            status:416,
                            headers:{
                                "Content-Range":`bytes */${fileSize}`
                            }
                        });

                    rangeEnd=Math.min(rangeEnd,fileSize-1);
                }
            }

            partial=true;
        }

        const requestedLength=
            rangeEnd===null
                ?null
                :rangeEnd-rangeStart+1;

        const headers={
            "Accept-Ranges":"bytes",
            "Cache-Control":"public, max-age=31536000, immutable",
            "Content-Type":contentType
        };

        if(fileName) {
            headers["Content-Disposition"]=
                `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
        }

        if(fileSize>0 && rangeEnd!==null) {
            headers["Content-Length"]=String(requestedLength);

            if(partial) {
                headers["Content-Range"]=
                    `bytes ${rangeStart}-${rangeEnd}/${fileSize}`;
            }
        }

        if(request.method==="HEAD") {
            return new Response(null,{
                status:partial?206:200,
                headers
            });
        }

        const download=client.download(fileId,{
            offset:rangeStart,
            signal:request.signal
        });

        if(isThumbnail) {
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

            if(detected) {
                contentType=detected;
                headers["Content-Type"]=detected;
            }

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
    } finally {
        try {
            await client.disconnect();
        } catch {}
    }
}

async function testDownload(env,chatId,messageId) {
    const numericChatId=Number(chatId);
    const numericMessageId=Number(messageId);

    if(!Number.isSafeInteger(numericChatId) ||
       !Number.isSafeInteger(numericMessageId))
        return {
            success:false,
            error:"Invalid chat or message ID."
        };

    const client=await getTelegramClient(env);

    try {
        const chat=await getChatForId(client,numericChatId);

        await client.getInputPeer(chat.id);

        const message=await client.getMessage(
            chat.id,
            numericMessageId
        );

        if(!message)
            throw new Error("Message not found.");

        const media=getMessageMedia(message);

        if(!media)
            throw new Error("Message has no supported media.");

        const started=Date.now();
        let bytesDownloaded=0;
        let chunks=0;

        const download=client.download(media.fileId);

        for await(const chunk of download) {
            bytesDownloaded+=chunk.length;
            chunks++;
        }

        return {
            success:true,
            test:"mtkruto-download-discard",
            chatId:String(chat.id),
            messageId:String(message.id),
            fileId:media.fileId,
            fileSize:media.fileSize??null,
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

    if(path==="/")
        return html(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Telegram Media Test</title>
<style>
body{
    font-family:system-ui,sans-serif;
    margin:30px;
    max-width:1100px
}
select,button{
    font-size:16px;
    padding:6px;
    margin:4px
}
a{
    display:block;
    margin:8px 0
}
pre{
    white-space:pre-wrap;
    word-break:break-word
}
.media-link{
    font-weight:bold;
    font-size:18px
}
.warning{
    margin-top:20px;
    padding:12px;
    border:1px solid #888
}
</style>
</head>
<body>

<h1>Telegram Media Test</h1>

<div>
<label>
Chat:
<select id="chat"></select>
</label>
</div>

<div>
<label>
Message:
<select id="message"></select>
</label>
</div>

<div id="details"></div>

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

    const r=await fetch(
        "/api/messages?chat="+encodeURIComponent(id)
    );

    const data=await r.json();

    if(!data.success){
        details.innerHTML=
            "<pre>"+
            escapeHtml(JSON.stringify(data,null,2))+
            "</pre>";
        return;
    }

    messages=data.messages||[];
    messageSelect.innerHTML="";

    for(const message of messages){
        const o=document.createElement("option");

        o.value=message.id;

        const media=message.media;

        const label=
            "#"+message.id+
            (media?.fileName
                ?" - "+media.fileName
                :"")+
            (media?.type
                ?" ["+media.type+"]"
                :"");

        o.textContent=label;
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
    const chat=Number(chatSelect.value);
    const id=Number(message.id);

    const mediaUrl=
        location.origin+
        "/media/"+chat+"/"+id;

    let out="<h2>Message #"+id+"</h2>";

    /*
     * Deliberately no <img> or <video> element is created here.
     * Media only loads when one of these links is clicked.
     */
    out+=
        "<p><a class=\\"media-link\\" "+
        "href=\\""+mediaUrl+"\\" "+
        "target=\\"_blank\\" "+
        "rel=\\"noopener\\">"+
        "Open media in new tab"+
        "</a></p>";

    /*
     * This version asks Cloudflare for structured JSON if the request
     * itself is tested manually, which makes a Cloudflare-generated
     * error easier to inspect.
     */
    out+=
        "<p><a href=\\""+mediaUrl+
        "\\" target=\\"_blank\\" rel=\\"noopener\\">"+
        "Open media request"+
        "</a></p>";

    out+=
        "<p><a href=\\"/api/messages?chat="+chat+"\\">"+
        "Open Messages API"+
        "</a></p>";

    out+=
        "<p><a href=\\"/api/chat?chat="+chat+"\\">"+
        "Open Chat API"+
        "</a></p>";

    if(media?.thumbnails?.length){
        out+="<h3>Thumbnails</h3>";

        for(const thumb of media.thumbnails){
            const u=
                "/media/"+chat+"/"+id+
                "?thumb="+thumb.index;

            out+=
                "<a href=\\""+u+
                "\\" target=\\"_blank\\" rel=\\"noopener\\">"+
                "Open thumbnail "+thumb.index+
                " ("+
                thumb.width+
                "x"+
                thumb.height+
                ")"+
                "</a>";
        }
    }

    out+="<h3>Media JSON</h3>";

    out+=
        "<pre>"+
        escapeHtml(JSON.stringify(media,null,2))+
        "</pre>";

    out+=
        "<p><a href=\\"/test-download/"+
        chat+
        "/"+
        id+
        "\\" target=\\"_blank\\" rel=\\"noopener\\">"+
        "Test full download"+
        "</a></p>";

    out+=
        "<div class=\\"warning\\">"+
        "<strong>Media is not loaded automatically.</strong><br>"+
        "Click the media link when you want to test the request. "+
        "It opens in a separate tab so a Cloudflare 1102 error "+
        "will not destroy this test page."+
        "</div>";

    details.innerHTML=out;
}

chatSelect.addEventListener("change",loadMessages);
messageSelect.addEventListener("change",showMessage);

loadChats();
</script>

</body>
</html>`);

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
                                    `${url.origin}/media/`+
                                    `${chat.id}/${message.id}`,
                                thumbnails:media.thumbnails.map(thumb=>({
                                    ...thumb,
                                    url:
                                        `${url.origin}/media/`+
                                        `${chat.id}/${message.id}`+
                                        `?thumb=${thumb.index}`
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

    const mediaMatch=
        path.match(/^\/media\/(-?\d+)\/(\d+)$/);

    if(mediaMatch)
        return handleMediaRequest(
            request,
            env,
            mediaMatch[1],
            mediaMatch[2]
        );

    const testMatch=
        path.match(/^\/test-download\/(-?\d+)\/(\d+)$/);

    if(testMatch) {
        const result=await testDownload(
            env,
            testMatch[1],
            testMatch[2]
        );

        return json(
            result,
            result.success?200:500
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
