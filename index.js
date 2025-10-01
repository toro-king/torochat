const express = require('express');
const app = express();

const uuid = require('uuid');
const fs = require('fs');

const WebSocket = require('ws');

const websocket = new WebSocket.Server({noServer: true})

const base_dir = '/home/ubuntu/webserver/torochat/newserver/'
const old_dir = '/home/ubuntu/webserver/torochat/server/'

const public_channels = ['#general', '#taiko', '#feedback', '#announcements', '#all-scores', 'tvm1','tvm2','penischannel123'];

let guestAccounts = {};
try {
    guestAccountUuids = require(old_dir + "guestAccounts.json")
} catch {
    console.warn("Error loading the guest accounts, starting fresh")
}

app.get('/', (req,res)=>{
    // Handle authentication.
    // You may have to change this depending on your authentication setup

    // User has jack shit... period
    if (!req.headers.cookie)
        return res.status(401).json({"success": false, "error": "I want to eat some of your cookies but you didn't provide any"})
    let cookies = Object.fromEntries(req.headers.cookie?.split('; ').map(cook=>cook.split("=",2)))

    // User has jack shit for authentication
    if (!cookies['connect.sid'] && !cookies['guestAccountUuid'])
        return res.status(401).json({"success": false, "error": "No connect.sid or guestAccountUuid cookie specified"})
    // User has guest cookie
    if (!cookies['connect.sid']) {
        const guestAccount = guestAccounts[cookies['guestAccountUuid']]
        if (!guestAccount)
            return res.status(403).json({"success": false, "error": "This guest account uuid doesn't exist. Please clear your cookies"})
        return websocket.handleUpgrade(req,req.socket,"",(ws)=>{
            ws.user = { "loggedIn": false, "username": guestAccount.username}
            websocket.emit('connection',ws)
        })
    }

    // User has a connect.sid cookie
    fetch('http://127.0.0.1:8069/auth/test',{
        "headers": { "Cookie": req.headers.cookie }
    }).then(a=>a.json()).then(resp=>{
        if (resp.loggedIn) {
            websocket.handleUpgrade(req,req.socket,"",(ws)=>{
                ws.user = resp
                websocket.emit('connection',ws)
            })
        } else
            return res.status(401).json({"success":false,"error":"Invalid connect.sid"})
    })
})

app.get('/register',(req,res)=>{
    const uuid = uuid.v4()
    const newuser = {"registeredAt": (new Date()).toISOString(), "fromIP": req.ip};
    guestAccounts[uuid] = newuser;
    res.status(200).json({...newuser, "uuid": uuid})
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
    if (msg.type === "change_channel") {
        const isAllowedPublic = public_channels.includes(msg.newChannel);
        const isAllowedDM = true;

        if (!isAllowedPublic && !isAllowedDM) {
            ws.send(JSON.stringify({"success": false, "error": "This channel does not exist"}));
            return;
        }

        ws.channel = msg.newChannel


    }
}

function boi(){
    console.log(connections.length)
    setTimeout(boi,3000)
}
boi()

app.listen(12345)