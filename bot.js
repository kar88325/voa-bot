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
  if(!relevantClauses.length) return "Not found in bye-laws."

  const prompt = `
You are a senior apartment association legal advisor for VOAOA.

QUESTION: "${question}"

RELEVANT BYE-LAWS (may be incomplete, use your understanding of standard bye-laws):
${relevantClauses.map((c,i)=>`--- CLAUSE ${i+1} ---\n${c.slice(0,2000)}`).join('\n\n')}

INSTRUCTIONS - Think step by step:
1. What is the USER'S REAL INTENT? (e.g., "is change in agenda order legally valid?")
2. What does bye-laws say about: Agenda, Notice, Order of Business, Powers of Chairperson to conduct meeting, Consent of members present?
3. Deduce: Is mere change in order a violation if all notified topics were still discussed? When would it be NOT allowed (if it prejudices members, if something was skipped)?
4. Give final answer in simple English: YES/NO + why. Cite clauses.
5. Keep to 5-6 lines max. Must end with Ref: <clause headings>.

If bye-laws are silent on order, say: "Bye-laws do not explicitly forbid change in order, Chairperson may regulate business with consent of meeting, provided all notified agenda items are covered and no member is prejudiced."
`

  const models = [
    "openai/gpt-oss-120b",  // <- best reasoning for free
    "groq/compound",         // <- agentic thinking
    "qwen/qwen3-32b",        // <- good thinker, 60 RPM free
    "meta-llama/llama-4-maverick-17b-128e-instruct"
  ]

  for(let model of models) {
    try {
      console.log(`Trying reasoning model: ${model}`)
      const chat = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model,
        temperature: 0.2,
        max_tokens: 600, // allow thinking
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
