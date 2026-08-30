const fs = require('fs')
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys')

const bylawsText = fs.readFileSync('./bylawsVOAOA.txt', 'utf-8')
const clauses = bylawsText.split(/\n(?=\d+\.\s+[A-Z ]+:)/)

function findBestClause(q) {
  const words = q.toLowerCase().split(' ').filter(w=>w.length>3)
  let best = {score:0, text:null}
  clauses.forEach(c=>{
    let s=0; words.forEach(w=>{if(c.toLowerCase().includes(w)) s++})
    if(s>best.score) best={score:s, text:c}
  })
  return best.text
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ["VOA-Bot","Chrome","1.0"]
  })

  // THIS IS FOR RAILWAY - Pairing code instead of QR
  if(!sock.authState.creds.registered) {
    const phone = "919986702515"
    setTimeout(async ()=>{
      let code = await sock.requestPairingCode(phone)
      console.log("PAIRING CODE: ", code) // You will see this in Railway logs
    }, 3000)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({connection})=>{
    if(connection==='open') console.log("✅ VOAOA Bot ONLINE")
  })

  sock.ev.on('messages.upsert', async ({messages})=>{
    const m=messages[0]
    if(!m.message || m.key.fromMe) return
    const text = m.message.conversation || m.message.extendedTextMessage?.text || ""
    if(!text.toLowerCase().startsWith('/vobylaws') &&!text.toLowerCase().startsWith('/voa')) return

    const question = text.replace(/\/vobylaws|\/voa/i,'').trim()
    const from = m.key.remoteJid
    if(!question) {
      await sock.sendMessage(from, {text:"Usage: /vobylaws what is quorum?"}, {quoted:m})
      return
    }
    const clause = findBestClause(question)
    const heading = clause? clause.split('\n')[0].slice(0,120) : ""
    const reply = clause
     ? `*VOAOA Bye-laws:*\n\n"${clause.trim().slice(0,1000)}"\n\n*Ref:* ${heading}`
      : "Not found in bye-laws. Try /vobylaws maintenance"

    await sock.sendMessage(from, {text: reply}, {quoted:m})
  })
}
start()