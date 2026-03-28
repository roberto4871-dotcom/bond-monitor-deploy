const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;

const app = express();
const PORT = process.env.PORT || 3001;

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
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

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
  DE: ['.F', '.BE', '.MI'],
  FR: ['.PA', '.F', '.MI'],
  ES: ['.MC', '.MI'],
  PT: ['.LS', '.MI'],
  GR: ['.AT', '.MI'],
  AT: ['.VI', '.F', '.MI'],
  NL: ['.AS', '.F', '.MI'],
  BE: ['.BR', '.F', '.MI'],
  FI: ['.HE', '.MI'],
  IE: ['.MI', '.F'],
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

// Tenta Yahoo Finance con diversi suffissi di borsa
async function tryYahooFinance(isin) {
  const prefix = isin.substring(0, 2).toUpperCase();
  const suffixes = YAHOO_SUFFIXES[prefix] || ['.MI', '.F'];
  const period1 = new Date(Date.now() - 6 * 365 * 24 * 3600 * 1000); // 6 anni

  for (const suffix of suffixes) {
    const symbol = isin + suffix;
    try {
      const result = await yahooFinance.chart(symbol, { period1, interval: '1d' }, { validateResult: false });
      const quotes = (result.quotes || []).filter(q => q.close != null);
      if (quotes.length >= 20) {
        const currency = result.meta?.currency || 'EUR';
        console.log(`  [CHART] Yahoo OK: ${symbol} — ${quotes.length} punti`);
        return {
          source: 'Yahoo Finance',
          symbol,
          currency,
          price: quotes.map(q => [new Date(q.date).getTime(), q.close]),
          yieldData: [],   // Yahoo non ha yield per bonds
          zspreadData: [], // Yahoo non ha z-spread
        };
      }
    } catch (e) {
      // prova prossimo suffisso
    }
  }

  // Ultimo tentativo: ricerca per ISIN
  try {
    const search = await yahooFinance.search(isin, { quotesCount: 3, newsCount: 0 }, { validateResult: false });
    for (const q of (search.quotes || [])) {
      try {
        const result = await yahooFinance.chart(q.symbol, { period1, interval: '1d' }, { validateResult: false });
        const quotes = (result.quotes || []).filter(r => r.close != null);
        if (quotes.length >= 20) {
          console.log(`  [CHART] Yahoo Search OK: ${q.symbol} — ${quotes.length} punti`);
          return {
            source: 'Yahoo Finance',
            symbol: q.symbol,
            currency: result.meta?.currency || 'EUR',
            price: quotes.map(r => [new Date(r.date).getTime(), r.close]),
            yieldData: [],
            zspreadData: [],
          };
        }
      } catch (e) {}
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

  const bond = state.bonds.find(b => b.isin === isin);

  try {
    console.log(`[CHART] Recupero dati per ${isin}...`);

    // Tenta entrambe le fonti in parallelo
    const [yahoo, site] = await Promise.allSettled([
      tryYahooFinance(isin),
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

// Caricamento iniziale
refreshData();

// Auto-refresh ogni 10 minuti
setInterval(refreshData, REFRESH_INTERVAL);

app.listen(PORT, () => {
  console.log(`\n✅ Bond Monitor avviato su http://localhost:${PORT}`);
  console.log(`   Aggiornamento automatico ogni ${REFRESH_INTERVAL / 60000} minuti\n`);
});
