import fs from 'fs'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import Groq from 'groq-sdk'

const PHONE = process.env.PHONE_NUMBER
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// --- Load Bye-laws ---
const bylawsText = fs.readFileSync('./bylawsVOAOA.txt', 'utf-8')
const clauses = bylawsText.split(/\n(?=\d+[\.\)]\s+[A-Z]|\n[A-Z ]+:$)/).filter(c=>c.trim().length>100)

// --- Load Cache ---
let cache = {}
try { cache = JSON.parse(fs.readFileSync('./cache.json','utf-8')); console.log(`Cache loaded: ${Object.keys(cache).length} entries`) } catch{}

// --- Synonyms ---
const SYNONYMS = {
  "gbm": "general body meeting",
  "agm": "annual general body meeting",
  "egm": "extra ordinary general body meeting",
  "mc": "managing committee executive committee",
  "ec": "managing committee",
  "small decisions": "managing committee powers routine minor day to day",
  "agenda": "agenda notice order business",
}

function expandQuery(q) {
  let lower = q.toLowerCase()
  for(let k in SYNONYMS) if(lower.includes(k)) lower += " " + SYNONYMS[k]
  return lower + " agenda notice order business chairperson powers meeting procedure"
}

// --- Retrieval ---
function findTopClauses(q, topN=5) {
  const expanded = expandQuery(q)
  const queryWords = expanded.toLowerCase().split(/\W+/).filter(w=>w.length>2)
  let scored = clauses.map(c => {
    const lower = c.toLowerCase()
    const heading = c.split('\n').slice(0,2).join(' ').toLowerCase()
    let score = 0
    queryWords.forEach(w => { if(heading.includes(w)) score+=10; if(lower.includes(w)) score+=1 })
    return { text: c.trim(), score }
  })
  scored.sort((a,b)=>b.score-a.score)
  return scored.slice(0, topN).filter(s=>s.score>0).map(s=>s.text)
}

// --- Semantic Cache Level 1: Jaccard ---
function jaccard(a,b) {
  const wA = new Set(a.toLowerCase().split(/\W+/).filter(w=>w.length>2))
  const wB = new Set(b.toLowerCase().split(/\W+/).filter(w=>w.length>2))
  const inter = [...wA].filter(w=>wB.has(w)).length
  const union = new Set([...wA,...wB]).size
  return union===0?0:inter/union
}

function cosine(a,b) {
  let dot=0, magA=0, magB=0
  for(let i=0;i<a.length;i++){ dot+=a[i]*b[i]; magA+=a[i]*a[i]; magB+=b[i]*b[i] }
  return dot / (Math.sqrt(magA)*Math.sqrt(magB) + 1e-8)
}

async function getEmbedding(text) {
  try {
    const res = await groq.embeddings.create({
      model: "nomic-embed-text",
      input: text
    })
    return res.data[0].embedding
  } catch(e) {
    console.log("Embedding failed, using Jaccard only:", e.message)
    return null
  }
}

async function getFromCache(question) {
  const normQ = expandQuery(question)
  // 24h expiry
  for(let k in cache) if(Date.now()-cache[k].ts > 86400000) delete cache[k]

  // Level 1: Fast Jaccard
  for(let key in cache) {
    if(jaccard(normQ, cache[key].norm) > 0.82) {
      console.log(`CACHE HIT L1 Jaccard: "${key}" ~ "${question}"`)
      return cache[key].answer
    }
  }
  // Level 2: Embedding intent
  const embQ = await getEmbedding(normQ)
  if(embQ) {
    for(let key in cache) {
      if(cache[key].embedding && cosine(embQ, cache[key].embedding) > 0.85) {
        console.log(`CACHE HIT L2 Embedding: "${key}" ~ "${question}"`)
        return cache[key].answer
      }
    }
  }
  return null
}

async function saveToCache(question, answer) {
  const norm = expandQuery(question)
  const embedding = await getEmbedding(norm)
  cache[question] = { norm, embedding, answer, ts: Date.now() }
  fs.writeFileSync('./cache.json', JSON.stringify(cache, null, 2))
  console.log("Cached:", question)
}

// --- Reasoning Groq ---
async function askGroq(question, relevantClauses) {
  if(!relevantClauses.length) return "Not found in bye-laws. Try rephrasing with keywords like managing committee, general body, notice."

  const prompt = `
You are senior VOAOA legal advisor for Vaishnavi Oasis Apartment (JP Nagar 9th Phase).

QUESTION: "${question}"

RELEVANT BYE-LAWS:
${relevantClauses.map((c,i)=>`--- CLAUSE ${i+1} ---\n${c.slice(0,2000)}`).join('\n\n')}

Think step by step:
1. What is REAL INTENT? (e.g., validity of changing agenda order)
2. What do clauses say about agenda, notice, order of business, chairperson power to regulate meeting, consent of members?
3. Standard apartment law: if agenda notified, mere change in order is allowed if all items covered, no prejudice, with consent. Not allowed if item skipped or prejudice caused.
4. Answer: YES/NO + reasoning in 5 lines simple English. End with Ref: <headings>.

If silent, say: "Bye-laws do not explicitly forbid change in order, Chairperson may regulate business with consent, provided all notified items covered."
`

  const models = [
    "openai/gpt-oss-120b",
    "groq/compound",
    "qwen/qwen3-32b",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "openai/gpt-oss-20b"
  ]

  for(let model of models) {
    try {
      console.log(`Trying reasoning model: ${model}`)
      const chat = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model,
        temperature: 0.2,
        max_tokens: 600,
      })
      return chat.choices[0]?.message?.content
    } catch(e) {
      console.log(`Model ${model} failed: ${e.message}`); continue
    }
  }
  return null
}

// --- WhatsApp Start ---
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
    if(connection==='open') console.log("✅ VOAOA Bot ONLINE with Reasoning + Semantic Cache")
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

    // Check cache first
    const cached = await getFromCache(question)
    if(cached) {
      await sock.sendMessage(from, {text: `*VOAOA Bye-laws (from cache):*\n\n${cached}\n\n_Type /vobylaws <question>_`}, {quoted:m})
      return
    }

    const topClauses = findTopClauses(question, 5)
    const answer = await askGroq(question, topClauses)
    const reply = answer? `*VOAOA Bye-laws Answer:*\n\n${answer}\n\n_Type /vobylaws <question>_` : "Not found."

    await saveToCache(question, answer || reply)
    await sock.sendMessage(from, {text: reply}, {quoted:m})
  })
}
start()
