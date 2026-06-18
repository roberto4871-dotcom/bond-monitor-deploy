const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
// yahoo-finance2 v3: .default è la classe, va istanziata con new
const yahooFinance = new (require('yahoo-finance2').default)();

const app = express();
const PORT = process.env.PORT || 3001;

// Timestamp univoco per questa istanza del server — usato per forzare il reload del browser
const SERVER_BUILD = Date.now();

// Monitor attivi — governativi, sovranazionali, corporate multi-valuta
const MONITORS = [
  // ── Governativi italiani ──────────────────────────────────────
  { id: 5,  name: 'BTP - Italia' },
  { id: 74, name: 'BTP Futura / Valore / Più' },
  { id: 72, name: 'BOT' },
  { id: 76, name: 'BTP in USD' },              // BTP denominati in dollari

  // ── Governativi europei ───────────────────────────────────────
  { id: 66, name: 'Titoli di stato europei' },
  { id: 43, name: 'Altri titoli di stato' },
  { id: 23, name: 'Governativi extra-UE' },     // USD, GBP, NOK, SEK, Turkey in USD
  { id: 10, name: 'Germania' },
  { id: 13, name: 'Francia' },
  { id: 78, name: 'Romania' },
  { id: 58, name: 'Stati Uniti' },

  // ── Sovranazionali / supranational ───────────────────────────
  { id: 62, name: 'Sovranazionali' },
  { id: 63, name: 'Unione Europea' },
  { id: 16, name: 'BEI / EIB' },               // USD, GBP, TRY, NOK, SEK, ZAR, MXN

];

const REFRESH_INTERVAL = 20 * 60 * 1000; // 20 minuti

// Mappa prefisso ISIN → paese (solo prefissi non ambigui)
// XS NON è incluso: Euroclear registra bond di qualsiasi emittente, non implica "sovranazionale"
const COUNTRY_MAP = {
  'IT': 'Italia',
  'DE': 'Germania',
  'FR': 'Francia',
  'ES': 'Spagna',
  'PT': 'Portogallo',
  'GR': 'Grecia',
  'BE': 'Belgio',
  'NL': 'Paesi Bassi',
  'AT': 'Austria',
  'FI': 'Finlandia',
  'IE': 'Irlanda',
  'RO': 'Romania',
  'PL': 'Polonia',
  'HU': 'Ungheria',
  'CZ': 'Rep. Ceca',
  'SK': 'Slovacchia',
  'SI': 'Slovenia',
  'HR': 'Croazia',
  'BG': 'Bulgaria',
  'LT': 'Lituania',
  'LV': 'Lettonia',
  'EE': 'Estonia',
  'SE': 'Svezia',
  'DK': 'Danimarca',
  'NO': 'Norvegia',
  'CH': 'Svizzera',
  'GB': 'Regno Unito',
  'US': 'Stati Uniti',
  'JP': 'Giappone',
  'CA': 'Canada',
  'AU': 'Australia',
  'EU': 'Unione Europea',  // prefisso usato da EFSF/ESM/EU Commission
};

// Parole chiave emittente → sovranazionale
const SUPRA_KEYWORDS = [
  'BEI ', 'EIB ', 'EUROPEAN INVESTMENT BANK',
  'WORLD BANK', 'IBRD ', 'IFC ',
  'EBRD', 'EUROPEAN BANK FOR RECONSTRUCTION',
  'EFSF', 'ESM ', 'EUROPEAN STABILITY',
  'EUROPEAN UNION', 'UNIONE EUROPEA',
  'ASIAN DEVELOPMENT', 'AFRICAN DEVELOPMENT',
  'INTER-AMERICAN', 'IADB ',
  'COUNCIL OF EUROPE', 'KFW ',
  'NORDIC INVESTMENT', 'NIB ',
];

// Parole chiave in descrizione → paese
// Necessarie perché bond di stati non-UE vengono spesso emessi con ISIN XS o US
const DESC_PAESE_MAP = [
  // Europa extra-UE
  [/\bTURCHIA\b|\bTURKEY\b/,          'Turchia'],
  [/\bNORVEGIA\b|\bNORWAY\b/,         'Norvegia'],
  [/\bSVEZIA\b|\bSWEDEN\b/,           'Svezia'],
  [/\bSVIZZERA\b|\bSWITZERLAND\b/,    'Svizzera'],
  [/\bREGNO UNITO\b|\bUNITED KINGDOM\b|\bUK GOV/,'Regno Unito'],
  [/\bSERBIA\b/,                       'Serbia'],
  [/\bUCRAINA\b|\bUKRAINE\b/,         'Ucraina'],
  // Europa UE (bond con prefisso XS/US)
  [/\bROMANIA\b/,                      'Romania'],
  [/\bUNGHERIA\b|\bHUNGARY\b/,        'Ungheria'],
  [/\bPOLONIA\b|\bPOLAND\b/,          'Polonia'],
  [/\bBULGARIA\b/,                     'Bulgaria'],
  [/\bCROAZIA\b|\bCROATIA\b/,         'Croazia'],
  [/\bSLOVENIA\b/,                     'Slovenia'],
  [/\bGRECIA\b|\bGREECE\b/,           'Grecia'],
  [/\bPORTOGALLO\b|\bPORTUGAL\b/,    'Portogallo'],
  [/\bSPAGNA\b|\bSPAIN\b/,            'Spagna'],
  [/\bBELGIO\b|\bBELGIUM\b/,         'Belgio'],
  [/\bAUSTRIA\b/,                      'Austria'],
  [/\bFINLANDIA\b|\bFINLAND\b/,       'Finlandia'],
  [/\bIRLANDA\b|\bIRELAND\b/,         'Irlanda'],
  [/\bPAESI BASSI\b|\bNETHERLANDS\b/, 'Paesi Bassi'],
  [/\bLITUANIA\b|\bLITHUANIA\b/,      'Lituania'],
  [/\bLETTONIA\b|\bLATVIA\b/,         'Lettonia'],
  [/\bESTONIA\b/,                      'Estonia'],
  [/\bSLOVACCHIA\b|\bSLOVAKIA\b/,     'Slovacchia'],
  [/\bCIPRO\b|\bCYPRUS\b/,            'Cipro'],
  // Extra-europei
  [/\bUSA\b|\bU\.S\.A\.\b/,           'Stati Uniti'],
  [/\bGIAPPONE\b|\bJAPAN\b/,          'Giappone'],
  [/\bCINA\b|\bCHINA\b/,              'Cina'],
  [/\bCANADA\b/,                       'Canada'],
  [/\bAUSTRALIA\b/,                    'Australia'],
  [/\bBRASILE\b|\bBRAZIL\b/,         'Brasile'],
  [/\bMESSICO\b|\bMEXICO\b/,         'Messico'],
  [/\bCOLOMBIA\b/,                     'Colombia'],
  [/\bCILE\b|\bCHILE\b/,              'Cile'],
  [/\bPERU\b|\bPERÙ\b/,              'Perù'],
  [/\bARGENTINA\b/,                    'Argentina'],
  [/\bSUDAFRICA\b|\bSOUTH AFRICA\b/,  'Sudafrica'],
  [/\bEGITTO\b|\bEGYPT\b/,           'Egitto'],
  [/\bBAHRAIN\b/,                      'Bahrain'],
  [/\bINDONESIA\b/,                    'Indonesia'],
  [/\bINDIA\b/,                        'India'],
  [/\bFILIPPINE\b|\bPHILIPPINES\b/,  'Filippine'],
  [/\bMAROCCO\b|\bMOROCCO\b/,        'Marocco'],
  [/\bKENYA\b/,                        'Kenya'],
  [/\bGHANA\b/,                        'Ghana'],
  [/\bNIGERIA\b/,                      'Nigeria'],
  [/\bIVORY COAST\b|\bCOTE D.IVOIRE\b/,'Costa d\'Avorio'],
];

// Mappa keyword emittente → paese — copre i corporate bond con ISIN XS
// (i bond corporate/bancari EUR hanno spesso ISIN Euroclear che non porta info-paese)
const EMITTENTE_PAESE_KW = [
  // ── Italia ──────────────────────────────────────────────────────
  [/INTESA\b|ISP\b/i,                         'Italia'],
  [/UNICREDIT/i,                               'Italia'],
  [/MEDIOBANCA/i,                              'Italia'],
  [/MONTE.*PASCHI|BANCA MPS|\bMPS\b/i,        'Italia'],
  [/\bENEL\b/i,                               'Italia'],
  [/\bENI\b/i,                                'Italia'],
  [/AUTOSTRADE/i,                              'Italia'],
  [/FERROVIE|FERR\.? STATO/i,                 'Italia'],
  [/ITALGAS/i,                                 'Italia'],
  [/\bSNAM\b/i,                               'Italia'],
  [/\bTERNA\b/i,                              'Italia'],
  [/TELECOM ITALIA|\bTIM\b/i,                  'Italia'],
  [/\bACEA\b/i,                               'Italia'],
  [/\bNEXI\b/i,                               'Italia'],
  [/ALPERIA/i,                                 'Italia'],
  [/ALERION/i,                                 'Italia'],
  [/MEDIOCREDITO|BANCA IFIS|CREDITO EMILIANO|CREVAL/i, 'Italia'],
  // ── Germania ────────────────────────────────────────────────────
  [/DEUTSCHE BANK/i,                           'Germania'],
  [/COMMERZBANK/i,                             'Germania'],
  [/DEUTSCHE TELEKOM/i,                        'Germania'],
  [/\bE\.ON\b|\bEON\b/i,                      'Germania'],
  [/VOLKSWAGEN|\bVW\b|BMW\b|MERCEDES|DAIMLER/i,'Germania'],
  [/BASF\b|BAYER\b|SIEMENS/i,                 'Germania'],
  // ── Francia ─────────────────────────────────────────────────────
  [/CREDIT AGRICOLE|CALYON|CA CIB/i,           'Francia'],
  [/SOCIETE GENERALE|SOC\.? GEN/i,             'Francia'],
  [/\bORANGE\b/i,                             'Francia'],
  [/\bBNP\b/i,                                'Francia'],
  [/AXA\b|ENGIE\b|TOTAL\b/i,                  'Francia'],
  // ── Spagna ──────────────────────────────────────────────────────
  [/TELEFONICA/i,                              'Spagna'],
  [/SANTANDER/i,                               'Spagna'],
  [/BBVA\b|IBERDROLA|ENDESA/i,                'Spagna'],
  // ── Regno Unito ─────────────────────────────────────────────────
  [/BARCLAYS/i,                                'Regno Unito'],
  [/\bSHELL\b/i,                              'Regno Unito'],
  [/VODAFONE/i,                                'Regno Unito'],
  [/\bHSBC\b/i,                               'Regno Unito'],
  [/LLOYDS|NATWEST|STANDARD CHARTERED/i,       'Regno Unito'],
  // ── Paesi Bassi ─────────────────────────────────────────────────
  [/\bING\b/i,                                'Paesi Bassi'],
  [/RABOBANK/i,                                'Paesi Bassi'],
  // ── USA ─────────────────────────────────────────────────────────
  [/CITIGROUP|\bCITI\b/i,                     'Stati Uniti'],
  [/GOLDMAN SACHS/i,                           'Stati Uniti'],
  [/JPMORGAN|J\.P\. MORGAN/i,                 'Stati Uniti'],
  [/BANK OF AMERICA|\bBOFA\b/i,               'Stati Uniti'],
  [/MORGAN STANLEY/i,                          'Stati Uniti'],
  [/WELLS FARGO/i,                             'Stati Uniti'],
  // ── Svizzera ────────────────────────────────────────────────────
  [/CREDIT SUISSE|\bUBS\b/i,                  'Svizzera'],
];

// Rileva paese dalla descrizione (fallback per ISIN XS/US con emittente non USA)
function getCountryFromDesc(desc) {
  for (const [re, paese] of DESC_PAESE_MAP) {
    if (re.test(desc)) return paese;
  }
  return null;
}

// Rileva paese dall'emittente (per bond corporate con ISIN XS)
function getCountryFromEmittente(emittente) {
  const e = (emittente || '').toUpperCase();
  for (const [re, paese] of EMITTENTE_PAESE_KW) {
    if (re.test(e)) return paese;
  }
  return null;
}

// Assegna paese considerando: monitor → prefisso ISIN → keywords emittente → descrizione
function getPaese(isin, monitorName, descrizione, emittente) {
  const prefix = (isin || '').substring(0, 2).toUpperCase();
  const desc = (descrizione || '').toUpperCase();

  // Monitor 62/63 → override esplicito
  if (monitorName === 'Sovranazionali') {
    if (prefix === 'EU') return 'Unione Europea';
    return 'Sovranazionale';
  }
  if (monitorName === 'Unione Europea') return 'Unione Europea';

  // Prefisso EU (EFSF, ESM, EU Commission) → sempre Unione Europea
  if (prefix === 'EU') return 'Unione Europea';

  // Prefissi univoci per paese → usa COUNTRY_MAP
  if (COUNTRY_MAP[prefix]) {
    // Eccezione: bond con prefisso US ma emittente non USA (es. Turkey con ISIN USA)
    if (prefix === 'US') {
      const fromDesc = getCountryFromDesc(desc);
      if (fromDesc && fromDesc !== 'Stati Uniti') return fromDesc;
    }
    return COUNTRY_MAP[prefix];
  }

  // Prefissi Euroclear/Clearstream (XS, XF, XC, XB): ambigui, guarda il contenuto
  if (['XS','XF','XC','XB'].includes(prefix)) {
    if (SUPRA_KEYWORDS.some(kw => desc.includes(kw))) return 'Sovranazionale';
    const fromDesc = getCountryFromDesc(desc);
    if (fromDesc) return fromDesc;
    // Fallback: cerca nell'emittente estratto
    const fromEmit = getCountryFromEmittente(emittente);
    if (fromEmit) return fromEmit;
    // Ultimo tentativo: cerca le keyword emittente anche nella descrizione completa
    const fromDescEmit = getCountryFromEmittente(descrizione);
    if (fromDescEmit) return fromDescEmit;
    return 'Altro';
  }

  return 'Altro';
}

let state = {
  bonds: [],
  lastUpdate: null,
  isUpdating: false,
  errors: [],
  nextUpdate: null,
};

// Estrae l'emittente dalla descrizione del titolo
function extractIssuer(description) {
  if (!description) return '';
  // Pattern: testo prima di una data (dd/mm/yyyy)
  const match = description.match(/^(.+?)\s+\d{2}[\/\-]\d{2}[\/\-]\d{4}/);
  if (match) return match[1].trim();
  // Fallback: prima parola(e) che non iniziano con un numero
  const parts = description.split(' ');
  const issuer = [];
  for (const p of parts) {
    if (/^\d/.test(p)) break;
    issuer.push(p);
  }
  return issuer.join(' ').trim() || description.split(' ')[0];
}

function parseNumber(str) {
  if (!str || str === 'n.d.' || str === 'N/A' || str === '-') return null;
  const cleaned = str.replace(',', '.').replace(/[^\d.\-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseDate(str) {
  if (!str) return null;
  // dd/mm/yyyy
  const m1 = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
  return str;
}

// Parsing robusto basato sugli header della tabella
function parseTable($, monitorName) {
  const bonds = [];

  $('table').each((_, table) => {
    let colMap = null;

    $(table).find('tr').each((_, row) => {
      // Cerca la riga di intestazione
      if (!colMap) {
        const ths = $(row).find('th');
        if (ths.length >= 5) {
          colMap = {};
          ths.each((idx, th) => {
            const t = $(th).text().trim().toLowerCase();
            if (t.includes('isin') || t.includes('codice')) colMap.isin = idx;
            else if (t.includes('descri')) colMap.descrizione = idx;
            else if (t === 'divisa' || t.includes('valuta') || t === 'currency') colMap.divisa = idx;
            else if (t.includes('scadenza') || t.includes('maturity')) colMap.scadenza = idx;
            else if (t.includes('lotto') || t.includes('minimum')) colMap.lotto = idx;
            else if (t === 'status') colMap.status = idx;
            else if (t === 'mercato' || t === 'market') colMap.mercato = idx;
            else if (t.includes('prezzo') || t.includes('price') || t.includes('riferimento')) colMap.prezzo = idx;
            else if (t.includes('volume') && !t.includes('rating') && t !== 'vr') colMap.volume = idx;
            else if (t === 'vr') colMap.vr = idx;
            else if (t.includes('tipo') || t.includes('calcolo')) colMap.tipoCalcolo = idx;
            else if (t === 'yield' || t.includes('rendimento') || t.includes('tasso') || t === 'rend.' || t === 'ytm') colMap.yield = idx;
            else if (t.includes('duration')) colMap.duration = idx;
            else if (t.includes('spread')) colMap.zSpread = idx;
          });
          return; // continua al prossimo row
        }
        return; // skip se non è header
      }

      // Righe dati
      const tds = $(row).find('td');
      if (tds.length < 8) return;

      const isinIdx = colMap.isin ?? 0;
      const isin = $(tds[isinIdx]).text().trim();

      // Validazione ISIN: 2 lettere + 10 alfanumerici
      if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) return;

      const get = (key) => {
        const idx = colMap[key];
        if (idx === undefined || idx === null) return '';
        const cell = tds[idx];
        return cell ? $(cell).text().trim() : '';
      };

      const descrizione = get('descrizione');
      const scadenzaRaw = get('scadenza');
      const yieldRaw = get('yield');
      const prezzoRaw = get('prezzo');
      const durationRaw = get('duration');
      const zSpreadRaw = get('zSpread');

      // Estrai bondid e marketcode dai link nella riga
      let bondid = null;
      let marketcode = 'MOT';
      $(row).find('a[href]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/bondid=(\d+)/i);
        if (m) { bondid = m[1]; }
        const mc = href.match(/marketcode=([A-Z]+)/i);
        if (mc) { marketcode = mc[1]; }
      });

      const emittente = extractIssuer(descrizione);
      bonds.push({
        isin,
        monitor: monitorName,
        paese: getPaese(isin, monitorName, descrizione, emittente),
        descrizione,
        emittente,
        divisa: get('divisa') || 'EUR',
        scadenza: parseDate(scadenzaRaw),
        scadenzaRaw,
        lottoMinimo: get('lotto'),
        status: get('status'),
        mercato: get('mercato'),
        prezzo: parseNumber(prezzoRaw),
        prezzoRaw,
        volume: parseNumber(get('volume')),
        vr: get('vr'),
        tipoCalcolo: get('tipoCalcolo'),
        yield: parseNumber(yieldRaw),
        yieldRaw,
        duration: parseNumber(durationRaw),
        durationRaw,
        zSpread: parseNumber(zSpreadRaw),
        zSpreadRaw,
        bondid,
        marketcode,
      });
    });

    if (bonds.length > 0) return false; // trovata la tabella, stop
  });

  return bonds;
}

async function scrapeMonitor(monitor) {
  const url = `https://www.simpletoolsforinvestors.eu/monitor_info.php?monitor=${monitor.id}&yieldtype=G&timescale=DUR`;

  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
    },
    timeout: 30000,
  });

  const $ = cheerio.load(response.data);
  return parseTable($, monitor.name);
}

async function refreshData() {
  if (state.isUpdating) return;
  state.isUpdating = true;
  state.errors = [];

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Avvio aggiornamento dati...`);

  const allBonds = [];
  const seen = new Set();

  for (const monitor of MONITORS) {
    try {
      const bonds = await scrapeMonitor(monitor);
      let added = 0;
      for (const bond of bonds) {
        if (!seen.has(bond.isin)) {
          seen.add(bond.isin);
          allBonds.push(bond);
          added++;
        }
      }
      console.log(`  [OK] ${monitor.name}: ${added} titoli unici (${bonds.length} totali)`);
    } catch (err) {
      const msg = err.message;
      console.error(`  [ERR] ${monitor.name}: ${msg}`);
      state.errors.push({ monitor: monitor.name, error: msg });
    }

    // Pausa cortese tra le richieste + GC esplicito per liberare memoria cheerio
    await new Promise(r => setTimeout(r, 800));
    if (global.gc) global.gc();
  }

  if (allBonds.length > 0) {
    state.bonds = allBonds;
    state.lastUpdate = new Date().toISOString();
    const nextUpdateTime = new Date(Date.now() + REFRESH_INTERVAL);
    state.nextUpdate = nextUpdateTime.toISOString();
    console.log(`[${new Date().toISOString()}] Aggiornamento completato. Totale: ${allBonds.length} titoli`);
  } else {
    console.log(`[${new Date().toISOString()}] Nessun dato scraped, mantengo dati precedenti`);
  }

  state.isUpdating = false;
}

// Middleware CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

// ── Custom Templates — server-side persistence ─────────────────────────────
// Su Railway: crea un Volume e montalo su /data  →  i template sopravvivono ai deploy
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const TMPL_FILE  = path.join(DATA_DIR, 'custom-templates.json');

function loadCustomTemplates() {
  try {
    if (fs.existsSync(TMPL_FILE)) return JSON.parse(fs.readFileSync(TMPL_FILE, 'utf8'));
  } catch (e) { console.error('[templates] load error:', e.message); }
  return [];
}
function saveCustomTemplates(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TMPL_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) { console.error('[templates] save error:', e.message); }
}

// GET  /api/templates        — lista tutti i custom template
app.get('/api/templates', (req, res) => {
  res.json(loadCustomTemplates());
});

// POST /api/templates        — crea o aggiorna un template (upsert per key)
app.post('/api/templates', (req, res) => {
  const tmpl = req.body;
  if (!tmpl || !tmpl.key) return res.status(400).json({ error: 'key mancante' });
  const list = loadCustomTemplates();
  const idx  = list.findIndex(t => t.key === tmpl.key);
  if (idx >= 0) list[idx] = tmpl; else list.push(tmpl);
  saveCustomTemplates(list);
  res.json({ ok: true, count: list.length });
});

// DELETE /api/templates/:key — elimina un template
app.delete('/api/templates/:key', (req, res) => {
  const list = loadCustomTemplates().filter(t => t.key !== req.params.key);
  saveCustomTemplates(list);
  res.json({ ok: true });
});

// ── CLIENTS ──────────────────────────────────────────────────────────────────
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
function loadClients() {
  try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); } catch { return []; }
}
function saveClients(list) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/clients', (req, res) => {
  res.json(loadClients());
});

app.post('/api/clients', (req, res) => {
  const { id, name } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  const list = loadClients();
  if (!list.find(c => c.id === id)) list.push({ id, name });
  saveClients(list);
  res.json({ ok: true });
});

app.delete('/api/clients/:id', (req, res) => {
  const list = loadClients().filter(c => c.id !== req.params.id);
  saveClients(list);
  res.json({ ok: true });
});

// ── PORTFOLIOS ───────────────────────────────────────────────────────────────
function portfolioFile(clientId) {
  return path.join(DATA_DIR, `portfolio_${clientId}.json`);
}

app.get('/api/portfolios/:clientId', (req, res) => {
  const f = portfolioFile(req.params.clientId);
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf8'))); }
  catch { res.json({}); }
});

app.post('/api/portfolios/:clientId', (req, res) => {
  const f = portfolioFile(req.params.clientId);
  fs.writeFileSync(f, JSON.stringify(req.body || {}, null, 2));
  res.json({ ok: true });
});

// ── ALERTS ───────────────────────────────────────────────────────────────────
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
function loadAlerts() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch { return []; }
}
function saveAlerts(list) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/alerts', (req, res) => {
  res.json(loadAlerts());
});

app.post('/api/alerts', (req, res) => {
  const alert = req.body || {};
  if (!alert.id) alert.id = Date.now().toString();
  const list = loadAlerts();
  const idx = list.findIndex(a => a.id === alert.id);
  if (idx >= 0) list[idx] = alert; else list.push(alert);
  saveAlerts(list);
  res.json({ ok: true });
});

app.delete('/api/alerts/:id', (req, res) => {
  const list = loadAlerts().filter(a => a.id !== req.params.id);
  saveAlerts(list);
  res.json({ ok: true });
});

// ── NOTES ────────────────────────────────────────────────────────────────────
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch { return {}; }
}
function saveNotes(map) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(map, null, 2));
}

app.get('/api/notes', (req, res) => {
  res.json(loadNotes());
});

app.post('/api/notes/:isin', (req, res) => {
  const map = loadNotes();
  map[req.params.isin] = (req.body || {}).text || '';
  saveNotes(map);
  res.json({ ok: true });
});

// ── WATCHLISTS ───────────────────────────────────────────────────────────────
const WATCHLISTS_FILE = path.join(DATA_DIR, 'watchlists.json');
function loadWatchlists() {
  try { return JSON.parse(fs.readFileSync(WATCHLISTS_FILE, 'utf8')); }
  catch { return { lists: { 1: [], 2: [], 3: [] }, names: { '1': 'Lista 1', '2': 'Lista 2', '3': 'Lista 3' } }; }
}
function saveWatchlistsFile(data) {
  try { fs.writeFileSync(WATCHLISTS_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}

app.get('/api/watchlists', (req, res) => {
  res.json(loadWatchlists());
});

app.post('/api/watchlists', (req, res) => {
  const data = req.body || {};
  saveWatchlistsFile(data);
  res.json({ ok: true });
});

// API: versione build — il client lo usa per rilevare deploy e ricaricare automaticamente
app.get('/api/version', (req, res) => {
  res.json({ build: SERVER_BUILD });
});

// Serve index.html con redirect forzato alla versione corrente — bypassare la cache del browser
// Visita /  →  redirect 302 (non cacheable) a /?v=BUILD  →  HTML fresco senza cache
// Anche se il browser ha / o /?v=OLD in cache, il redirect passerà sempre dal server
const INDEX_PATH = path.join(__dirname, 'public/index.html');
app.get(['/', '/index.html'], (req, res) => {
  const clientV = req.query.v;
  // Se la versione nel query param non corrisponde al build corrente → redirect al build corrente
  if (String(clientV) !== String(SERVER_BUILD)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.redirect(302, `/?v=${SERVER_BUILD}`);
  }
  // Versione corretta → servi l'HTML senza cache
  try {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(html);
  } catch (e) {
    res.status(500).send('Errore caricamento pagina');
  }
});

// Serve static files (CSS, JS, immagini) — HTML gestito sopra
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // non servire index.html automaticamente (gestito sopra)
}));

// API: tutti i titoli
app.get('/api/bonds', (req, res) => {
  res.json({
    bonds: state.bonds,
    lastUpdate: state.lastUpdate,
    nextUpdate: state.nextUpdate,
    total: state.bonds.length,
    isUpdating: state.isUpdating,
    errors: state.errors,
  });
});

// API: forza aggiornamento manuale
app.get('/api/refresh', (req, res) => {
  if (!state.isUpdating) {
    refreshData();
  }
  res.json({ message: 'Aggiornamento avviato', isUpdating: true });
});

// API: stato corrente
app.get('/api/status', (req, res) => {
  res.json({
    lastUpdate: state.lastUpdate,
    nextUpdate: state.nextUpdate,
    total: state.bonds.length,
    isUpdating: state.isUpdating,
    errors: state.errors,
  });
});

// ─── GRAFICI STORICI ─────────────────────────────────────────────────────────

const chartCache = {};
const CHART_CACHE_TTL = 60 * 60 * 1000; // 1 ora

// Suffissi Yahoo Finance per paese ISIN
const YAHOO_SUFFIXES = {
  IT: ['.MI', '.F'],
  DE: ['.DE', '.F', '.BE', '.MI'],
  FR: ['.PA', '.F', '.MI'],
  ES: ['.MC', '.MI'],
  PT: ['.LS', '.MI'],
  GR: ['.AT', '.MI'],
  AT: ['.VI', '.DE', '.F', '.MI'],
  NL: ['.AS', '.F', '.MI'],
  BE: ['.BR', '.F', '.MI'],
  FI: ['.HE', '.F', '.MI'],
  IE: ['.MI', '.L', '.DE', '.F'],   // iShares: Borsa Italiana, LSE (ticker), XETRA, Frankfurt
  LU: ['.MI', '.DE', '.F'],          // Amundi/Xtrackers: Borsa Italiana, XETRA, Frankfurt
  XS: ['.MI', '.F', '.PA'],   // Eurobond/Sovranazionali
  EU: ['.MI', '.F'],           // EU bonds
  XF: ['.MI', '.F'],
  US: ['', '.MI'],
  GB: ['.L', '.MI'],
  RO: ['.MI', '.F'],
};

function calcPeriod1(range) {
  const d = new Date();
  switch (range) {
    case 'ytd': return Math.floor(new Date(d.getFullYear(), 0, 1) / 1000);
    case '1y':  d.setFullYear(d.getFullYear() - 1); return Math.floor(d / 1000);
    case '2y':  d.setFullYear(d.getFullYear() - 2); return Math.floor(d / 1000);
    case '3y':  d.setFullYear(d.getFullYear() - 3); return Math.floor(d / 1000);
    case '5y':  d.setFullYear(d.getFullYear() - 5); return Math.floor(d / 1000);
    default:    return 0;
  }
}

// Calcola serie storica yield TTM da dividendi + prezzi
// dividends: [{date: seconds, amount: x}, ...]
// pricePoints: [[ms, close], ...]
// Restituisce [[ms, yieldPct], ...] — solo punti dove il TTM è > 0
function computeETFYieldSeries(pricePoints, dividends) {
  if (!dividends || dividends.length === 0) return [];
  const YEAR_MS = 365.25 * 24 * 3600 * 1000;
  const result  = [];
  // Per ogni punto prezzo calcola la somma dividendi negli ultimi 12 mesi
  // Pre-converti i timestamp dividendi una volta sola (Yahoo può restituire secondi, ms, o ISO string)
  const divTimestamps = dividends.map(d => {
    let t;
    if (typeof d.date === 'number') {
      t = d.date > 1e12 ? d.date : d.date * 1000; // secondi → ms
    } else {
      t = new Date(d.date).getTime(); // ISO string o Date object → ms
    }
    return { ts: t, amount: d.amount };
  }).filter(d => !isNaN(d.ts));

  for (const [ts, price] of pricePoints) {
    if (!price || price <= 0) continue;
    const cutoff = ts - YEAR_MS;
    let ttmSum = 0;
    for (const d of divTimestamps) {
      if (d.ts >= cutoff && d.ts <= ts) ttmSum += d.amount;
    }
    if (ttmSum > 0) result.push([ts, (ttmSum / price) * 100]);
  }
  return result;
}

// Exchange alternativi dove cercare dividendi quando il simbolo principale non li ha
// XETRA (.DE) e Francoforte (.F) riportano spesso dividendi per ETF europei
const DIV_FALLBACK_SUFFIXES = ['.DE', '.F', '.PA', '.L', '.AS'];

// Tenta Yahoo Finance con diversi suffissi di borsa
// Richiede anche i dividendi (events:'div') per calcolare lo yield TTM degli ETF
// tickerHint:  ticker dell'ETF (es. 'EM13') — usato per cercare dividendi su exchange alternativi
// divSymbolHint: simbolo specifico da cui prendere i dividendi (es. 'EGV3.DE' per EM13)
async function tryYahooFinance(isin, tickerHint = null, divSymbolHint = null) {
  const prefix = isin.substring(0, 2).toUpperCase();
  const suffixes = YAHOO_SUFFIXES[prefix] || ['.MI', '.F'];
  const period1 = new Date(Date.now() - 6 * 365 * 24 * 3600 * 1000); // 6 anni

  let bestResult = null; // risultato con prezzo ma senza dividendi (fallback)

  // Suffissi per il fallback ticker (più ampi di quelli ISIN)
  const TICKER_FALLBACK = ['.DE', '.MI', '.F', '.L', '.AS', '.PA'];

  // Prova prima con ISIN+suffisso, poi con ticker+suffisso (utile per ETF che Yahoo Finance
  // non indicizza con ISIN ma riconosce tramite ticker, es. XEMB.DE, EMI.MI, IHYG.L)
  const isinSymbols   = suffixes.map(s => isin + s);
  const tickerSymbols = tickerHint ? TICKER_FALLBACK.map(s => tickerHint + s) : [];
  const symbolsToTry  = [...isinSymbols, ...tickerSymbols];

  for (const symbol of symbolsToTry) {
    // Se abbiamo già prezzi e siamo nella parte ticker → passa direttamente al fallback dividendi
    if (bestResult && !isinSymbols.includes(symbol)) break;
    try {
      const result = await yahooFinance.chart(symbol, { period1, interval: '1d', events: 'div' }, { validateResult: false });
      const quotes = (result.quotes || []).filter(q => q.close != null);
      if (quotes.length >= 20) {
        const currency = result.meta?.currency || 'EUR';
        const pricePoints = quotes.map(q => [new Date(q.date).getTime(), q.close]);

        const divRaw = result.events?.dividends || {};
        const dividends = Array.isArray(divRaw) ? divRaw : Object.values(divRaw);
        const yieldData = computeETFYieldSeries(pricePoints, dividends);

        if (yieldData.length > 0) {
          console.log(`  [CHART] ${symbol}: ${quotes.length} prezzi, ${yieldData.length} punti yield TTM`);
          return { source: 'Yahoo Finance', symbol, currency, price: pricePoints, yieldData, zspreadData: [] };
        }

        if (!bestResult) {
          bestResult = { source: 'Yahoo Finance', symbol, currency, price: pricePoints, zspreadData: [] };
        }
      }
    } catch (e) { /* prova prossimo simbolo */ }
  }

  // Helper: cerca dividendi su un exchange alternativo e li combina con i prezzi di base
  async function findDividendsOnAltExchange(basePricePoints) {
    // 1. Se esiste un divSymbol specifico (es. EGV3.DE per EM13), usalo prima
    const directSymbols = divSymbolHint ? [divSymbolHint] : [];
    // 2. Poi prova ticker + exchange fallback
    const tickerSymbols = tickerHint ? DIV_FALLBACK_SUFFIXES.map(s => tickerHint + s) : [];
    const allCandidates = [...directSymbols, ...tickerSymbols];

    for (const altSym of allCandidates) {
      try {
        const r = await yahooFinance.chart(altSym, { period1, interval: '1d', events: 'div' }, { validateResult: false });
        const divRaw = r.events?.dividends || {};
        const divs = Array.isArray(divRaw) ? divRaw : Object.values(divRaw);
        if (divs.length > 0) {
          const yieldData = computeETFYieldSeries(basePricePoints, divs);
          if (yieldData.length > 0) {
            console.log(`  [CHART] Dividendi da ${altSym} (${divs.length} div) → ${yieldData.length} punti yield TTM`);
            return yieldData;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  if (bestResult) {
    // Cerca dividendi su exchange alternativi usando il ticker
    const yieldData = await findDividendsOnAltExchange(bestResult.price);
    console.log(`  [CHART] ${bestResult.symbol}: ${bestResult.price.length} punti${yieldData?.length ? ', '+yieldData.length+' yield TTM' : ' (no dividends)'}`);
    return { ...bestResult, yieldData: yieldData || [] };
  }

  // Ultimo tentativo: ricerca per ISIN (simbolo non trovato nei suffissi standard)
  // Strategia: primo risultato con prezzo ok → usarlo per prezzi
  //            continua a scorrere i risultati cercando uno con dividendi
  try {
    const search = await yahooFinance.search(isin, { quotesCount: 5, newsCount: 0 }, { validateResult: false });
    let searchBest = null; // primo risultato con prezzi (potrebbe non avere dividendi)

    for (const q of (search.quotes || [])) {
      try {
        const result = await yahooFinance.chart(q.symbol, { period1, interval: '1d', events: 'div' }, { validateResult: false });
        const quotes = (result.quotes || []).filter(r => r.close != null);
        if (quotes.length >= 20) {
          const pricePoints = quotes.map(r => [new Date(r.date).getTime(), r.close]);
          const divRaw = result.events?.dividends || {};
          const dividends = Array.isArray(divRaw) ? divRaw : Object.values(divRaw);

          if (!searchBest) {
            // Salva come best: ha prezzi, potrebbe non avere dividendi
            searchBest = {
              source: 'Yahoo Finance', symbol: q.symbol,
              currency: result.meta?.currency || 'EUR',
              price: pricePoints, zspreadData: [],
            };
          }

          if (dividends.length > 0) {
            // Trovati dividendi: usa prezzi del best (o questo se è il primo) + questi dividendi
            const basePts = searchBest.price;
            const yieldData = computeETFYieldSeries(basePts, dividends);
            console.log(`  [CHART] Yahoo Search OK: ${q.symbol} — ${quotes.length} punti, ${dividends.length} dividendi`);
            return { ...searchBest, symbol: searchBest.symbol, yieldData };
          }
        }
      } catch (e) {}
    }

    // Nessun simbolo con dividendi trovato: prova exchange alternativi con ticker
    if (searchBest) {
      const yieldData = await findDividendsOnAltExchange(searchBest.price);
      console.log(`  [CHART] Yahoo Search OK: ${searchBest.symbol} — ${searchBest.price.length} punti${yieldData?.length ? ', '+yieldData.length+' yield TTM' : ' (no dividends)'}`);
      return { ...searchBest, yieldData: yieldData || [] };
    }
  } catch (e) {}

  return null;
}

// Fonte secondaria: simpletoolsforinvestors (~12 mesi, ma ha yield e z-spread)
async function trySiteChart(bond) {
  if (!bond || !bond.bondid) return null;
  const url = `https://www.simpletoolsforinvestors.eu/historicalgraph.php?bondid=${bond.bondid}&marketcode=${bond.marketcode || 'MOT'}`;
  const resp = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
      'Referer': 'https://www.simpletoolsforinvestors.eu/',
    },
    timeout: 20000,
  });
  const match = resp.data.match(/"data"\s*:\s*(\[\[[\s\S]*?\]\])/);
  if (!match) return null;
  const raw = JSON.parse(match[1]);
  if (!raw || raw.length === 0) return null;
  return {
    source: 'simpletoolsforinvestors',
    symbol: bond.isin,
    currency: bond.divisa || 'EUR',
    price:      raw.map(([ts, p])    => [ts, p]).filter(([, v]) => v != null),
    yieldData:  raw.map(([ts,, y])   => [ts, y]).filter(([, v]) => v != null),
    zspreadData:raw.map(([ts,,, z])  => [ts, z]).filter(([, v]) => v != null),
  };
}

// Unisce Yahoo (lungo) con sito (recente, ha yield/zspread)
function mergeData(yahoo, site) {
  if (!yahoo && !site) return null;
  if (!yahoo) return site;
  if (!site)  return { ...yahoo, source: 'Yahoo Finance' };

  // Prendi prezzi da Yahoo (più lungo), yield/zspread dal sito
  // Deduplica per timestamp
  const siteTs = new Set(site.price.map(([ts]) => ts));
  const yahooOnly = yahoo.price.filter(([ts]) => !siteTs.has(ts));
  const mergedPrice = [...yahooOnly, ...site.price].sort((a, b) => a[0] - b[0]);

  return {
    source: 'Yahoo Finance + simpletoolsforinvestors',
    symbol: yahoo.symbol,
    currency: yahoo.currency || site.currency,
    price: mergedPrice,
    yieldData: site.yieldData,
    zspreadData: site.zspreadData,
  };
}

function filterByRange(data, range) {
  const cutoff = calcPeriod1(range) * 1000;
  return {
    ...data,
    price:       data.price.filter(([ts]) => ts >= cutoff),
    yieldData:   data.yieldData.filter(([ts]) => ts >= cutoff),
    zspreadData: data.zspreadData.filter(([ts]) => ts >= cutoff),
  };
}

// API: dati storici grafico
app.get('/api/chart/:isin', async (req, res) => {
  const isin = req.params.isin.toUpperCase();
  const range = ['ytd','1y','2y','3y','5y','max'].includes(req.query.range) ? req.query.range : 'max';
  const cacheKey = isin;

  const cached = chartCache[cacheKey];
  if (cached && Date.now() - cached.ts < CHART_CACHE_TTL) {
    return res.json(filterByRange(cached.data, range));
  }

  const bond      = state.bonds.find(b => b.isin === isin);
  const ticker    = null;
  const divSymbol = null;

  try {
    console.log(`[CHART] Recupero dati per ${isin}${ticker ? ' ('+ticker+(divSymbol?'/'+divSymbol:'')+')' : ''}...`);

    // Tenta entrambe le fonti in parallelo
    const [yahoo, site] = await Promise.allSettled([
      tryYahooFinance(isin, ticker, divSymbol),
      trySiteChart(bond),
    ]);

    const yahooData = yahoo.status === 'fulfilled' ? yahoo.value : null;
    const siteData  = site.status  === 'fulfilled' ? site.value  : null;

    const data = mergeData(yahooData, siteData);

    if (!data || data.price.length === 0) {
      return res.status(404).json({ error: 'Nessun dato storico disponibile per questo titolo', isin });
    }

    // Calcola quanti anni di dati abbiamo
    const minTs = Math.min(...data.price.map(([ts]) => ts));
    const yearsAvailable = (Date.now() - minTs) / (365.25 * 24 * 3600 * 1000);
    data.yearsAvailable = Math.round(yearsAvailable * 10) / 10;

    chartCache[cacheKey] = { data, ts: Date.now() };
    console.log(`[CHART] ${isin}: ${data.price.length} prezzi, fonte: ${data.source}, anni: ${data.yearsAvailable}`);
    res.json(filterByRange(data, range));
  } catch (err) {
    console.error(`[CHART] Errore per ${isin}:`, err.message);
    res.status(500).json({ error: 'Errore nel recupero dati storici', detail: err.message });
  }
});

// ETF rimossi — dashboard bond-only
// ─── CALENDAR (Feature 6) ────────────────────────────────────────────────────

// ECB 2025-2026 Governing Council meeting dates
const ECB_MEETINGS = [
  '2025-04-17','2025-06-05','2025-07-24','2025-09-11','2025-10-30','2025-12-18',
  '2026-01-29','2026-03-12','2026-04-30','2026-06-18','2026-07-23','2026-09-17','2026-10-29','2026-12-17'
].map(d => ({ date: d, type:'ecb', title:'Riunione BCE', desc:'Governing Council — decisione tassi', color:'#3b82f6' }));

const CALENDAR_FILE = path.join(DATA_DIR, 'calendar-events.json');
function loadCalendarEvents() {
  let custom = [];
  try { if(fs.existsSync(CALENDAR_FILE)) custom = JSON.parse(fs.readFileSync(CALENDAR_FILE,'utf8')); } catch(e){}
  return [...ECB_MEETINGS, ...custom].sort((a,b) => a.date.localeCompare(b.date));
}

app.get('/api/calendar', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const events = loadCalendarEvents().filter(e => e.date >= today);
  res.json(events.slice(0, 30));
});

app.post('/api/calendar', (req, res) => {
  let custom = [];
  try { if(fs.existsSync(CALENDAR_FILE)) custom = JSON.parse(fs.readFileSync(CALENDAR_FILE,'utf8')); } catch(e){}
  custom.push({ ...req.body, id: 'evt_' + Date.now() });
  try { fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(CALENDAR_FILE, JSON.stringify(custom,null,2)); } catch(e){}
  res.json({ok:true});
});

app.delete('/api/calendar/:id', (req, res) => {
  let custom = [];
  try { if(fs.existsSync(CALENDAR_FILE)) custom = JSON.parse(fs.readFileSync(CALENDAR_FILE,'utf8')); } catch(e){}
  custom = custom.filter(e => e.id !== req.params.id);
  try { fs.writeFileSync(CALENDAR_FILE, JSON.stringify(custom,null,2)); } catch(e){}
  res.json({ok:true});
});

// ─── MACRO ────────────────────────────────────────────────────────────────────

let macroCache = null, macroCacheTime = 0;
const MACRO_CACHE_TTL = 30 * 60 * 1000;

async function fetchECBSeries(seriesKey) {
  try {
    // Usa startPeriod (24 mesi fa) invece di lastNObservations=2:
    // con lastNObservations la struttura "dates" contiene TUTTI i periodi storici
    // e l'indice dell'osservazione punta al posto giusto nella lista completa,
    // ma alcune serie (es. HICP ANR) possono avere sfasamenti.
    // Con startPeriod la struttura è 0-based dal periodo richiesto → più affidabile.
    const d = new Date();
    d.setFullYear(d.getFullYear() - 2);
    const startPeriod = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const url = `https://data-api.ecb.europa.eu/service/data/${seriesKey}?startPeriod=${startPeriod}&format=jsondata`;
    const resp = await axios.get(url, { timeout: 10000 });
    const dataset = resp.data.dataSets?.[0];
    if (!dataset) return null;
    const series = Object.values(dataset.series || {})[0];
    if (!series) return null;
    const obs = series.observations || {};
    const keys = Object.keys(obs).sort((a, b) => +a - +b);
    if (!keys.length) return null;
    const lastKey = keys[keys.length - 1];
    const prevKey = keys.length > 1 ? keys[keys.length - 2] : null;
    const dates = resp.data.structure?.dimensions?.observation?.[0]?.values || [];
    return {
      value: obs[lastKey]?.[0] ?? null,
      prev:  prevKey ? (obs[prevKey]?.[0] ?? null) : null,
      date:  dates[+lastKey]?.id ?? null,
    };
  } catch (e) { return null; }
}

// Usa chart() invece di quote() — quote() non funziona per indici Yahoo Finance
async function fetchYahooIndicator(symbol) {
  try {
    const period1 = new Date(Date.now() - 10 * 24 * 3600 * 1000); // ultimi 10 giorni
    const result = await yahooFinance.chart(symbol, { period1, interval: '1d' }, { validateResult: false });
    const quotes = (result.quotes || []).filter(q => q.close != null);
    if (quotes.length < 1) return null;
    const last = quotes[quotes.length - 1];
    const prev = quotes.length > 1 ? quotes[quotes.length - 2] : null;
    return {
      value:         last.close,
      change:        prev ? +(last.close - prev.close).toFixed(3) : null,
      changePercent: prev ? +((last.close - prev.close) / prev.close * 100).toFixed(3) : null,
      date:          new Date(last.date).toISOString().split('T')[0],
    };
  } catch (e) {}
  return null;
}

// Fetch rendimento 10Y da Stooq (dati benchmark ufficiali)
// Tickers: 10ity.b = BTP 10Y Italia, 10dey.b = Bund 10Y Germania
async function fetchGovYield10YStooq(sym) {
  const url = `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`;
  const resp = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const lines = resp.data.trim().split('\n');
  if (lines.length < 2) throw new Error('no data');
  const cols = lines[1].split(',');
  // Format: Symbol,Date,Time,Open,High,Low,Close,Volume
  const close = parseFloat(cols[6]);
  if (isNaN(close) || close <= 0) throw new Error('invalid: ' + cols[6]);
  // Sanity check: i rendimenti 10Y governativi devono stare tra 0 e 20%
  if (close > 20) throw new Error('valore anomalo: ' + close);
  return { value: +close.toFixed(3), date: cols[1] };
}

// Ricava yield ~10Y da bond scrappati usando la MEDIANA nel range 7-13 anni
// Più robusto del singolo bond più vicino che può avere dati errati
function getBondYield10Y(paese, targetYears = 10, rangeYears = 3) {
  const today = new Date();
  const MIN_YIELD = 0.5, MAX_YIELD = 15; // sanity bounds per qualsiasi mercato
  const bonds = state.bonds
    .filter(b => b.paese === paese && b.yield !== null && b.scadenza)
    .map(b => ({ ...b, years: (new Date(b.scadenza) - today) / (365.25 * 24 * 3600 * 1000) }))
    .filter(b => b.years >= targetYears - rangeYears && b.years <= targetYears + rangeYears)
    .filter(b => b.yield >= MIN_YIELD && b.yield <= MAX_YIELD);

  if (!bonds.length) return null;

  // Mediana — immune a outlier singoli con dati sbagliati
  const yields = bonds.map(b => b.yield).sort((a, b) => a - b);
  const median  = yields[Math.floor(yields.length / 2)];

  return {
    value: +median.toFixed(3),
    date:  state.lastUpdate ? state.lastUpdate.split('T')[0] : null,
    note:  `Mediana ${yields.length} bond ${paese} ${targetYears - rangeYears}–${targetYears + rangeYears}Y`,
  };
}

app.get('/api/macro', async (req, res) => {
  if (macroCache && Date.now() - macroCacheTime < MACRO_CACHE_TTL) return res.json(macroCache);
  try {
    // ECB API (gratuita) + Yahoo Finance chart() per US yields
    const [ecbRate, us10y, us3m, us30y] = await Promise.all([
      fetchECBSeries('FM/B.U2.EUR.4F.KR.DFR.LEV'),
      fetchYahooIndicator('^TNX'),
      fetchYahooIndicator('^IRX'),
      fetchYahooIndicator('^TYX'),
    ]);

    // BTP 10Y — mediana bond scrappati 7-13Y (robusto su outlier)
    // Bund 10Y — ECB Yield Curve AAA 10Y (fonte ufficiale)
    const ita10yFB = getBondYield10Y('Italia');
    let ita10y = ita10yFB ? { value: ita10yFB.value, date: ita10yFB.date, note: ita10yFB.note } : null;
    if (ita10y) console.log(`[macro] BTP 10Y: ${ita10y.value}% (${ita10y.note})`);

    let ger10y = null;
    const ecbYCBund = await fetchECBSeries('YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y').catch(() => null);
    if (ecbYCBund?.value != null) {
      ger10y = { value: +ecbYCBund.value.toFixed(3), date: ecbYCBund.date, note: 'ECB YC AAA' };
      console.log(`[macro] Bund 10Y: ${ger10y.value}% (ECB YC AAA)`);
    } else {
      const ger10yFB = getBondYield10Y('Germania');
      if (ger10yFB) ger10y = { value: ger10yFB.value, date: ger10yFB.date, note: ger10yFB.note };
    }

    const spreadBtpBund = (ita10y?.value != null && ger10y?.value != null)
      ? { value: +((ita10y.value - ger10y.value) * 100).toFixed(0), date: ita10y.date }
      : null;

    const data = { ecbRate, us10y, us3m, us30y, ger10y, ita10y, spreadBtpBund,
                   lastUpdate: new Date().toISOString() };
    macroCache = data;
    macroCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error('[MACRO] Errore:', err.message);
    if (macroCache) return res.json(macroCache);
    res.status(500).json({ error: 'Errore dati macro', detail: err.message });
  }
});

// ─── MACRO INDICATORS ────────────────────────────────────────────────────────

let macroIndicatorsCache = null;
let macroIndicatorsLastFetch = 0;
const MACRO_TTL = 15 * 60 * 1000; // 15 min

async function fetchMacroIndicators() {
  const now = Date.now();
  if (macroIndicatorsCache && (now - macroIndicatorsLastFetch) < MACRO_TTL) {
    return macroIndicatorsCache;
  }

  const indicators = {};

  // BTP 10Y — mediana bond scrappati nel range 7-13Y (più robusto di singolo bond)
  let btp10val = null, bund10val = null;
  const btp10 = getBondYield10Y('Italia');
  if (btp10) {
    btp10val = btp10.value;
    indicators.btp10y = { value: btp10val, label: 'BTP 10Y', unit: '%', desc: btp10.note };
    console.log(`[macro-ind] BTP 10Y: ${btp10val}% (${btp10.note})`);
  }

  // Bund 10Y — ECB Yield Curve AAA 10Y (fonte ufficiale BCE)
  try {
    const ecbYC = await fetchECBSeries('YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y');
    if (ecbYC && ecbYC.value != null) {
      bund10val = +ecbYC.value.toFixed(3);
      indicators.bund10y = { value: bund10val, label: 'Bund 10Y', unit: '%', desc: `ECB YC AAA ${ecbYC.date || ''}` };
      console.log(`[macro-ind] Bund 10Y: ${bund10val}% (ECB YC AAA)`);
    }
  } catch(e) {
    console.error('[macro-ind] Bund 10Y ECB err:', e.message);
    // Fallback: mediana bond scrappati Germania
    const bund10 = getBondYield10Y('Germania');
    if (bund10) { bund10val = bund10.value; indicators.bund10y = { value: bund10val, label: 'Bund 10Y', unit: '%', desc: bund10.note }; }
  }

  if (btp10val != null && bund10val != null)
    indicators.spread = { value: Math.round((btp10val - bund10val) * 100), label: 'Spread BTP/Bund', unit: 'bps' };

  // EUR/USD from Yahoo Finance
  try {
    const fx = await fetchYahooIndicator('EURUSD=X');
    if (fx && fx.value) {
      indicators.eurusd = { value: fx.value.toFixed(4), label: 'EUR/USD', unit: '', change: fx.changePercent != null ? fx.changePercent.toFixed(2) : null };
    }
  } catch(e) { console.error('[macro-ind] EUR/USD error:', e.message); }

  // Gold price (XAU/USD) from Yahoo Finance
  try {
    const gold = await fetchYahooIndicator('GC=F');
    if (gold && gold.value) {
      indicators.gold = { value: gold.value.toFixed(0), label: 'Oro (XAU/USD)', unit: '$', change: gold.changePercent != null ? gold.changePercent.toFixed(2) : null };
    }
  } catch(e) { console.error('[macro-ind] Gold error:', e.message); }

  // ECB deposit rate — from ECB Data Portal
  try {
    const ecbUrl = 'https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=jsondata&lastNObservations=1';
    const resp = await axios.get(ecbUrl, { timeout: 8000 });
    const dataset = resp.data?.dataSets?.[0];
    const series = dataset ? Object.values(dataset.series || {})[0] : null;
    const obs = series?.observations;
    if (obs) {
      const keys = Object.keys(obs);
      const latest = obs[keys[keys.length - 1]];
      if (latest && latest[0] != null) {
        indicators.ecbRate = { value: latest[0].toFixed(2), label: 'Tasso BCE (Deposit)', unit: '%' };
      }
    }
  } catch(e) {
    console.error('[macro-ind] ECB rate error:', e.message);
    indicators.ecbRate = { value: '2.25', label: 'Tasso BCE (Deposit)', unit: '%', isStale: true };
  }
  if (!indicators.ecbRate) {
    indicators.ecbRate = { value: '2.25', label: 'Tasso BCE (Deposit)', unit: '%', isStale: true };
  }

  // US 10Y Treasury from Yahoo Finance
  try {
    const us10 = await fetchYahooIndicator('^TNX');
    if (us10 && us10.value) {
      indicators.us10y = { value: us10.value.toFixed(3), label: 'US Treasury 10Y', unit: '%', change: us10.changePercent != null ? us10.changePercent.toFixed(2) : null };
    }
  } catch(e) { console.error('[macro-ind] US10Y error:', e.message); }

  // VIX from Yahoo Finance
  try {
    const vix = await fetchYahooIndicator('^VIX');
    if (vix && vix.value) {
      indicators.vix = { value: vix.value.toFixed(1), label: 'VIX', unit: '', change: vix.changePercent != null ? vix.changePercent.toFixed(2) : null };
    }
  } catch(e) { console.error('[macro-ind] VIX error:', e.message); }

  macroIndicatorsCache = { indicators, updatedAt: new Date().toISOString() };
  macroIndicatorsLastFetch = now;
  return macroIndicatorsCache;
}

app.get('/api/macro-indicators', async (req, res) => {
  try {
    const data = await fetchMacroIndicators();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gestione errori globale — previene crash del processo ─────────────────
process.on('uncaughtException', (err, origin) => {
  console.error(`[CRASH PREVENTED] uncaughtException (${origin}): ${err.message}`);
  console.error(err.stack);
  // Non usciamo: il server rimane in piedi
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[CRASH PREVENTED] unhandledRejection: ${msg}`);
  // Non usciamo
});

// Caricamento iniziale — aspetta 10s per lasciare che Node.js completi l'inizializzazione
setTimeout(() => refreshData().catch(e => console.error('[refreshData init]', e.message)), 10000);

// Auto-refresh bond ogni 20 minuti
setInterval(() => refreshData().catch(e => console.error('[refreshData]', e.message)), REFRESH_INTERVAL);

app.listen(PORT, () => {
  console.log(`\n✅ Bond Monitor avviato su http://localhost:${PORT}`);
  console.log(`   Aggiornamento automatico ogni ${REFRESH_INTERVAL / 60000} minuti\n`);
});
