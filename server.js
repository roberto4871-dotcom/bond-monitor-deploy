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

// Tutti i monitor della sezione "Sovranazionali e Governativi"
const MONITORS = [
  { id: 62, name: 'Sovranazionali' },
  { id: 63, name: 'Unione Europea' },
  { id: 73, name: 'ESG Green Bond' },
  { id: 82, name: 'Titoli ad alto rating' },
  { id: 5,  name: 'BTP - Italia' },
  { id: 74, name: 'BTP Futura / Valore / Più' },
  { id: 72, name: 'BOT' },
  { id: 66, name: 'Titoli di stato europei' },
  { id: 43, name: 'Altri titoli di stato' },
  { id: 10, name: 'Germania' },
  { id: 13, name: 'Francia' },
  { id: 78, name: 'Romania' },
  { id: 58, name: 'Stati Uniti' },
];

const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minuti

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

// Rileva paese dalla descrizione (fallback per ISIN XS/US con emittente non USA)
function getCountryFromDesc(desc) {
  for (const [re, paese] of DESC_PAESE_MAP) {
    if (re.test(desc)) return paese;
  }
  return null;
}

// Assegna paese considerando: monitor → prefisso ISIN → keywords emittente → descrizione
function getPaese(isin, monitorName, descrizione) {
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
            else if (t === 'yield') colMap.yield = idx;
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

      bonds.push({
        isin,
        monitor: monitorName,
        paese: getPaese(isin, monitorName, descrizione),
        descrizione,
        emittente: extractIssuer(descrizione),
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

    // Pausa cortese tra le richieste
    await new Promise(r => setTimeout(r, 800));
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
  const etfEntry  = ETF_LIST.find(e => e.isin === isin);
  const ticker    = etfEntry?.ticker    || null;
  const divSymbol = etfEntry?.divSymbol || null; // simbolo specifico con dati dividendi (es. EGV3.DE)

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

// ─── ETF ─────────────────────────────────────────────────────────────────────

// acc:true = accumulation (reinveste cedole), altrimenti distributing
// ytm = rendimento a scadenza del portafoglio sottostante (stima statica per ETF ACC senza distribuzione)
const ETF_LIST = [
  { isin:'LU1650491282', ticker:'EMI',    name:'Amundi EUR Gov Infl Linked',     cat:'Gov Inflation EUR', ter:0.14, dur:7.0,  acc:true,  ytm:2.3  },
  { isin:'LU1390062245', ticker:'INFL',   name:'Amundi EUR 2-10Y Infl Exp',      cat:'Gov Inflation EUR', ter:0.16, dur:7.0,  acc:true,  ytm:2.2  },
  { isin:'IE00B0M62X26', ticker:'IBCI',   name:'iShares Infl Linked EUR Gov',    cat:'Gov Inflation EUR', ter:0.10, dur:7.0,  acc:false, ytm:2.0   },
  { isin:'LU0290357929', ticker:'XGIN',   name:'Xtrackers Glob Infl Link EUR H', cat:'Gov Inflation GLB', ter:0.20, dur:7.0,  acc:true,  ytm:2.5  },
  { isin:'LU1390062831', ticker:'INFU',   name:'Amundi US$ 10Y Infl Exp',        cat:'Gov Inflation USD', ter:0.16, dur:7.5,  acc:true,  ytm:2.4  },
  { isin:'IE00B1FZSC47', ticker:'ITPS',   name:'iShares $ TIPS',                 cat:'Gov Inflation USD', ter:0.10, dur:7.5,  acc:false, ytm:3.5   },
  { isin:'LU1650487413', ticker:'EM13',   divSymbol:'EGV3.DE', name:'Amundi Euro Gov Bond 1-3Y',      cat:'Gov EUR 1-3Y',      ter:0.14, dur:1.9,  acc:true,  ytm:2.8  },
  { isin:'LU1598691050', ticker:'BTP13',  name:'Amundi EMTS 1-3Y ITA BTP',       cat:'Gov EUR 1-3Y',      ter:0.15, dur:1.9,  acc:true,  ytm:2.9  },
  { isin:'LU1650488494', ticker:'EM35',   divSymbol:'EGV5.DE', name:'Amundi Euro Gov Bond 3-5Y',      cat:'Gov EUR 3-5Y',      ter:0.14, dur:3.8,  acc:true,  ytm:3.0  },
  { isin:'LU1287023003', ticker:'EM57',   divSymbol:'EGV7.DE', name:'Amundi Euro Gov Bond 5-7Y',      cat:'Gov EUR 5-7Y',      ter:0.14, dur:5.5,  acc:true,  ytm:3.1  },
  { isin:'LU1287023185', ticker:'EM710',  name:'Amundi Euro Gov Bond 7-10Y',     cat:'Gov EUR 7-10Y',     ter:0.14, dur:7.5,  acc:true,  ytm:3.3  },
  { isin:'LU1650489385', ticker:'EM1015', name:'Amundi Euro Gov Bond 10-15Y',    cat:'Gov EUR 10-15Y',    ter:0.14, dur:11.0, acc:true,  ytm:3.5  },
  { isin:'LU1287023268', ticker:'EM15',   name:'Amundi Euro Gov Bond 15+Y',      cat:'Gov EUR 15+Y',      ter:0.14, dur:14.0, acc:true,  ytm:3.7  },
  { isin:'LU1598691217', ticker:'BTP10',  name:'Amundi EMTS 10Y ITA BTP',        cat:'Gov EUR 10+Y',      ter:0.15, dur:8.5,  acc:true,  ytm:4.0  },
  { isin:'LU1437018598', ticker:'EGOV',   name:'Amundi Euro Government Bond',    cat:'Gov EUR Blend',     ter:0.14, dur:7.0,  acc:true,  ytm:3.2  },
  { isin:'IE00B4WXJJ64', ticker:'SEGA',   name:'iShares Core EU Gov Bond',       cat:'Gov EUR Blend',     ter:0.09, dur:7.0,  acc:false, ytm:3.3   },
  { isin:'IE00B14X4S71', ticker:'IBTS',   name:'iShares $ Treasury 1-3Y',        cat:'Gov USD 1-3Y',      ter:0.07, dur:1.8,  acc:false, ytm:4.5   },
  { isin:'IE00B1FZS798', ticker:'IBTM',   name:'iShares $ Treasury 7-10Y',       cat:'Gov USD 7-10Y',     ter:0.07, dur:7.5,  acc:false, ytm:4.5   },
  { isin:'LU1407890620', ticker:'US10',   name:'Amundi Core US Treasury 10+Y',   cat:'Gov USD 10+Y',      ter:0.07, dur:12.0, acc:true,  ytm:4.5  },
  { isin:'LU0378818131', ticker:'XGSH',   name:'Xtrackers II GL Gov EUR H',      cat:'Gov GLB EUR H',     ter:0.20, dur:7.0,  acc:true,  ytm:3.0  },
  { isin:'IE00BF553838', ticker:'EMSA',   name:'iShares JPM Advanced $ EM Bond', cat:'EM Gov USD',        ter:0.35, dur:6.0,  acc:false, ytm:6.0   },
  { isin:'LU0321462953', ticker:'XEMB',   name:'Xtrackers II EM Bond EUR',       cat:'EM Gov EUR H',      ter:0.25, dur:6.0,  acc:true,  ytm:6.0  },
  { isin:'IE00B2NPKV68', ticker:'IEMB',   name:'iShares JPM $ EM',              cat:'EM Gov USD',        ter:0.45, dur:6.0,  acc:false, ytm:6.5   },
  { isin:'LU1686830909', ticker:'EMKTB',  name:'Amundi IBX $ Liquid EM Sov',    cat:'EM Gov USD',        ter:0.20, dur:6.0,  acc:true,  ytm:6.5  },
  { isin:'IE00B5M4WH52', ticker:'SEML',   name:'iShares JPM EM Local Gov Bond',  cat:'EM Gov Local',      ter:0.50, dur:5.0,  acc:false, ytm:5.5   },
  { isin:'IE00B6TLBW47', ticker:'EMCR',   name:'iShares JPM $ EM Corp Bond',    cat:'EM Corp USD',       ter:0.50, dur:5.0,  acc:false, ytm:6.5   },
  { isin:'LU1829219127', ticker:'CRPE',   name:'Amundi Euro Corp Bond',          cat:'IG Corp EUR',       ter:0.16, dur:5.5,  acc:true,  ytm:3.8  },
  { isin:'IE00B3F81R35', ticker:'IEAC',   name:'iShares Core EU Corp Bond',      cat:'IG Corp EUR',       ter:0.20, dur:5.5,  acc:false, ytm:3.8   },
  { isin:'IE0032895942', ticker:'LQDE',   name:'iShares $ Corp Bond',            cat:'IG Corp USD',       ter:0.20, dur:7.0,  acc:false, ytm:5.5   },
  { isin:'LU1681040496', ticker:'AHYE',   name:'Amundi Euro HY Liq Bond Iboxx',  cat:'HY Corp EUR',       ter:0.35, dur:3.5,  acc:true,  ytm:5.5  },
  { isin:'LU1812090543', ticker:'HY',     name:'Amundi EUR HY Corp Bond ESG',    cat:'HY Corp EUR',       ter:0.35, dur:3.5,  acc:true,  ytm:5.3  },
  { isin:'LU1215415214', ticker:'HYBB',   name:'Amundi Iboxx EUR Liq HY BB',     cat:'HY Corp EUR',       ter:0.35, dur:3.5,  acc:true,  ytm:4.8  },
  { isin:'IE00B66F4759', ticker:'IHYG',   name:'iShares EUR HY Corp Bond',       cat:'HY Corp EUR',       ter:0.50, dur:3.5,  acc:false, ytm:5.5   },
  { isin:'IE00B4PY7Y77', ticker:'IHYU',   name:'iShares $ HY Corp',              cat:'HY Corp USD',       ter:0.50, dur:3.5,  acc:false, ytm:6.5   },
  { isin:'IE00BF8HV600', ticker:'STHE',   name:'PIMCO US SH Term HY EUR H',      cat:'HY Corp USD',       ter:0.55, dur:3.5,  acc:false, ytm:6.0   },
  { isin:'IE00B3DKXQ41', ticker:'IEAG',   name:'iShares EU Aggregate Bond',      cat:'Aggregate EUR',     ter:0.10, dur:6.5,  acc:false, ytm:3.3   },
  { isin:'IE00BFZPF322', ticker:'AT1',    divSymbol:'AT1.L',  name:'Invesco AT1 Capital Bond',        cat:'AT1 / CoCo',        ter:0.39, dur:2.5,  acc:false, ytm:7.5   },
  { isin:'IE00BFZPF439', ticker:'XAT1',  divSymbol:'XAT1.L', name:'Invesco AT1 Cap Bond ETF EUR H', cat:'AT1 / CoCo',        ter:0.39, dur:2.5,  acc:false, ytm:7.5   },
  { isin:'IE00BZ0XVF52', ticker:'CCBO',   divSymbol:'CCBO.L', name:'WisdomTree AT1 CoCo Bond',       cat:'AT1 / CoCo',        ter:0.40, dur:2.5,  acc:true,  ytm:7.5  },
  { isin:'LU1563454310', ticker:null,     name:'Lyxor Green Bond',               cat:'Green Bond',        ter:0.25, dur:6.0,  acc:true,  ytm:3.2  },
  { isin:'IE00BDT6FP91', ticker:'GCVE',   name:'SPDR Glob Conv Bond EUR H',      cat:'Convertibili',      ter:0.45, dur:3.0,  acc:false, ytm:4.0   },
  { isin:'LU0210533500', ticker:null,     name:'JPM Funds Global Convertibles',  cat:'Convertibili',      ter:null, dur:3.0,  acc:true,  ytm:4.0  },
  { isin:'IE00BZ048462', ticker:'FLTR',   name:'iShares $ Floating Rate',        cat:'Float Rate USD',    ter:0.10, dur:0.2,  acc:false, ytm:5.5   },
  { isin:'LU0321465469', ticker:'XFFE',   name:'Xtrackers II USD OVN Rate Swap', cat:'Money Market',      ter:0.15, dur:0.1,  acc:true,  ytm:3.8  },
  { isin:'IE00BYPC1H27', ticker:'CNYB',   name:'iShares China Bond USD',         cat:'Gov Cina',          ter:0.35, dur:5.0,  acc:false, ytm:2.8   },
  { isin:'LU1094612022', ticker:'CGB',    name:'Xtrackers Harvest China Govt',   cat:'Gov Cina',          ter:0.40, dur:5.0,  acc:true,  ytm:3.0  },
  { isin:'IE00BDT8V027', ticker:'PRFE',   name:'Invesco Pref Shares ETF EUR H',  cat:'Preferred',         ter:0.50, dur:3.0,  acc:true,  ytm:6.0  },
  { isin:'FR0010869578', ticker:'BUND2S', name:'Amundi Bund Daily -2X Short',    cat:'Lev/Inverse',       ter:0.20, dur:null, acc:true             },
  { isin:'IE00BKT09032', ticker:'3TYL',   name:'WisdomTree US Tsy 10Y 3X Lev',  cat:'Lev/Inverse',       ter:0.50, dur:null, acc:true             },

  // ── Nuovi ETF aggiunti — Gov EUR ─────────────────────────────────────────
  { isin:'IE00BH04GL39', ticker:'VGEB',   name:'Vanguard EUR Eurozone Gov Bond', cat:'Gov EUR Blend',     ter:0.07, dur:6.9,  acc:true,  ytm:3.3  },
  { isin:'LU0290355717', ticker:'XGLE',   name:'Xtrackers II Eurozone Gov Bond', cat:'Gov EUR Blend',     ter:0.07, dur:7.0,  acc:true,  ytm:3.2  },
  { isin:'IE00B3VTMJ91', ticker:'CSBGE3', name:'iShares Euro Gov Bond 1-3yr',   cat:'Gov EUR 1-3Y',      ter:0.15, dur:2.0,  acc:true,  ytm:2.5  },
  { isin:'IE00B1FZS681', ticker:'IBGX',   name:'iShares Euro Gov Bond 3-5yr',   cat:'Gov EUR 3-5Y',      ter:0.15, dur:3.75, acc:false, ytm:2.8   },
  { isin:'LU0925589839', ticker:'XYP1',   name:'Xtrackers EZ Gov Bond Yield Plus 1-3Y', cat:'Gov EUR 1-3Y', ter:0.15, dur:2.0, acc:true, ytm:3.0 },
  { isin:'IE000HARFTG3', ticker:'VSGE',   name:'Vanguard EUR Eurozone Gov 1-3Y', cat:'Gov EUR 1-3Y',     ter:0.07, dur:2.0,  acc:false, ytm:2.5   },
  // ── Gov ITA (BTP) ───────────────────────────────────────────────────────
  { isin:'IE00B7LW6Y90', ticker:'IITB',   name:'iShares Italy Government Bond',  cat:'Gov ITA',           ter:0.20, dur:7.0,  acc:false, ytm:3.8   },
  // ── Gov USD aggiuntivi ───────────────────────────────────────────────────
  { isin:'IE00BZ163M45', ticker:'VUTY',   name:'Vanguard USD Treasury Bond',     cat:'Gov USD 7-10Y',     ter:0.05, dur:6.0,  acc:false, ytm:4.3   },
  { isin:'IE00BMX0B631', ticker:'VDTE',   name:'Vanguard USD Treasury EUR Hdg',  cat:'Gov USD EUR H',     ter:0.08, dur:5.7,  acc:true,  ytm:4.1  },
  { isin:'LU1407887329', ticker:'U13H',   name:'Amundi US Treasury 1-3Y EUR Hdg', cat:'Gov USD 1-3Y EUR H', ter:0.10, dur:1.9, acc:false, ytm:4.0  },
  // ── Aggregate / ESG ─────────────────────────────────────────────────────
  { isin:'IE00B41RYL63', ticker:'EUAG',   name:'SPDR Bloomberg Euro Aggregate Bond', cat:'Aggregate EUR', ter:0.17, dur:6.5,  acc:false, ytm:3.3   },
  { isin:'IE00BG47KH54', ticker:'VAGF',   name:'Vanguard Global Aggregate EUR Hdg', cat:'Aggregate GLB EUR H', ter:0.08, dur:7.0, acc:true, ytm:4.0 },
  { isin:'LU2182388236', ticker:'EGRI',   name:'Amundi Index Euro Aggregate SRI', cat:'Aggregate EUR',    ter:0.16, dur:7.0,  acc:true,  ytm:3.1  },
  // ── Corporate EUR aggiuntivi ─────────────────────────────────────────────
  { isin:'IE00BZ163G84', ticker:'VECP',   name:'Vanguard EUR Corporate Bond',    cat:'IG Corp EUR',       ter:0.07, dur:4.5,  acc:false, ytm:3.8   },
  { isin:'LU0478205379', ticker:'XBLC',   name:'Xtrackers II EUR Corporate Bond', cat:'IG Corp EUR',      ter:0.09, dur:5.5,  acc:true,  ytm:3.6  },
  { isin:'IE00BYZTVT56', ticker:'SUOE',   name:'iShares EUR Corp Bond ESG SRI',  cat:'IG Corp EUR',       ter:0.14, dur:4.42, acc:false, ytm:3.8   },
  { isin:'LU2178481649', ticker:'XZE5',   name:'Xtrackers EUR Corp Bond Short Dur ESG', cat:'IG Corp EUR', ter:0.16, dur:2.5,  acc:true,  ytm:3.3 },
  // ── Corporate USD EUR Hedged ─────────────────────────────────────────────
  { isin:'IE00BGYWFL94', ticker:'VDCE',   name:'Vanguard USD Corporate Bond EUR Hdg', cat:'IG Corp USD EUR H', ter:0.10, dur:6.3, acc:true, ytm:5.2 },
  { isin:'IE00BZ036J45', ticker:'XDGE',   name:'Xtrackers USD Corporate Bond EUR Hdg', cat:'IG Corp USD EUR H', ter:0.21, dur:7.0, acc:false, ytm:5.5 },
  // ── Ultrashort / Money Market ────────────────────────────────────────────
  { isin:'IE00BCRY6557', ticker:'ERNE',   name:'iShares EUR Ultrashort Bond',    cat:'Ultrashort EUR',    ter:0.09, dur:0.3,  acc:false, ytm:3.5   },
  { isin:'LU1681041031', ticker:'HFRN',   name:'Amundi USD FRN Corp ESG EUR Hdg', cat:'Float Rate USD',   ter:0.20, dur:0.25, acc:true,  ytm:5.0  },
  // ── HY short duration ────────────────────────────────────────────────────
  { isin:'LU1617164998', ticker:'HYS',    name:'Amundi EUR Short Term HY Corp ESG', cat:'HY Corp EUR',    ter:0.30, dur:1.5,  acc:false, ytm:5.0   },
  // ── Green Bond aggiuntivi ────────────────────────────────────────────────
  { isin:'IE00BMDBMN04', ticker:'GRON',   name:'iShares EUR Green Bond',         cat:'Green Bond',        ter:0.20, dur:6.0,  acc:false, ytm:3.2   },
];

// Prezzi ETF caricati in background — risposta sempre immediata
const etfPriceData = {}; // { isin: { price, changePercent, ... } }
let etfCacheTime = 0;
let etfPriceLoading = false;
let etfYieldLoading = false;
const ETF_CACHE_TTL = 60 * 60 * 1000;

async function fetchETFQuoteViaChart(etf) {
  const candidates = [
    etf.ticker ? etf.ticker + '.MI' : null,
    etf.isin   + '.MI',
    etf.isin   + '.F',
  ].filter(Boolean);

  const period1 = new Date(Date.now() - 370 * 24 * 3600 * 1000); // ~1 anno

  for (const sym of candidates) {
    try {
      const result = await yahooFinance.chart(sym, { period1, interval: '1d' }, { validateResult: false });
      const quotes = (result.quotes || []).filter(q => q.close != null);
      if (quotes.length < 2) continue;

      const last    = quotes[quotes.length - 1];
      const prev    = quotes[quotes.length - 2];
      const change1d      = last.close - prev.close;
      const changePercent = (change1d / prev.close) * 100;

      const yearStart = new Date().getFullYear();
      const jan1q = quotes.find(q => new Date(q.date).getFullYear() === yearStart);
      const ytdReturn = jan1q ? (last.close - jan1q.close) / jan1q.close : null;

      const prices = quotes.map(q => q.close);
      const low52w  = Math.min(...prices);
      const high52w = Math.max(...prices);

      console.log(`  [ETF] ${sym}: ${last.close.toFixed(2)} ${result.meta?.currency || 'EUR'}`);
      return {
        ...etf,
        price:         last.close,
        currency:      result.meta?.currency || 'EUR',
        changePercent,
        change1d,
        ytdReturn,
        low52w,
        high52w,
        symbol:        sym,
      };
    } catch (e) {
      // prova simbolo successivo
    }
  }

  // Ultimo tentativo: ricerca per ISIN
  try {
    const search = await yahooFinance.search(etf.isin, { quotesCount: 3, newsCount: 0 }, { validateResult: false });
    for (const q of (search.quotes || [])) {
      if (!q.symbol) continue;
      try {
        const result = await yahooFinance.chart(q.symbol, { period1, interval: '1d' }, { validateResult: false });
        const quotes = (result.quotes || []).filter(r => r.close != null);
        if (quotes.length < 2) continue;
        const last = quotes[quotes.length - 1];
        const prev = quotes[quotes.length - 2];
        console.log(`  [ETF search] ${q.symbol}: ${last.close.toFixed(2)}`);
        return {
          ...etf,
          price:         last.close,
          currency:      result.meta?.currency || 'EUR',
          changePercent: (last.close - prev.close) / prev.close * 100,
          change1d:      last.close - prev.close,
          ytdReturn:     null,
          low52w:        Math.min(...quotes.map(r => r.close)),
          high52w:       Math.max(...quotes.map(r => r.close)),
          symbol:        q.symbol,
        };
      } catch (e) {}
    }
  } catch (e) {}

  return { ...etf, price: null };
}

// ── Stooq.com fallback ──────────────────────────────────────────────────────
// Passo 1: prezzo corrente via quick-quote CSV  (simbolo,data,ora,open,high,low,close,volume)
// Passo 2 (opzionale): storico ~13 mesi per 52w range + YTD
async function fetchPriceFromStooq(etf) {
  const trySymbols = [
    etf.ticker ? `${etf.ticker.toLowerCase()}.mi` : null, // Borsa Italiana
    etf.ticker ? `${etf.ticker.toLowerCase()}.de` : null, // XETRA
    etf.ticker ? `${etf.ticker.toLowerCase()}.l`  : null, // London LSE
    etf.ticker ? `${etf.ticker.toLowerCase()}.f`  : null, // Frankfurt
    `${etf.isin.toLowerCase()}.mi`,
  ].filter(Boolean);

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  for (const sym of trySymbols) {
    try {
      // ---- PASSO 1: prezzo corrente ----
      // Formato risposta: Symbol,Date,Time,Open,High,Low,Close,Volume
      const qUrl = `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`;
      const qResp = await axios.get(qUrl, { timeout: 10000, headers: { 'User-Agent': UA } });
      const qLines = qResp.data.trim().split('\n');
      if (qLines.length < 2) continue;
      const qCols = qLines[1].split(','); // dati nel secondo rigo
      const price = parseFloat(qCols[6]);  // Close
      const open  = parseFloat(qCols[3]);  // Open
      if (isNaN(price) || price <= 0) continue; // N/D o simbolo inesistente

      // Calcola variazione giornaliera dall'open intraday (Stooq non dà prev close senza API key)
      const change1d = (!isNaN(open) && open > 0) ? price - open : null;
      const changePercent = (change1d != null && open > 0) ? (change1d / open) * 100 : null;
      // 52w e YTD non disponibili via Stooq senza API key — restano null
      const ytdReturn = null, low52w = null, high52w = null;

      console.log(`  [Stooq] ${sym}: ${price.toFixed(2)} ${change1d != null ? (change1d >= 0 ? '+' : '') + change1d.toFixed(2) : ''}`);
      return {
        ...etf,
        price,
        currency:      'EUR',
        changePercent,
        change1d,
        ytdReturn,
        low52w,
        high52w,
        symbol:        sym.toUpperCase(),
        source:        'Stooq',
      };
    } catch (e) {
      console.log(`  [Stooq ERR] ${sym}: ${e.message}`);
    }
  }
  return { ...etf, price: null };
}

// Aggiorna prezzi ETF in background senza bloccare l'HTTP response
// Tenta Yahoo Finance prima (dati più ricchi), poi Stooq come fallback
async function refreshETFPricesBackground() {
  if (etfPriceLoading) return; // già in corso
  etfPriceLoading = true;
  console.log('[ETF] Avvio aggiornamento prezzi in background...');
  let successCount = 0;
  try {
    const CHUNK = 5;
    for (let i = 0; i < ETF_LIST.length; i += CHUNK) {
      const chunk = ETF_LIST.slice(i, i + CHUNK);
      const settled = await Promise.allSettled(chunk.map(async (etf) => {
        // 1) Yahoo Finance via chart()
        const yahoo = await fetchETFQuoteViaChart(etf);
        if (yahoo.price != null) return yahoo;
        // 2) Stooq.com come fallback
        return fetchPriceFromStooq(etf);
      }));
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value?.isin) {
          const { isin, price, currency, changePercent, change1d, ytdReturn, low52w, high52w, symbol, source } = r.value;
          // Preserva yieldHistory e yld già presenti (da JustETF/Yahoo passes precedenti)
          const prev = etfPriceData[isin] || {};
          etfPriceData[isin] = {
            price, currency, changePercent, change1d, ytdReturn, low52w, high52w, symbol, source,
            ...(prev.yld          != null ? { yld: prev.yld }                   : {}),
            ...(prev.yieldHistory != null ? { yieldHistory: prev.yieldHistory } : {}),
          };
          if (price != null) successCount++;
        }
      }
      if (i + CHUNK < ETF_LIST.length) await new Promise(r => setTimeout(r, 800));
    }
    // Aggiorna il timestamp SOLO se almeno qualche prezzo è stato trovato
    if (successCount > 0) {
      etfCacheTime = Date.now();
      // Avvia fetch rendimenti in background solo dopo che i prezzi sono pronti
      setTimeout(refreshETFYieldsBackground, 3000);
    }
    console.log(`[ETF] Aggiornamento prezzi: ${successCount}/${ETF_LIST.length} ETF con prezzo`);
  } catch (err) {
    console.error('[ETF] Errore aggiornamento background:', err.message);
  } finally {
    etfPriceLoading = false;
  }
}

// Secondo passaggio: fetcha distribution yield via quoteSummary per ogni ETF
// con simbolo noto. Chunk piccoli + delay maggiori per non stressare Yahoo Finance.
async function refreshETFYieldsBackground() {
  if (etfYieldLoading) return;
  const etfsWithSym = ETF_LIST.filter(e => etfPriceData[e.isin]?.symbol);
  if (!etfsWithSym.length) return;

  etfYieldLoading = true;
  console.log(`[ETF Yields] Avvio fetch rendimenti per ${etfsWithSym.length} ETF...`);
  let found = 0;

  try {
    const CHUNK = 3;
    for (let i = 0; i < etfsWithSym.length; i += CHUNK) {
      const chunk = etfsWithSym.slice(i, i + CHUNK);
      await Promise.allSettled(chunk.map(async (etf) => {
        const sym = etfPriceData[etf.isin]?.symbol;
        if (!sym) return;
        try {
          const qs = await yahooFinance.quoteSummary(sym, { modules: ['price', 'summaryDetail'] }, { validateResult: false });
          const yld = qs?.price?.trailingAnnualDividendYield ?? qs?.summaryDetail?.yield;
          if (yld != null && yld > 0) {
            etfPriceData[etf.isin].yld = +(yld * 100).toFixed(2);
            found++;
            console.log(`  [Yield] ${sym}: ${etfPriceData[etf.isin].yld}%`);
          }
        } catch (_) {}
      }));
      if (i + CHUNK < etfsWithSym.length) await new Promise(r => setTimeout(r, 1200));
    }
    console.log(`[ETF Yields] Yahoo: ${found}/${etfsWithSym.length} rendimenti trovati`);
  } catch (err) {
    console.error('[ETF Yields] Errore Yahoo:', err.message);
  } finally {
    etfYieldLoading = false;
  }
  // Terzo passaggio: JustETF scraping per i rendimenti mancanti (e storico per tutti)
  setTimeout(refreshETFJustETFYields, 5000);
}

// ── JustETF scraping ──────────────────────────────────────────────────────────
// Cache: { isin → { ts, currentYield, history: [{year, yieldPct}] } }
const justETFCache = {};
const JUST_ETF_TTL = 20 * 60 * 60 * 1000; // 20 ore

async function fetchJustETFDistributions(isin) {
  const cached = justETFCache[isin];
  if (cached && Date.now() - cached.ts < JUST_ETF_TTL) return cached;

  const url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.justetf.com/',
      },
      timeout: 20000,
    });

    const $ = cheerio.load(resp.data);
    const history = [];
    let currentYield = null;

    // Cerca tutte le righe di tabella con 3 celle: (anno, importo EUR, yield%)
    $('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const c0 = $(cells[0]).text().trim();

      // Salta righe di volatilità, drawdown, performance, etc.
      // (es. "Volatility 1 year (in EUR)" che JustETF usa nella sezione risk)
      if (/volatil|drawdown|performance|return|sharpe|max\s*loss/i.test(c0)) return;

      // Ultima cella con percentuale positiva senza segno (es. "3.45%")
      // Esclude percentuali con segno +/- (performance di prezzo)
      let yieldPct = null;
      for (let ci = cells.length - 1; ci >= 1; ci--) {
        const raw = $(cells[ci]).text().trim().replace(',', '.');
        const m = raw.match(/^(\d+\.?\d*)\s*%$/); // solo numeri positivi senza segno
        if (m) { yieldPct = parseFloat(m[1]); break; }
      }
      if (yieldPct == null || isNaN(yieldPct) || yieldPct <= 0 || yieldPct > 30) return;

      // Anno esatto (es. "2022") → storico
      const yearM = c0.match(/^(20\d{2})$/);
      // TTM: la prima cella deve essere ESATTAMENTE "1 year" o "1 Year" (non "Volatility 1 year")
      const ttmM  = /^\s*1\s*year\s*$/i.test(c0);

      if (yearM) {
        history.push({ year: parseInt(yearM[1]), yieldPct });
      } else if (ttmM && !currentYield) {
        currentYield = yieldPct;
      }
    });

    // Ordina storia cronologicamente
    history.sort((a, b) => a.year - b.year);

    // Fallback current yield: ultima dell'anno corrente o più recente
    if (!currentYield && history.length > 0) {
      currentYield = history[history.length - 1].yieldPct;
    }

    // Se ancora nulla, cerca nel body pattern "X.XX%" vicino a "dividend yield"
    if (!currentYield) {
      const html = resp.data;
      const m = html.match(/dividend[^<]{0,60}?(\d+[.,]\d+)\s*%/i)
             || html.match(/(\d+[.,]\d+)\s*%[^<]{0,60}?dividend/i);
      if (m) currentYield = parseFloat(m[1].replace(',', '.'));
    }

    const result = { ts: Date.now(), currentYield, history };
    justETFCache[isin] = result;
    return result;
  } catch (e) {
    console.log(`  [JustETF] ${isin}: ${e.message}`);
    return null;
  }
}

// Terzo passaggio: scraping JustETF per tutti gli ETF
// (sia per i rendimenti mancanti in tabella, sia per lo storico nel pannello)
let etfJustETFLoading = false;
async function refreshETFJustETFYields() {
  if (etfJustETFLoading) return;
  etfJustETFLoading = true;
  console.log('[JustETF] Avvio scraping rendimenti da JustETF...');
  let updated = 0;

  try {
    // Priorità: ETF senza yield Yahoo (tabella) + tutti per lo storico
    const CHUNK = 2;
    for (let i = 0; i < ETF_LIST.length; i += CHUNK) {
      const chunk = ETF_LIST.slice(i, i + CHUNK);
      await Promise.allSettled(chunk.map(async (etf) => {
        try {
          const data = await fetchJustETFDistributions(etf.isin);
          if (!data) return;
          if (!etfPriceData[etf.isin]) etfPriceData[etf.isin] = {};
          // Salva sempre lo storico rendimenti (per il grafico nel pannello ETF)
          if (data.history?.length) {
            etfPriceData[etf.isin].yieldHistory = data.history;
          }
          // Aggiorna resa in tabella se non già presente da Yahoo
          if (data.currentYield != null && !etfPriceData[etf.isin].yld) {
            etfPriceData[etf.isin].yld = +data.currentYield.toFixed(2);
            updated++;
            console.log(`  [JustETF] ${etf.isin}: ${data.currentYield.toFixed(2)}% (${data.history?.length ?? 0} anni storia)`);
          }
        } catch (e) {}
      }));
      if (i + CHUNK < ETF_LIST.length) await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`[JustETF] Completato: ${updated} nuovi rendimenti aggiunti`);
  } catch (err) {
    console.error('[JustETF] Errore:', err.message);
  } finally {
    etfJustETFLoading = false;
  }
}

// Risponde IMMEDIATAMENTE con la lista statica + prezzi già cachati,
// poi triggerà il refresh in background se il cache è scaduto
app.get('/api/etf', (req, res) => {
  const list = ETF_LIST.map(etf => ({ ...etf, ...(etfPriceData[etf.isin] || {}) }));
  const stale = Date.now() - etfCacheTime > ETF_CACHE_TTL;
  if (stale && !etfPriceLoading) {
    refreshETFPricesBackground(); // fire-and-forget
  }
  res.json({ etfs: list, loading: etfPriceLoading, yieldsLoading: etfYieldLoading, cacheTime: etfCacheTime || null });
});

// Debug: testa Yahoo + Stooq per il primo ETF e restituisce i risultati grezzi
app.get('/api/etf/debug', async (req, res) => {
  const etf = ETF_LIST[0]; // IEAG — iShares EU Aggregate Bond
  const out  = { etf, state: { etfPriceLoading, etfCacheTime, pricesFound: Object.values(etfPriceData).filter(v => v?.price != null).length }, tests: {} };

  // TEST 1: Yahoo Finance chart()
  try {
    const period1 = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    const r = await yahooFinance.chart('IEAG.MI', { period1, interval: '1d' }, { validateResult: false });
    out.tests.yahooChart = { ok: true, quotes: r.quotes?.length, currency: r.meta?.currency, lastClose: r.quotes?.at(-1)?.close };
  } catch (e) { out.tests.yahooChart = { ok: false, error: e.message }; }

  // TEST 2: Stooq quick-quote
  try {
    const r = await axios.get('https://stooq.com/q/l/?s=ieag.mi&f=sd2t2ohlcv&h&e=csv', {
      timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    out.tests.stooqQuote = { ok: true, status: r.status, raw: r.data.substring(0, 400) };
  } catch (e) { out.tests.stooqQuote = { ok: false, error: e.message }; }

  // TEST 3: Stooq storico
  try {
    const d2 = new Date(); const d1 = new Date(d2 - 30 * 24 * 3600 * 1000);
    const fmt = d => d.toISOString().split('T')[0].replace(/-/g,'');
    const r = await axios.get(`https://stooq.com/q/d/l/?s=ieag.mi&d1=${fmt(d1)}&d2=${fmt(d2)}&i=d`, {
      timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    out.tests.stooqHistory = { ok: true, status: r.status, lines: r.data.trim().split('\n').length, raw: r.data.substring(0, 400) };
  } catch (e) { out.tests.stooqHistory = { ok: false, error: e.message }; }

  // TEST 4: fetchPriceFromStooq completo
  try {
    const result = await fetchPriceFromStooq(etf);
    out.tests.fetchPriceFromStooq = result;
  } catch (e) { out.tests.fetchPriceFromStooq = { error: e.message }; }

  res.json(out);
});

// Debug dividendi: testa il recupero dividendi Yahoo per un ETF specifico
app.get('/api/etf/debug-yield/:isin', async (req, res) => {
  const isin = req.params.isin.toUpperCase();
  const etfEntry = ETF_LIST.find(e => e.isin === isin);
  const period1 = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000); // 2 anni
  const out = { isin, etfEntry, results: [] };

  // Candidati: ISIN con suffissi standard + ticker con suffissi alternativi
  const prefix = isin.substring(0, 2).toUpperCase();
  const mainSuffixes = YAHOO_SUFFIXES[prefix] || ['.MI', '.F'];
  const tickerHint = etfEntry?.ticker;
  const divSymbol = etfEntry?.divSymbol;

  const candidates = [
    ...mainSuffixes.map(s => isin + s),
    ...(divSymbol ? [divSymbol] : []),
    ...(tickerHint ? DIV_FALLBACK_SUFFIXES.map(s => tickerHint + s) : []),
  ];

  for (const sym of candidates) {
    try {
      const r = await yahooFinance.chart(sym, { period1, interval: '1mo', events: 'div' }, { validateResult: false });
      const quotes = (r.quotes || []).filter(q => q.close != null);
      const divRaw = r.events?.dividends || {};
      const divs = Array.isArray(divRaw) ? divRaw : Object.values(divRaw);
      out.results.push({
        symbol: sym, quotes: quotes.length, dividends: divs.length,
        currency: r.meta?.currency,
        firstDiv: divs[0] ? { date: divs[0].date, amount: divs[0].amount } : null,
        lastDiv:  divs.at(-1) ? { date: divs.at(-1).date, amount: divs.at(-1).amount } : null,
      });
    } catch (e) {
      out.results.push({ symbol: sym, error: e.message });
    }
  }

  // JustETF
  try {
    const je = await fetchJustETFDistributions(isin);
    out.justETF = je ? { currentYield: je.currentYield, historyLen: je.history?.length, history: je.history } : null;
  } catch (e) { out.justETF = { error: e.message }; }

  res.json(out);
});

// Dettaglio singolo ETF: quoteSummary con tutti i moduli disponibili
app.get('/api/etf/:isin', async (req, res) => {
  const isin = req.params.isin.toUpperCase();
  const etf  = ETF_LIST.find(e => e.isin === isin);
  if (!etf) return res.status(404).json({ error: 'ETF non trovato' });

  const cached = etfPriceData[isin] || {};
  const sym    = cached.symbol;
  const detail = { ...etf, ...cached };

  if (sym) {
    try {
      const qs = await yahooFinance.quoteSummary(sym, {
        modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'topHoldings', 'assetProfile', 'fundProfile'],
      }, { validateResult: false });

      const pr  = qs?.price;
      const sd  = qs?.summaryDetail;
      const dks = qs?.defaultKeyStatistics;
      const th  = qs?.topHoldings;
      const ap  = qs?.assetProfile;
      const fp  = qs?.fundProfile;

      // Yield: price.trailingAnnualDividendYield è il più affidabile per ETF
      const yld = pr?.trailingAnnualDividendYield ?? sd?.yield ?? dks?.trailingAnnualDividendYield;
      if (yld != null && yld > 0) detail.distYield = +(yld * 100).toFixed(2);

      // AUM e dati di mercato
      if (sd?.totalAssets != null) detail.totalAssets = sd.totalAssets;
      if (sd?.beta        != null) detail.beta        = +sd.beta.toFixed(2);
      if (pr?.volume      != null) detail.volume      = pr.volume;
      if (pr?.regularMarketVolume != null && detail.volume == null) detail.volume = pr.regularMarketVolume;

      // Inception date
      const inceptRaw = dks?.fundInceptionDate ?? fp?.inceptionDate;
      if (inceptRaw != null) detail.fundInceptionDate = inceptRaw;

      // Fund family / provider
      const family = fp?.fundFamily ?? dks?.fundFamily ?? pr?.quoteType;
      if (family && typeof family === 'string') detail.fundFamily = family;

      // Description
      if (ap?.longBusinessSummary) detail.description = ap.longBusinessSummary;
      if (fp?.categoryName) detail.categoryName = fp.categoryName;

      // Holdings (top 10)
      if (th?.holdings?.length) detail.holdings = th.holdings.slice(0, 10);

      // Bond-specific: effective duration, average maturity
      const bh = th?.bondHolding;
      if (bh) {
        if (bh.duration != null) detail.effectiveDuration = +bh.duration.toFixed(2);
        if (bh.maturity != null) detail.avgMaturity       = +bh.maturity.toFixed(2);
        if (bh.creditQuality != null) detail.creditQuality = bh.creditQuality;
      }

      // Bond Ratings — Yahoo v3 restituisce [{aaa:0.30}, {aa:0.11}, ...]
      // Normalizziamo in [{label:'AAA', value:0.30}, ...]
      if (th?.bondRatings?.length) {
        const RATING_MAP = {
          'aaa':'AAA','aa':'AA','a':'A','bbb':'BBB','bb':'BB','b':'B',
          'below_b':'Below B','us_government':'US Gov','other':'Altro',
        };
        detail.bondRatings = th.bondRatings
          .map(r => {
            const key = Object.keys(r)[0];
            const val = r[key];
            return { label: RATING_MAP[key] || key.toUpperCase(), value: val };
          })
          .filter(r => r.value > 0.001);
      }

    } catch (e) {
      console.log(`[ETF detail] quoteSummary ${sym}: ${e.message}`);
    }
  }

  // JustETF: storico rendimenti (per grafico) + yield fallback per tabella
  try {
    const je = await fetchJustETFDistributions(isin);
    if (je) {
      if (je.history?.length) detail.yieldHistory = je.history;
      // Usa JustETF come fallback se Yahoo non ha restituito lo yield
      if (!detail.distYield && je.currentYield) {
        detail.distYield = +je.currentYield.toFixed(2);
        detail.yieldSource = 'JustETF';
      }
    }
  } catch (e) {}

  res.json(detail);
});

// ─── MACRO ────────────────────────────────────────────────────────────────────

let macroCache = null, macroCacheTime = 0;
const MACRO_CACHE_TTL = 30 * 60 * 1000;

async function fetchECBSeries(seriesKey) {
  try {
    const url = `https://data-api.ecb.europa.eu/service/data/${seriesKey}?lastNObservations=2&format=jsondata`;
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

// Ricava yield ~10Y da bond già scrappati (BTP, Bund, ecc.)
function getBondYield10Y(paese, targetYears = 10) {
  const today = new Date();
  const bonds = state.bonds.filter(b => b.paese === paese && b.yield !== null && b.scadenza);
  if (!bonds.length) return null;
  const withYears = bonds
    .map(b => ({ ...b, years: (new Date(b.scadenza) - today) / (365.25 * 24 * 3600 * 1000) }))
    .filter(b => b.years > 0.5)
    .sort((a, b) => Math.abs(a.years - targetYears) - Math.abs(b.years - targetYears));
  if (!withYears.length) return null;
  const best = withYears[0];
  return {
    value: best.yield,
    date:  state.lastUpdate ? state.lastUpdate.split('T')[0] : null,
    note:  `${best.descrizione} (${best.years.toFixed(1)}Y)`,
  };
}

app.get('/api/macro', async (req, res) => {
  if (macroCache && Date.now() - macroCacheTime < MACRO_CACHE_TTL) return res.json(macroCache);
  try {
    // ECB API (gratuita) + Yahoo Finance chart() per US yields
    const [ecbRate, hicp, us10y, us3m, us30y] = await Promise.all([
      fetchECBSeries('FM/B.U2.EUR.4F.KR.DFR.LEV'),
      fetchECBSeries('ICP/M.U2.N.000000.4.ANR'),
      fetchYahooIndicator('^TNX'),
      fetchYahooIndicator('^IRX'),
      fetchYahooIndicator('^TYX'),
    ]);

    // BTP e Bund 10Y ricavati dai bond già scrappati (sempre disponibili)
    const ita10y = getBondYield10Y('Italia');
    const ger10y = getBondYield10Y('Germania');

    const spreadBtpBund = (ita10y?.value != null && ger10y?.value != null)
      ? { value: +((ita10y.value - ger10y.value) * 100).toFixed(0), date: ita10y.date }
      : null;

    const data = { ecbRate, hicp, us10y, us3m, us30y, ger10y, ita10y, spreadBtpBund, lastUpdate: new Date().toISOString() };
    macroCache = data;
    macroCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error('[MACRO] Errore:', err.message);
    if (macroCache) return res.json(macroCache);
    res.status(500).json({ error: 'Errore dati macro', detail: err.message });
  }
});

// Caricamento iniziale
refreshData();

// Prezzi ETF in background (parte subito, non blocca il server)
setTimeout(refreshETFPricesBackground, 3000);

// Auto-refresh ogni 10 minuti
setInterval(refreshData, REFRESH_INTERVAL);

// Auto-refresh ETF ogni ora
setInterval(refreshETFPricesBackground, ETF_CACHE_TTL);

app.listen(PORT, () => {
  console.log(`\n✅ Bond Monitor avviato su http://localhost:${PORT}`);
  console.log(`   Aggiornamento automatico ogni ${REFRESH_INTERVAL / 60000} minuti\n`);
});
