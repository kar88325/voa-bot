import fs from 'fs'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import Groq from 'groq-sdk'

const PHONE = process.env.PHONE_NUMBER
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const bylawsText = fs.readFileSync('./bylawsVOAOA.txt', 'utf-8')
// Better splitting - split by Clause No.
const clauses = bylawsText.split(/\n(?=\d+[\.\)]\s+[A-Z]|\n[A-Z ]+:$)/).filter(c=>c.trim().length>100)

const SYNONYMS = {
  "gbm": "general body meeting",
  "agm": "annual general body meeting",
  "egm": "extra ordinary general body meeting",
  "mc": "managing committee executive committee",
  "ec": "managing committee",
  "small decisions": "managing committee powers duties routine minor",
  "major": "general body approval",
}

function expandQuery(q) {
  let lower = q.toLowerCase()
  for(let k in SYNONYMS) if(lower.includes(k)) lower += " " + SYNONYMS[k]
  return lower
}

function findTopClauses(q, topN=3) {
  const expanded = expandQuery(q)
  const queryWords = expanded.toLowerCase().split(/\W+/).filter(w=>w.length>2)

  let scored = clauses.map(c => {
    const lower = c.toLowerCase()
    const heading = c.split('\n').slice(0,2).join(' ').toLowerCase()
    let score = 0
    queryWords.forEach(w => {
      if(heading.includes(w)) score += 10
      if(lower.includes(w)) score += 1
    })
    return { text: c.trim(), score }
  })
  scored.sort((a,b)=>b.score-a.score)
  return scored.slice(0, topN).filter(s=>s.score>0).map(s=>s.text)
}

async function askGroq(question, relevantClauses) {
  if(!relevantClauses.length) return null
  const prompt = `You are VOAOA Bye-laws assistant for Vaishnavi Oasis Apartment.
Question: "${question}"
Relevant Clauses:
${relevantClauses.map((c,i)=>`Clause ${i+1}: ${c.slice(0,1500)}`).join('\n\n---\n\n')}
Answer in simple English based ONLY on clauses. Max 4 lines. End with Ref: heading. If not found, say "Not found in bye-laws".`

  const models = [
    "llama-3.1-8b-instant",
    "openai/gpt-oss-20b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b-versatile"
  ]

  for(let model of models) {
    try {
      console.log(`Trying Groq model: ${model}`)
      const chat = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model,
        temperature: 0.1,
        max_tokens: 300,
      })
      return chat.choices[0]?.message?.content
    } catch(e) {
      console.log(`Model ${model} failed: ${e.message}`)
      continue
    }
  }
  return null
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

  let pairingDone = false
  sock.ev.on('connection.update', async (update)=>{
    const { connection, lastDisconnect } = update
    if(!state.creds.registered &&!pairingDone && connection!== 'close') {
      pairingDone = true
      await new Promise(r=>setTimeout(r, 8000))
      try {
        const code = await sock.requestPairingCode(PHONE.replace(/\D/g,''))
        console.log(`\n\n========== PAIRING CODE: ${code} ==========\n`)
      } catch(e) { pairingDone = false }
    }
    if(connection==='open') console.log("✅ VOAOA Bot ONLINE with Groq")
    if(connection==='close' && lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) {
      setTimeout(start, 3000)
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
      await sock.sendMessage(from, {text:"Usage: /vobylaws is GBM required for small decisions?"}, {quoted:m})
      return
    }

    console.log(`Q: ${question}`)
    await sock.sendPresenceUpdate('composing', from)

    const topClauses = findTopClauses(question, 3)
    const answer = await askGroq(question, topClauses)

    let reply
    if(answer) {
      reply = `*VOAOA Bye-laws Answer:*\n\n${answer}\n\n_Type /vobylaws <your question>_`
    } else {
      reply = topClauses[0]
       ? `*Relevant Clause:*\n\n${topClauses[0].slice(0,1200)}`
        : "Not found in bye-laws. Try: /vobylaws managing committee powers"
    }

    await sock.sendMessage(from, {text: reply}, {quoted:m})
  })
}
start()
