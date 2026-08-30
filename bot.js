import fs from 'fs'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'

const PHONE = process.env.PHONE_NUMBER || "91XXXXXXXXXX" // Set this in Koyeb env

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
    browser: ["Chrome","Windows","10"],
    syncFullHistory: false,
  })

  if(!state.creds.registered) {
    setTimeout(async ()=>{
      const code = await sock.requestPairingCode(PHONE.replace(/\D/g,''))
      console.log(`\nPAIRING CODE FOR ${PHONE}: ${code}\n`)
      console.log("Go to WhatsApp > Linked Devices > Link with phone number > Enter code")
    }, 4000)
  }

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (u)=>{
    const { connection, lastDisconnect } = u
    if(connection==='open') console.log("✅ VOAOA Bot ONLINE")
    if(connection==='close' && lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) {
      console.log("Reconnecting...")
      start()
    }
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
    const reply = clause
    ? `*VOAOA Bye-laws:*\n\n"${clause.trim().slice(0,1000)}"\n\n*Ref:* ${clause.split('\n')[0].slice(0,120)}`
      : "Not found in bye-laws. Try keywords like: maintenance, common areas, quorum"
    await sock.sendMessage(from, {text: reply}, {quoted:m})
  })
}
start()
