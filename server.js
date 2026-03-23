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
  { id: 82, name: 'Titoli ad alto rating' },
  { id: 5,  name: 'BTP - Italia' },
  { id: 72, name: 'BOT' },
  { id: 66, name: 'Titoli di stato europei' },
  { id: 43, name: 'Altri titoli di stato' },
  { id: 10, name: 'Germania' },
  { id: 13, name: 'Francia' },
  { id: 78, name: 'Romania' },
  { id: 58, name: 'Stati Uniti' },
];

const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minuti

// Mappa prefisso ISIN → paese
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
  'XS': 'Sovranazionale',
  'EU': 'Unione Europea',
  'XF': 'Sovranazionale',
  'XC': 'Sovranazionale',
  'XB': 'Sovranazionale',
};

function getCountry(isin) {
  if (!isin || isin.length < 2) return 'Altro';
  const prefix = isin.substring(0, 2).toUpperCase();
  return COUNTRY_MAP[prefix] || 'Altro';
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
        paese: getCountry(isin),
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

// Cache grafici: { [isin_range]: { data, ts } }
const chartCache = {};
const CHART_CACHE_TTL = 30 * 60 * 1000; // 30 minuti

async function fetchSiteChart(bondid, marketcode) {
  const url = `https://www.simpletoolsforinvestors.eu/historicalgraph.php?bondid=${bondid}&marketcode=${marketcode}`;
  const resp = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'it-IT,it;q=0.9',
      'Referer': 'https://www.simpletoolsforinvestors.eu/',
    },
    timeout: 20000,
  });

  const html = resp.data;

  // Cerca il JSON dei dati nel sorgente della pagina
  // Il sito embeds i dati come oggetto JS con campo "data": [[ts, prezzo, yield, zspread], ...]
  const match = html.match(/\{[^{}]*"isincode"\s*:\s*"[^"]+[^{}]*"data"\s*:\s*(\[\[[\s\S]*?\]\])/);
  if (!match) {
    // Prova pattern alternativo
    const match2 = html.match(/"data"\s*:\s*(\[\[[\s\S]*?\]\])/);
    if (!match2) return null;
    const rawData = JSON.parse(match2[1]);
    return rawData;
  }
  return JSON.parse(match[1]);
}

function calcPeriod1(range) {
  const d = new Date();
  switch (range) {
    case 'ytd': return Math.floor(new Date(d.getFullYear(), 0, 1) / 1000);
    case '1y': d.setFullYear(d.getFullYear() - 1); return Math.floor(d / 1000);
    case '2y': d.setFullYear(d.getFullYear() - 2); return Math.floor(d / 1000);
    case '3y': d.setFullYear(d.getFullYear() - 3); return Math.floor(d / 1000);
    case '5y': d.setFullYear(d.getFullYear() - 5); return Math.floor(d / 1000);
    default: return 0; // max (dal 1970)
  }
}

// API: dati storici grafico
app.get('/api/chart/:isin', async (req, res) => {
  const isin = req.params.isin.toUpperCase();
  const range = ['ytd','1y','2y','3y','5y','max'].includes(req.query.range) ? req.query.range : 'max';
  const cacheKey = `${isin}_site`;

  // Controlla cache (i dati del sito coprono tutto lo storico disponibile, indipendente dal range)
  const cached = chartCache[cacheKey];
  if (cached && Date.now() - cached.ts < CHART_CACHE_TTL) {
    return res.json(filterByRange(cached.data, range));
  }

  // Trova il bondid nei dati in memoria
  const bond = state.bonds.find(b => b.isin === isin);
  if (!bond || !bond.bondid) {
    return res.status(404).json({ error: 'Titolo non trovato o bondid mancante. Riprova dopo il prossimo aggiornamento.', isin });
  }

  try {
    const rawData = await fetchSiteChart(bond.bondid, bond.marketcode || 'MOT');
    if (!rawData || rawData.length === 0) {
      return res.status(404).json({ error: 'Nessun dato storico disponibile sul sito sorgente', isin });
    }

    // rawData = [[ts_ms, prezzo, yield, zspread], ...]
    const data = {
      isin,
      currency: bond.divisa || 'EUR',
      // pairs per prezzo: [ts, prezzo]
      price: rawData.map(([ts, p]) => [ts, p]).filter(([, p]) => p != null),
      // pairs per yield: [ts, yield]
      yieldData: rawData.map(([ts,, y]) => [ts, y]).filter(([, y]) => y != null),
      // pairs per zspread: [ts,,, z]
      zspreadData: rawData.map(([ts,,, z]) => [ts, z]).filter(([, z]) => z != null),
    };

    chartCache[cacheKey] = { data, ts: Date.now() };
    res.json(filterByRange(data, range));
  } catch (err) {
    console.error(`[CHART] Errore per ${isin}:`, err.message);
    res.status(500).json({ error: 'Errore nel recupero dati storici', detail: err.message });
  }
});

function filterByRange(data, range) {
  const cutoff = calcPeriod1(range) * 1000;
  return {
    ...data,
    price: data.price.filter(([ts]) => ts >= cutoff),
    yieldData: data.yieldData.filter(([ts]) => ts >= cutoff),
    zspreadData: data.zspreadData.filter(([ts]) => ts >= cutoff),
  };
}

// Caricamento iniziale
refreshData();

// Auto-refresh ogni 10 minuti
setInterval(refreshData, REFRESH_INTERVAL);

app.listen(PORT, () => {
  console.log(`\n✅ Bond Monitor avviato su http://localhost:${PORT}`);
  console.log(`   Aggiornamento automatico ogni ${REFRESH_INTERVAL / 60000} minuti\n`);
});
