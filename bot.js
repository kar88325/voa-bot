import fs from 'fs'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import Groq from 'groq-sdk'

const PHONE = process.env.PHONE_NUMBER
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// ===================== AUTH WITHOUT VOLUME (FREE PLAN FIX) =====================
function initAuthFromEnv() {
  if(process.env.AUTH_JSON) {
    try {
      console.log("Restoring auth from AUTH_JSON env...")
      const data = JSON.parse(Buffer.from(process.env.AUTH_JSON, 'base64').toString())
      if(!fs.existsSync('auth')) fs.mkdirSync('auth', {recursive:true})
      for(let file in data) {
        fs.writeFileSync(`auth/${file}`, JSON.stringify(data[file], null, 2))
      }
      console.log(`Auth restored, files: ${Object.keys(data).join(', ')}`)
    } catch(e){ console.log("AUTH_JSON restore failed:", e.message) }
  }
}

function getAuthForEnv() {
  try {
    if(!fs.existsSync('auth')) return null
    const files = fs.readdirSync('auth')
    if(files.length===0) return null
    const data = {}
    files.forEach(f => { data[f] = JSON.parse(fs.readFileSync(`auth/${f}`, 'utf-8')) })
    const b64 = Buffer.from(JSON.stringify(data)).toString('base64')
    console.log(`\n\n========== SAVE THIS IN RAILWAY VARIABLES ==========\nVariable Name: AUTH_JSON\nValue: ${b64}\n====================================================\n\n`)
    return b64
  } catch(e){ return null }
}
initAuthFromEnv()

// ===================== LOAD BYE-LAWS =====================
let bylawsText = ""
try { bylawsText = fs.readFileSync('./bylawsVOAOA.txt', 'utf-8') }
catch { bylawsText = fs.readFileSync('./bylaws.txt', 'utf-8') }
const clauses = bylawsText.split(/\n(?=\d+[\.\)]\s+[A-Z]|\n[A-Z ]+:$|\n\d+\.\d+)/).filter(c=>c.trim().length>100)
console.log(`Loaded ${clauses.length} clauses`)

// ===================== LOAD CACHE =====================
let cache = {}
try { cache = JSON.parse(fs.readFileSync('./cache.json','utf-8')); console.log(`Cache loaded: ${Object.keys(cache).length}`) } catch{}
if(!fs.existsSync('cache.json')) fs.writeFileSync('cache.json', '{}')

// ===================== SYNONYMS & RETRIEVAL =====================
const SYNONYMS = {
  "gbm": "general body meeting",
  "agm": "annual general body meeting",
  "egm": "extra ordinary general body meeting",
  "mc": "managing committee executive committee",
  "ec": "managing committee",
  "bod": "managing committee",
  "small decisions": "managing committee powers routine minor day to day",
  "agenda": "agenda notice order business",
