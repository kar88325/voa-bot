import fs from 'fs'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import Groq from 'groq-sdk'

const PHONE = process.env.PHONE_NUMBER
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

function initAuthFromEnv() {
  if(process.env.AUTH_JSON) {
    try {
      console.log("Restoring auth from AUTH_JSON env...")
      const data = JSON.parse(Buffer.from(process.env.AUTH_JSON, 'base64').toString())
      if(!fs.existsSync('auth')) fs.mkdirSync('auth',{recursive:true})
      for(let file in data) {
        fs.writeFileSync(`auth/${file}`, JSON.stringify(data[file], null, 2))
      }
      console.log("Auth restored")
    } catch(e){ console.log("AUTH_JSON restore failed:", e.message) }
  }
}
function getAuthForEnv() {
  try {
    if(!fs.existsSync('auth')) return null
    const files = fs.readdirSync('auth')
    if(files.length===0) return null
    const data = {}
    files.forEach(f => { data[f] = JSON.parse(fs.readFileSync(`auth/${f}`,'utf-8')) })
    const b64 = Buffer.from(JSON.stringify(data)).toString('base64')
    console.log("\n\n========== SAVE IN RAILWAY VARIABLE AUTH_JSON ==========\n"+b64+"\n====================================================\n\n")
    return b64
  } catch(e){ return null }
}
initAuthFromEnv()

let bylawsText = ""
try { bylawsText = fs.readFileSync('./bylawsVOAOA.txt','utf-8') } catch { bylawsText = fs.readFileSync('./bylaws.txt','utf-8') }
const clauses = bylawsText.split(/\n(?=\d+[\.\)]\s+[A-Z]|\n[A-Z ]+:)/).filter(c=>c.trim().length>100)
console.log("Loaded clauses:", clauses.length)

let cache = {}
try { cache = JSON.parse(fs.readFileSync('./cache.json','utf-8')) } catch { cache = {} }
if(!fs.existsSync('cache.json')) fs.writeFileSync('./cache.json','{}')

const SYNONYMS = { "gbm":"general body meeting", "agm":"annual general body meeting", "egm":"extra ordinary general body meeting", "mc":"managing committee executive committee", "small decisions":"managing committee powers routine minor", "agenda":"agenda notice order business" }
function expandQuery(q){ let lower=q.toLowerCase(); for(let k in SYNONYMS) if(lower.includes(k)) lower+=" "+SYNONYMS[k]; return lower+" agenda notice order business chairperson powers meeting procedure" }
function findTopClauses(q,topN=5){ const expanded=expandQuery(q); const words=expanded.toLowerCase().split(/\W+/).filter(w=>w.length>2); let scored=clauses.map(c=>{ const low=c.toLowerCase(); const head=c.split('\n').slice(0,3).join(' ').toLowerCase(); let score=0; words.forEach(w=>{ if(head.includes(w)) score+=10; if(low.includes(w)) score+=1 }); return {text:c.trim(),score} }); scored.sort((a,b)=>b.score-a.score); return scored.slice(0,topN).filter(s=>s.score>0).map(s=>s.text) }

function jaccard(a,b){ const wA=new Set(a.toLowerCase().split(/\W+/).filter(w=>w.length>2)); const wB=new Set(b.toLowerCase().split(/\W+/).filter(w=>w.length>2)); const inter=[...wA].filter(w=>wB.has(w)).length; const union=new Set([...wA,...wB]).size; return union===0?0:inter/union }
function cosine(a,b){ let dot=0,mA=0,mB=0; for(let i=0;i<a.length;i++){ dot+=a[i]*b[i]; mA+=a[i]*a[i]; mB+=b[i]*b[i] } return dot/(Math.sqrt(mA)*Math.sqrt(mB)+1e-8) }
async function getEmbedding(text){ try{ const r=await groq.embeddings.create({model:"nomic-embed-text",input:text.slice(0,2000)}); return r.data[0].embedding }catch{ return null } }
async function getFromCache(question){ const normQ=expandQuery(question); for(let k in cache) if(Date.now()-cache[k].ts>86400000) delete cache[k]; for(let key in cache) if(jaccard(normQ,cache[key].norm)>0.82){ console.log("CACHE HIT L1",key); return cache[key].answer } const embQ=await getEmbedding(normQ); if(embQ){ for(let key in cache) if(cache[key].embedding && cosine(embQ,cache[key].embedding)>0.85){ console.log("CACHE HIT L2",key); return cache[key].answer } } return null }
async function saveToCache(question,answer){ const norm=expandQuery(question); const embedding=await getEmbedding(norm); cache[question]={norm,embedding,answer,ts:Date.now()}; fs.writeFileSync('./cache.json',JSON.stringify(cache,null,2)) }

async function askGroq(question,relevantClauses){
  if(!relevantClauses.length) return "Not found in bye-laws."
  const prompt=`You are senior VOAOA legal advisor. QUESTION: "${question}" CLAUSES: ${relevantClauses.map((c,i)=>`CLAUSE ${i+1}: ${c.slice(0,2000)}`).join('\n\n')} Think: intent, agenda notice order chairperson powers consent prejudice. Answer 5 lines YES/NO + why. End Ref.`
  const models=["openai/gpt-oss-120b","groq/compound","qwen/qwen3-32b","meta-llama/llama-4-maverick-17b-128e-instruct","openai/gpt-oss-20b"]
  for(let model of models){ try{ console.log("Trying",model); const chat=await groq.chat.completions.create({messages:[{role:"user",content:prompt}],model,temperature:0.2,max_tokens:650}); return chat.choices[0]?.message?.content }catch(e){ console.log(model+" failed "+e.message); continue } }
  return null
}

async function start(){
  console.log("Auth exists?",fs.existsSync('auth'))
  const {state,saveCreds}=await useMultiFileAuthState('auth')
  const {version}=await fetchLatestBaileysVersion()
  const sock=makeWASocket({version,auth:state,logger:pino({level:'silent'}),browser:["Ubuntu","Chrome","110.0.5481.178"],syncFullHistory:false,markOnlineOnConnect:false})
  sock.ev.on('creds.update', async()=>{ await saveCreds(); getAuthForEnv() })
  sock.ev.on('connection.update', async(update)=>{
    const {connection,lastDisconnect}=update
    console.log("Conn:",connection)
    if(connection==='open'){ console.log("✅ Bot ONLINE"); getAuthForEnv() }
    if(connection==='close'){ const code=lastDisconnect?.error?.output?.statusCode; console.log("Close code",code); if(code!==DisconnectReason.loggedOut) setTimeout(start,5000) }
  })
  if(!state.creds.registered){
    console.log("Not registered, requesting code for",PHONE)
    await new Promise(r=>setTimeout(r,10000))
    try{ const c=await sock.requestPairingCode(PHONE.replace(/\D/g,'')); console.log("\n\n========== PAIRING CODE: "+c+" ==========\n\n") }catch(e){ console.log("Pairing fail:",e.message) }
  } else { console.log("Already registered") }
  sock.ev.on('messages.upsert', async({messages})=>{
    const m=messages[0]; if(!m.message||m.key.fromMe) return
    const text=m.message.conversation||m.message.extendedTextMessage?.text||""
    if(!text.toLowerCase().startsWith('/vobylaws')&&!text.toLowerCase().startsWith('/voa')) return
    const question=text.replace(/\/vobylaws|\/voa/i,'').trim()
    const from=m.key.remoteJid
    if(!question){ await sock.sendMessage(from,{text:"Usage: /vobylaws your question"}, {quoted:m}); return }
    console.log("Q:",question)
    await sock.sendPresenceUpdate('composing',from)
    const cached=await getFromCache(question)
    if(cached){ await sock.sendMessage(from,{text:`*VOAOA (from cache):*\n\n${cached}`},{quoted:m}); return }
    const top=findTopClauses(question,5)
    const ans=await askGroq(question,top)
    const reply=ans?`*VOAOA Answer:*\n\n${ans}`:"Not found"
    await saveToCache(question,ans||reply)
    await sock.sendMessage(from,{text:reply},{quoted:m})
  })
}
start()
