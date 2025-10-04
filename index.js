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

function processChatMessagesForPublicViewing(chatMsgs) {
    let msgs = [];
    if (!Array.isArray(chatMsgs)) chatMsgs = [chatMsgs]
    chatMsgs.forEach(chatMsg=>{
        const { username, loggedIn, publicid } = users.find(u=>u.privateid === chatMsg.by)
        msgs.push({
            ...chatMsg,
            by: undefined,
            username: username,
            isGuest: !loggedIn,
            publicid: publicid
        })
    })
    return msgs.length === 1 ? msgs[0] : msgs
}

function sendForAllConnectedUsers(data, channel) {
    const clients = channel ? Array.from(websocket.clients).filter(a=>a.channel === channel) : Array.from(websocket.clients);
    clients.forEach(ws=>ws.send(JSON.stringify(data)))
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
            registeredAt: (new Date()).toISOString(),
            creationIp: req.ip
        }
        users.push(userInUsers);
    }

    return websocket.handleUpgrade(req,req.socket,"",(ws)=>{
        ws.user = { ...user, publicid: userInUsers.publicid }
        websocket.emit('connection',ws)
    })
})

app.get('/register',(req,res)=>{
    const uuid = uuid.v4()
    validGuestUuids.add(uuid)
    res.cookie('guestAccountUuid',uuid,{
        httpOnly: true,
        sameSite: "strict",
        maxAge: new Date('9999-12-31')
    })
    res.status(200).json({"uuid": uuid})
})

websocket.on("connection",(ws)=>{
    ws.onmessage = (ev) => {
        try {
            let json = JSON.parse(ev.data)
            onMessage(json,ws)
        } catch (e) {
            console.error(e)
        }
    }
})

function onMessage(msg,ws) {
    const { msgid } = msg;
    const { username, isGuest, privateid, publicid } = ws.user;

    const userIsAdmin = ((user)=>{
        const fulluser = users.find(u => u.privateid === user.privateid)
        if (!fulluser) return false;
        let hasroles = [];
        fulluser.roles.forEach(id=>{
            hasroles.push(roles.find(role=>role.name === id))
        })
        return hasroles.some(role=>role.isAdmin)
    })(ws.user)

    switch (msg.type) {
        case "change_channel": {
            const { newChannel, getHistory } = msg.data

            const channel = channels.find(a=>a.name===newChannel)

            if (!userCanSeeChannel(channel, ws.user))
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "This channel does not exist"}));

            ws.channel = newChannel

            const permissions = getChannelPermissions(newChannel);
            ws.send(JSON.stringify({ msgid: msgid, type: "channel_permissions", data: permissions }))

            if (getHistory === false) return;

            let historyToSend = [];
            if (permissions.canSeeMessageHistory === true) 
                historyToSend = messages.filter(m => m.channel === newChannel).slice(-50);
            ws.send(JSON.stringify({ msgid: msgid, type: 'chat_history', data: processChatMessagesForPublicViewing(historyToSend) }));
        } break;
        case "send_message": {
            const { attachment, channel, xss, tvmGuestAccountKey, additionalDetails} = msg.data;
            let { message } = msg.data;

            const permissions = getChannelPermissions(channel);

            if (!permissions)
                return ws.send(JSON.stringify({msgid:msgid, type: "error", error: "This channel does not exist"}));

            const maxMessageLength = permissions.maxMessageLength;
            const canSendMessages = permissions.canSendMessages
            const canSendMessagesWithAttachments = permissions.canSendMessagesWithAttachments;

            if (!canSendMessages && !userIsAdmin)
                return ws.send(JSON.stringify({ msgid: msgid, type: "error", error: "You can't send messages in this channel"}));
            if (attachment && !canSendMessagesWithAttachments && !userIsAdmin)
                return ws.send(JSON.stringify({ msgid: msgid, type: "error", error: "You can't send messages with attachments in this channel"}));

            if (maxMessageLength && message.length > maxMessageLength && !userIsAdmin)
                message = message.substring(0,maxMessageLength);

            const sanitizedMessage = xss && userIsAdmin ? message : sanitize(message);

            if (!userIsAdmin) {
                // The rate limiting  would go here
            }

            const chatMsg = {
                id: uuid.v4(),
                by: privateid,
                message: sanitizedMessage,
                attachment: attachment,
                additionalDetails: additionalDetails,
                timestamp: (new Date()).toISOString(),
                channel: channel
            }

            messages.push(chatMsg)
            sendForAllConnectedUsers({type: "chat_message", data: processChatMessagesForPublicViewing(chatMsg)}, channel)

            // The inbox logic would go here

            sendForAllConnectedUsers({type: "unread_message", data: { channel: channel }}) // TODO: Adjust so it doesnt send every single time

            // The mention sending logic would go here

            ws.send(JSON.stringify({msgid:msgid,type:"ok"}))
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