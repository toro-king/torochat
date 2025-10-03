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
    guestAccountUuids = require(base_dir + "messages.json")
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

function getChannelPermissions(chan) {
    return channels.find(cha=>cha.name === chan)?.permissions
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
        }
    } catch (e) {
        console.warn("Error while attempting to authenticate logged in user.", e)
    }

    const userInUsers = users.find(u=>u.privateid === user.privateid)
    if (userInUsers && userInUsers.loggedIn && user.username !== userInUsers.username) processNameChange(userInUsers.privateid, userInUsers.username, user.username) // The name has changed (TODO)
    if (!userInUsers)
        users.push({
            ...user,
            publicid: uuid.v4(),
            roles: [],
            registeredAt: (new Date()).toISOString(),
            creationIp: req.ip
        })


    return websocket.handleUpgrade(req,req.socket,"",(ws)=>{
        ws.user = user
        websocket.emit('connection',ws)
    })
})

app.get('/register',(req,res)=>{
    const uuid = uuid.v4()
    validGuestUuids.add(uuid)
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
    switch (msg.type) {
        case "change_channel": {
            const { newChannel } = msg.data

            if (channels[newChannel] && channels[newChannel].type === "private" && channels[newChannel].participants.includes(ws.user.username)) { // DM check bound to change
                ws.send(JSON.stringify({"success": false, "error": "This channel does not exist"}));
                return;
            }

            ws.channel = newChannel

            const permissions = getChannelPermissions(newChannel);
            ws.send(JSON.stringify({type: "channel_permissions",data:permissions}))

            if (msg.data.getHistory === false) return;

            let historyToSend = [];
            if (permissions.canSeeMessageHistory === true) {
                if (newChannel === 'tvm1' || newChannel === 'tvm2') {
                    historyToSend = messages.filter(m => m.channel === newChannel).slice(-10);
                    historyToSend.push({
                        id: uuid.v4(),
                        timestamp: (new Date()).toISOString(),
                        isGuest: false,
                        attachment: null,
                        channel: newChannel,
                        message: `<b><p>Welcome to ${newChannel.toUpperCase()}!</p></b><p>Visit the VM at https://vm.toroking.top to hear audio.</p><p>Send +upload and add an attachment to upload a file to the VM.</p><p>Join our Discord server! https://discord.gg/Q5UyA6puDE</p>`
                    });
                } else {
                    historyToSend = messages.filter(m => m.channel === newChannel).slice(-50);
                }
            }
            ws.send(JSON.stringify({ type: 'chat_history', data: historyToSend }));
        } break;
        case "send_message": {
            const { message: rawMessage, attachment, channel, xss, tvmGuestAccountKey } = msg.data;
            const { username, isGuest, guestAccountUuid } = ws.user;

            const permissions = getChannelPermissions(channel);
            const maxMessageLength = permissions.maxMessageLength;

            if (username)

        } break;
        default:
            break;
    }
}

function sendUsersOnline() {
    const clients = Array.from(websocket.clients);
    clients.forEach(ws=>{
        ws.send(JSON.stringify({

        }))
    })
    setTimeout(sendUsersOnline,5000)
}

app.listen(12345)

sendUsersOnline()