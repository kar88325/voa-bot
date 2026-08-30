import fs from 'fs'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'

const PHONE = process.env.PHONE_NUMBER || "91XXXXXXXXXX"

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
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ["Ubuntu","Chrome","110.0.5481.178"],
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  // FIX FOR 428 ERROR - Request pairing ONLY after WS connects
  let pairingDone = false
  sock.ev.on('connection.update', async (update)=>{
    const { connection, lastDisconnect } = update

    if(!state.creds.registered &&!pairingDone && connection!== 'close') {
      pairingDone = true
      console.log("Waiting 8 sec for WhatsApp connection...")
      await new Promise(r=>setTimeout(r, 8000)) // MUST WAIT
      try {
        const code = await sock.requestPairingCode(PHONE.replace(/\D/g,''))
        console.log(`\n\n========== PAIRING CODE: ${code} ==========\n`)
        console.log(`For ${PHONE} - Enter in WhatsApp > Linked Devices > Link with phone number\n\n`)
      } catch(e) {
        console.log("Pairing failed, will retry...", e.message)
        pairingDone = false // allow retry
      }
    }

    if(connection==='open') console.log("✅ VOAOA Bot ONLINE - Ready for /vobylaws")
    if(connection==='close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut
      if(shouldReconnect) {
        console.log("Reconnecting in 3s...")
        setTimeout(start, 3000)
      }
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
