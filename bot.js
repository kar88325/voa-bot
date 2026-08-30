import fs from 'fs'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'

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
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["Chrome","Windows","10"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30000
  })

  if(!state.creds.registered) {
    const phone = "91XXXXXXXXXX" // YOUR BOT NUMBER
    setTimeout(async ()=>{
      try {
        let code = await sock.requestPairingCode(phone.replace(/\D/g,''))
        console.log(`\n\n >>> PAIRING CODE FOR ${phone}: ${code} <<<\n\n`)
      } catch(e){ console.log("Pairing error", e) }
    }, 5000)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update)=>{
    const { connection, lastDisconnect } = update
    if(connection === 'open') console.log("✅ VOAOA Bot ONLINE")
    if(connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut
      console.log("Connection closed, reconnecting:", shouldReconnect)
      if(shouldReconnect) start()
    }
  })

  sock.ev.on('messages.upsert', async ({messages})=>{
    const m=messages[0]
    if(!m.message || m.key.fromMe) return
    const text = m.message.conversation || m.message.extendedTextMessage?.text || ""
    if(!text.toLowerCase().startsWith('/vobylaws') &&!text.toLowerCase().startsWith('/voa')) return

    const question = text.replace(/\/vobylaws|\/voa/i,'').trim()
    const from = m.key.remoteJid
    const clause = findBestClause(question)
    const reply = clause
     ? `*VOAOA Bye-laws:*\n\n"${clause.trim().slice(0,1000)}"\n\n*Ref:* ${clause.split('\n')[0].slice(0,120)}`
      : "Not found in bye-laws."
    await sock.sendMessage(from, {text: reply}, {quoted:m})
  })
}
start()
