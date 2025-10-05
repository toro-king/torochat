const express = require('express');
const app = express();

const uuid = require('uuid');
const fs = require('fs');

const WebSocket = require('ws');

app.set('trust proxy', 1)

const websocket = new WebSocket.Server({noServer: true})

const base_dir = '/home/ubuntu/webserver/torochat/newserver/'

let users = [];
try {
    users = require(base_dir + "accounts.json")
} catch {
    console.warn("Error loading accounts, starting fresh")
}
let validGuestUuids = new Set();

let messages = [];
try {
    messages = require(base_dir + "messages.json")
} catch {
    console.warn("Error loading messages, starting fresh")
}

let channels = [];
try {
    channels = require(base_dir + "channels.json")
} catch {
    console.warn("Error loading channels, starting fresh");
    channels= [
        {
            "name": "#general",
            "type": "public",
            "permissions": {
                "canReact": true,
                "canDelete": true,
                "canEdit": true,
                "canSeeMessageHistory": true,
                "canSendMessages": true,
                "canSendMessagesWithAttachments": true,
                "maxMessageLength": 500,
                "rateLimitType": "slowmode",
                "slowmode": 5,
                "rateLimitCount": 5,
                "rateLimitPeriod": 5000
            }
        }
    ]
}

let roles = [];
try {
    roles = require(base_dir + "roles.json")
} catch {
    console.warn("Error loading roles, starting fresh");
}

let rateLimits = [];
const genericRateLimits = {
    "change_channel": "6/2",
    "send_message": "10/5",
    "get_older_messages": "15/4",
    "get_surrounding_messages": "15/4",

}

let activeUsers = [];
let typingUsers = []

function getChannelPermissions(chan) {
    return channels.find(cha=>cha.name === chan)?.permissions
}

function userCanSeeChannel(channel, user) {
    if (!channel) return false;
    return true;
    // When it comes time to add dms add logic
}

function sanitize(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function sendUsersOnline() {
    const now = Date.now()
    activeUsers = activeUsers.map(u=>{
        const idleMs = now - u.lastUpdate
        if (idleMs > 60 * 1000)
            u.status = 2
        return u
    })
    const safeUsersForBroadcast = activeUsers.map(u=>{return {
        username: u.username,
        isGuest: u.isGuest,
        status: u.status,
        publicid: u.publicid
    }})
    sendForAllConnectedUsers({type: "online_users", data: safeUsersForBroadcast})
}

function sendTypingUsers() {
    const typingByChannel = {};
    typingUsers.forEach(t => {
        if (!typingByChannel[t.channel]) typingByChannel[t.channel] = [];
        typingByChannel[t.channel].push(t.publicid);
    });

    Object.entries(typingByChannel).forEach(([channel, pids]) => {
        sendForAllConnectedUsers({ type: "typing_users", data: pids }, channel);
    });
}

function channelsVisibleForUser(user) {
    return channels.filter(c=>{
        if (c.type === "public" || c.type === "private" && c.members.includes(user.privateid)) return true;
        return false;
    }).map(c=>c.name)
}

function processChatMessagesForPublicViewing(chatMsgs) {
    let msgs = [];
    if (!Array.isArray(chatMsgs)) chatMsgs = [chatMsgs]
    chatMsgs.forEach(chatMsg=>{
        const { username, loggedIn, publicid } = users.find(u=>u.privateid === chatMsg.by)
        msgs.push({
            ...chatMsg,
            by: publicid,
            username: username,
            isGuest: !loggedIn
        })
    })
    return msgs.length === 1 ? msgs[0] : msgs
}

async function sendForAllConnectedUsers(data, channel) {
    const clients = channel ? Array.from(websocket.clients).filter(a=>a.channel === channel) : Array.from(websocket.clients);
    clients.forEach(ws=>{
        if (ws.readyState === 1)
            ws.send(JSON.stringify(data))
    })
}

app.get('/', async (req,res)=>{
    if (!req.headers.cookie)
        return res.status(401).json({"success": false, "error": "I want to eat some of your cookies but you didn't provide any"})

    const cookies = Object.fromEntries(req.headers.cookie?.split('; ').map(cook=>cook.split("=",2)))
    const connectCookie = cookies['connect.sid']
    const guestAccountUuidCookie = cookies['guestAccountUuid']

    if (!connectCookie && !guestAccountUuidCookie)
        return res.status(401).json({"success": false, "error": "No connect.sid or guestAccountUuid cookie specified"})

    let user = {};

    if (guestAccountUuidCookie) {
        const guestAccount = users.find(a=>a.privateid === guestAccountUuidCookie)
        if (guestAccount) user = { "loggedIn": false, "username": guestAccount.username, "privateid": guestAccount.privateid }
        else {
            if (!validGuestUuids.has(guestAccountUuidCookie)) return res.status(403).json({"success": false, "error": "This guest account uuid doesn't exist. Please clear your cookies"})
            user = { "loggedIn": false, "username": "guest" + String(Math.floor(Math.random()*100000)).padEnd(5,"0"), "privateid": uuid.v4() }
        }
    }

    // If the user is loggedin overwrite
    try {
        const a = await fetch('http://127.0.0.1:8069/auth/test',{
            "headers": { "Cookie": req.headers.cookie }
        })
        const resp = await a.json()
        if (resp.loggedIn) {
            resp.privateid = resp.id;
            delete resp.id;
            user = resp;
        } else if (!user.username) {
            return res.status(401).json({"success": false, "error": "Connect.sid cookie not valid and u didnt provide a guest one so......"})
        }
    } catch (e) {
        console.warn("Error while attempting to authenticate logged in user.", e)
    }

    let userInUsers = users.find(u=>u.privateid === user.privateid)
    if (userInUsers && userInUsers.loggedIn && user.username !== userInUsers.username) userInUsers.username = user.username
    if (!userInUsers) {
        userInUsers = {
            ...user,
            publicid: uuid.v4(),
            roles: [],
            inbox: [],
            unreadChannels: [],
            registeredAt: Date.now(),
            creationIp: req.ip,
            activity: []
        }
        users.push(userInUsers);
    }

    if (!req.headers.upgrade)
        return res.status(200).json({"Success":true,"data":"All set! You can reconnect with a websocket connection."})

    return websocket.handleUpgrade(req,req.socket,"",(ws)=>{
        ws.user = { ...user, publicid: userInUsers.publicid }
        ws.channel = "#general"
        websocket.emit('connection',ws)
    })
})

app.get('/register',(req,res)=>{
    const acuuid = uuid.v4()
    validGuestUuids.add(acuuid)
    res.cookie('guestAccountUuid',acuuid,{
        httpOnly: true,
        sameSite: "strict",
        expires: new Date('9999-12-31')
    })
    res.status(200).json({"success":true,"uuid": acuuid})
})

websocket.on("connection",(ws)=>{
    const { username, isGuest, privateid, publicid } = ws.user
    activeUsers.push({
        username: username,
        isGuest: isGuest,
        privateid: privateid,
        publicid: publicid,
        status: 1,
        lastUpdate: Date.now()
    })
    console.log(username + (isGuest ? " \x1b[90m(guest)\x1b[0m" : " ") + "has connected.")
    sendUsersOnline()

    let userInUsers = users.find(u=>u.privateid === privateid)
    userInUsers.activity.push({
        type: "connect",
        data: null,
        ts: Date.now()
    })
    const userLastDisconnectTs = userInUsers.activity
                                 .filter(a=>a.type==="disconnect")
                                 .at(-1)
                                 .ts

    channelsVisibleForUser(ws.user).forEach(c=>{
        const messageAfterLeaveTs = messages.filter(m=>m.channel===c)
                                  .find(m=>m.timestamp > userLastDisconnectTs)
                                  ?.timestamp
        if (messageAfterLeaveTs && userInUsers.unreadChannels.findIndex(c2=>c2.channel === c) === -1) 
            userInUsers.unreadChannels.push({
                channel: c,
                unreadSince: messageAfterLeaveTs
            })
    })

    ws.send(JSON.stringify({ type:"unreadDms", data:userInUsers.unreadChannels }))
    ws.send(JSON.stringify({ type:"inbox", data:processChatMessagesForPublicViewing(messages.filter(msg=>userInUsers.inbox.includes(msg.id))) }))

    ws.onmessage = (ev) => {
        if (ev.data.length > 32767)
            return ws.terminate()

        try { var json = JSON.parse(ev.data) }
        catch (e) { 
            console.warn(e); 
            return ws.send(JSON.stringify({type:"error", error: "Invalid JSON" })); 
        }

        const type = json.type;
        if (!genericRateLimits[type])
            return ws.send(JSON.stringify({msgid:json.msgid, type:"error", error: "Unknown type" })); 
        const [ rateLimitAmount, rateLimitSecs ] = genericRateLimits[type].split('/')

        let rateLimitWs = rateLimits.find(r=> r.privateid === privateid && r.route === type)
        if (rateLimitWs?.count >= rateLimitAmount)
            return ws.send(JSON.stringify({msgid:json.msgid, type:"error", error: "Too many requests" }));
        if (!rateLimitWs) {
            rateLimitWs = {
                privateid: privateid,
                route: type,
                count: 0
            }
            rateLimits.push(rateLimitWs)
            setTimeout(()=>{
                rateLimits.splice(rateLimits.findIndex(r=>r.privateid=== privateid && r.route===type),1)
            }, Number(rateLimitSecs)*1000)
        }
        rateLimitWs.count++;

        if (ev.data.length > 4096)
            return ws.send(JSON.stringify({msgid:json.msgid, type:"error", error: "Too much data" }))

        onMessage(json,ws)
    }
    
    ws.onclose = (code) => {
        activeUsers.splice(activeUsers.findIndex(u=>u.privateid === privateid),1)
        console.log(username + (isGuest ? " \x1b[90m(guest)\x1b[0m" : " ") + "has disconnected. Reason: " + code.reason)

        userInUsers.activity.push({
            type: "disconnect",
            data: null,
            ts: Date.now()
        })
    }
})

function onMessage(msg,ws) {
    const { msgid } = msg;
    const { username, isGuest, privateid, publicid } = ws.user;

    const userpermissions = users
                      .find(u => u.privateid === privateid).roles
                      .map(name=>roles.find(role=>role.name === name))
                      .sort((a,b)=>a.level-b.level)
                      ?.[0].permissions
    const userInUsers = users.find(u=>u.privateid === privateid)

    switch (msg.type) {
        case "change_channel": {
            const { newChannel } = msg.data

            const channel = channels.find(a=>a.name===newChannel)

            if (!userCanSeeChannel(channel, ws.user))
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "This channel does not exist"}));

            ws.channel = newChannel

            const uindex = userInUsers.unreadChannels.findIndex(c=>c.channel===newChannel)
            if (uindex !== -1)
                userInUsers.unreadChannels.splice(uindex, 1)

            const permissions = getChannelPermissions(newChannel);
            ws.send(JSON.stringify({ msgid: msgid, type: "channel_permissions", data: permissions }))

            let historyToSend = [];
            if (permissions.canSeeMessageHistory === true) 
                historyToSend = messages.filter(m => m.channel === newChannel).slice(-50);
            ws.send(JSON.stringify({ msgid: msgid, type: 'chat_history', data: processChatMessagesForPublicViewing(historyToSend) }));
        } break;
        case "get_older_messages":
        case "get_newer_messages": {
            const { lastMsgId, limit: numMessages = 100 } = msg.data;
            if (!lastMsgId || typeof(lastMsgId) !== "string")
                return ws.send(JSON.stringify({ msgid:msgid, type: "error", error: "Please provide lastMsgId" }))
            const type = msg.type.slice(4)

            if (numMessages > 100)
                return ws.send(JSON.stringify({ msgid:msgid, type: "error", error: "Too many messages requested" }))

            if (!getChannelPermissions(ws.channel).canSeeMessageHistory && !userpermissions.administrator)
                return ws.send(JSON.stringify({ msgid:msgid, type: type, data: [] }))

            const index = messages.filter(m => m.channel === ws.channel).findIndex(m => m.id === lastMsgId);
            const foundMessages = type === "older_messages"
                             ? messages.slice(Math.max(0, index - numMessages), index)
                             : messages.slice(index + 1, index + 1 + numMessages);

            ws.send(JSON.stringify({ 
                msgid:msgid, 
                type: type, 
                data: processChatMessagesForPublicViewing(foundMessages) 
            }));
        } break;
        case "get_surrounding_messages": {
            const { messageId, limit = 25 } = msg.data;
            if (!messageId || typeof(messageId) !== "string")
                return ws.send(JSON.stringify({ msgid:msgid, type: "error", error: "Please provide messageId" }))

            if (!getChannelPermissions(ws.channel).canSeeMessageHistory && !userpermissions.administrator)
                return ws.send(JSON.stringify({ msgid:msgid, type: 'surrounding_messages', data: { messages: [], hasMoreNewer: false } }));

            const channelMessages = messages.filter(m => m.channel === ws.channel);
            const targetIndex = channelMessages.findIndex(m => m.id === messageId);

            if (targetIndex === -1)
                return ws.send(JSON.stringify({ msgid:msgid, type: 'surrounding_messages', data: { messages: [], hasMoreNewer: false } }));
            
            const endIndex = Math.min(channelMessages.length, targetIndex + 1 + limit);
            const combinedMessages = channelMessages.slice(Math.max(0, targetIndex - limit), endIndex);

            ws.send(JSON.stringify({
                msgid:msgid, type: 'surrounding_messages',
                data: {
                    messages: processChatMessagesForPublicViewing(combinedMessages),
                    hasMoreNewer: endIndex < channelMessages.length
                }
            }));
        } break;
        case "get_message_by_id": {
            const { messageId } = msg.data;
            if (!messageId || typeof(messageId) !== "string")
                return ws.send(JSON.stringify({ msgid:msgid, type: "error", error: "Please provide messageId" }))

            const targetMessage = messages.find(m => m.id === messageId);
            if (!targetMessage)
                return ws.send(JSON.stringify({ msgid:msgid, type: "error", error: "Message not found with that id" }))
            if (targetMessage.deleted)
                return ws.send(JSON.stringify({ msgid:msgid, type: "error", error: "That message is deleted" }))

            const targetMessageChannel = targetMessage.channel;
            if (!userpermissions.administrator && 
               (!getChannelPermissions(targetMessageChannel).canSeeMessageHistory || !userCanSeeChannel(targetMessageChannel, ws.user)))
                return ws.send(JSON.stringify({ msgid:msgid, type: "error", error: "You don't have permission to view this message" }))

            ws.send(JSON.stringify({ msgid:msgid, type: "message_by_id", data: processChatMessagesForPublicViewing(targetMessage) }))
        } break;

        // What once was HTTP, now fully Websocket
        case "update_status": {
            // This now simply updates a user's status rather than a bunch of other shite
            let { status } = msg.data;
            if (typeof(status) !== "number")
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "Must be a valid number"}))
            status = Math.round(status)
            if (status < 1 || status > 2)
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "Must be a valid number"}))

            const user = activeUsers[activeUsers.findIndex(u=>u.privateid === privateid)]
            user.status = status;
            user.lastUpdate = Date.now();
            ws.send(JSON.stringify({msgid:msgid, type: "ok"}))
        } break;
        case "send_message": {
            const { attachment, xss, additionalDetails} = msg.data;
            let { message } = msg.data;
            const channel = ws.channel

            const permissions = getChannelPermissions(channel);

            if (!permissions)
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "This channel does not exist"}));

            const maxMessageLength = permissions.maxMessageLength;
            const canSendMessages = permissions.canSendMessages
            const canSendMessagesWithAttachments = permissions.canSendMessagesWithAttachments;

            if (!canSendMessages && !userpermissions.administrator)
                return ws.send(JSON.stringify({ msgid: msgid, type: "error", error: "You can't send messages in this channel"}));
            if (attachment && !canSendMessagesWithAttachments && !userpermissions.administrator)
                return ws.send(JSON.stringify({ msgid: msgid, type: "error", error: "You can't send messages with attachments in this channel"}));

            if (maxMessageLength && message.length > maxMessageLength && !userpermissions.administrator)
                message = message.substring(0,maxMessageLength);

            const sanitizedMessage = xss && userpermissions.canXSS ? message : sanitize(message);

            const chatMsg = {
                id: uuid.v4(),
                by: privateid,
                message: sanitizedMessage,
                attachment: attachment,
                additionalDetails: additionalDetails,
                timestamp: Date.now(),
                channel: channel
            }

            messages.push(chatMsg)
            sendForAllConnectedUsers({type: "chat_message", data: processChatMessagesForPublicViewing(chatMsg)}, channel)

            websocket.clients.forEach(ws=>{
                const userInUsers = users.find(u=>u.privateid === ws.user.privateid)
                if (ws.channel !== channel && userInUsers.unreadChannels.findIndex(c=>c.channel === channel) === -1) {
                    userInUsers.unreadChannels.push({
                        channel: channel,
                        unreadSince: Date.now()
                    })
                    ws.send(JSON.stringify({type: "unread_message",data: channel}))
                }
            })

            const mentions = chatMsg.additionalDetails?.mentions
            if (mentions)
                mentions.forEach(m=>{
                    const userInUsers = users.find(u=>u.publicid === m.publicid)
                    if (userInUsers) {
                        userInUsers.inbox.push(chatMsg.id)
                        const wstarget = websocket.clients.find(ws2=>ws2.user.publicid === m.publicid)
                        if (wstarget && wstarget.channel !== channel)
                            wstarget.send(JSON.stringify({type: "mentions", data: processChatMessagesForPublicViewing(chatMsg)}))
                    }
                })

            ws.send(JSON.stringify({msgid:msgid,type:"ok"}))
        } break;
        case "typing": {
            const { status } = msg.data;
            if (typeof(status) !== 'number')
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "Must be number"}));
           
            const permissions = getChannelPermissions(ws.channel);
            if (!permissions.canSendMessages)
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "Can't send messages here"}));

            const index = typingUsers.findIndex(t=>t.publicid === publicid);

            if (status === 1) {
                let timeout = setTimeout(()=>{
                    typingUsers.splice(typingUsers.findIndex(t=>t.publicid === publicid),1)
                    sendTypingUsers();
                },10000)
                let typingObj = {
                    publicid: publicid,
                    channel: ws.channel,
                    timeout: timeout
                }
                if (index !== -1) {
                    clearTimeout(typingUsers[index].timeout)
                    typingUsers[index] = typingObj
                }
                else typingUsers.push(typingObj)
            } else if (status === 0 && index !== -1) {
                clearTimeout(typingUsers[index].timeout)
                typingUsers.splice(index, 1)
            }

            sendTypingUsers();
            ws.send(JSON.stringify({msgid:msgid, type: "ok"}));
        } break;
        default:
            break;
    }
}

let trynashutdown = false;
async function shutdown() {
    if (trynashutdown) return;
    trynashutdown = true

    console.log("Writing files")
    fs.writeFileSync(base_dir + 'accounts.json', JSON.stringify(users,null,4))
    fs.writeFileSync(base_dir + 'channels.json', JSON.stringify(channels,null,4))
    fs.writeFileSync(base_dir + 'messages.json', JSON.stringify(messages))
    fs.writeFileSync(base_dir + 'roles.json', JSON.stringify(roles,null,4))

    console.log("All done")
    process.exit(0)
}

process.once('SIGINT',shutdown)
let boi = ['SIGTERM','unhandledRejection','uncaughtException']
boi.forEach(thing=>{
    process.once(thing,()=>{
        setTimeout(()=>process.exit(1),10000);
        shutdown();
    })
})

app.listen(12345)

setInterval(sendUsersOnline,10000)