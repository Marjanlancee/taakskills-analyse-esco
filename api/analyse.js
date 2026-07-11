// api/analyse.js — Taakanalyse Skills ESCO
// GEOPTIMALISEERD: temperature=0, bronnen parallel, 15-25 taken

import fs from 'fs';
import path from 'path';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

let _hard = null;
let _soft = null;

function laadEsco() {
  if (_hard && _soft) return { hard: _hard, soft: _soft };
  const dir = process.cwd();
  _hard = JSON.parse(fs.readFileSync(path.join(dir, 'esco_hardskills.json'), 'utf8'));
  _soft = JSON.parse(fs.readFileSync(path.join(dir, 'esco_softskills.json'), 'utf8'));
  console.log(`ESCO geladen: ${_hard.length} hardskills, ${_soft.length} softskills`);
  return { hard: _hard, soft: _soft };
}

function selecteerRelevante(functietitel, taken, hard, soft) {
  const context = [functietitel, ...taken.map(t => t.taak)].join(' ').toLowerCase();
  const gescoord = hard.map(row => {
    const label = row[0].toLowerCase();
    const woorden = label.split(/\s+/).filter(w => w.length > 3);
    const score = woorden.filter(w => context.includes(w)).length;
    return { row, score };
  });
  gescoord.sort((a, b) => b.score - a.score);
  return { topHard: gescoord.slice(0, 300).map(g => g.row), soft };
}

// Scoort skills specifiek op de tekst van ÉÉN taak (niet de hele functie), zodat brede
// skills die toevallig vaak voorkomen niet als kandidaat opduiken bij taken waar ze niet bij passen.
function scoreSkillsVoorTaak(taakTekst, skills, top = 8) {
  const context = taakTekst.toLowerCase();
  const gescoord = skills.map(row => {
    const label = row[0].toLowerCase();
    const woorden = label.split(/\s+/).filter(w => w.length > 3);
    const score = woorden.filter(w => context.includes(w)).length;
    return { row, score };
  });
  gescoord.sort((a, b) => b.score - a.score);
  return gescoord.filter(g => g.score > 0).slice(0, top).map(g => g.row);
}

function herstelJson(json) {
  try { JSON.parse(json); return json; } catch { /**/ }
  const opens = [];
  let inStr = false, esc = false;
  for (const c of json) {
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') opens.push('}');
    else if (c === '[') opens.push(']');
    else if (c === '}' || c === ']') opens.pop();
  }
  let r = json.trimEnd().replace(/,\s*$/, '').replace(/,\s*([}\]])/g, '$1');
  for (let i = opens.length - 1; i >= 0; i--) r += opens[i];
  return r;
}

async function vraagClaude(sys, prompt, apiKey, maxTokens = 16000) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature: 0,
      system: sys,
      messages: [{ role: 'user', content: prompt }]
    }),
  });
  if (!res.ok) throw new Error(`Claude API fout: ${res.status} — ${await res.text()}`);
  const tekst = (await res.json()).content?.[0]?.text ?? '';
  let j = tekst;
  const blok = tekst.match(/```json\s*([\s\S]*?)```/);
  if (blok) j = blok[1].trim();
  else {
    const open = tekst.match(/```json\s*([\s\S]*)/);
    if (open) j = open[1].trim();
    else { const raw = tekst.match(/(\{[\s\S]*\}|\[[\s\S]*\])/); if (raw) j = raw[0]; }
  }
  j = herstelJson(j);
  try { return JSON.parse(j); }
  catch { throw new Error('Ongeldige JSON van Claude: ' + tekst.slice(0, 300)); }
}

async function haalBronTekstOp(url) {
  const status = { url, ok: false, melding: '' };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/pdf,*/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { status.melding = `Niet bereikbaar (status ${res.status})`; return { tekst: '', status }; }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
      const buffer = await res.arrayBuffer();
      const decoder = new TextDecoder('latin1');
      const raw = decoder.decode(new Uint8Array(buffer));
      const matches = raw.match(/BT[\s\S]*?ET/g) || [];
      let pdfTekst = '';
      matches.forEach(blok => {
        const tm = blok.match(/\((.*?)\)/g) || [];
        tm.forEach(t => { pdfTekst += t.slice(1, -1).replace(/\\n/g, ' ').replace(/\\/g, '') + ' '; });
      });
      if (pdfTekst.length < 100) {
        const leesbaar = raw.match(/[A-Za-z\u00C0-\u024F\s]{20,}/g) || [];
        pdfTekst = leesbaar.join(' ').replace(/\s+/g, ' ').slice(0, 4000);
      }
      if (pdfTekst.trim().length < 50) { status.melding = 'PDF tekst niet extraheerbaar'; return { tekst: '', status }; }
      status.ok = true; status.melding = `PDF geladen (${Math.round(buffer.byteLength/1024)}KB)`;
      return { tekst: `[Bron PDF: ${url}]\n${pdfTekst.slice(0, 4000)}`, status };
    }
    const html = await res.text();
    const tekst = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (tekst.length < 50) { status.melding = 'Inhoud leeg of geblokkeerd'; return { tekst: '', status }; }
    status.ok = true; status.melding = `Opgehaald (${tekst.length} tekens)`;
    return { tekst: `[Bron: ${url}]\n${tekst}`, status };
  } catch (e) {
    status.melding = e.name === 'AbortError' ? 'Timeout' : `Fout: ${e.message}`;
    return { tekst: '', status };
  }
}

async function genereerTaken(functieprofiel, bedrijf, eigenTaal, bronnen, pdfTekst, apiKey) {
  let bronTeksten = '';
  const bronnenStatus = [];
  // Bronnen parallel ophalen
  if (bronnen && bronnen.length > 0) {
    const bronResultaten = await Promise.all(bronnen.slice(0, 5).map(url => haalBronTekstOp(url.trim())));
    bronResultaten.forEach(({ tekst, status }) => {
      bronnenStatus.push(status);
      if (tekst) bronTeksten += tekst + '\n\n';
    });
  }
  if (pdfTekst && pdfTekst.trim().length > 50) {
    bronTeksten += `\n\n[Bron PDF upload]\n${pdfTekst.slice(0, 6000)}`;
    bronnenStatus.push({ url: 'PDF upload', ok: true, melding: `${pdfTekst.length} tekens` });
  }
  const bronInstructie = bronTeksten
    ? `4. bron — taken die expliciet terug te vinden zijn in de AANVULLENDE BRONNEN hieronder (URL's of PDF-upload)\n\nBELANGRIJKE REGEL VOOR DE BRON-TAG: als een taak inhoudelijk terug te vinden is in de AANVULLENDE BRONNEN hieronder, gebruik dan ALTIJD "bron":"bron" voor die taak — ook als de taak inhoudelijk ook bij het beroep (sectorkennis) of het bedrijf zou kunnen passen. De aanvullende bron heeft in dat geval voorrang boven categorie 2 (beroep) en 3 (bedrijf). Als de aanvullende bronnen concrete taakinformatie bevatten, moet minimaal één taak "bron":"bron" krijgen. Alleen als de aanvullende bronnen puur algemene bedrijfsinformatie bevatten zonder enige concrete taak, mag je categorie "bron" leeg laten.`
    : '';
  const taakResultaat = await vraagClaude(
    'Je bent expert in functie-analyse en skills-based werken. Geef ALLEEN geldige JSON terug, geen markdown.',
    `Analyseer dit functieprofiel grondig. Haal ALLE taken op:\n1. profiel — taken die LETTERLIJK of bijna letterlijk zo omschreven staan in de FUNCTIEPROFIEL-tekst hieronder\n2. beroep — taken die standaard bij dit beroep horen (sectorkennis), INCLUSIEF taken die je afleidt/redeneert vanuit een feit in het profiel maar die zelf niet letterlijk zo genoemd worden (bijv. een genoemd certificaat impliceert dat dit periodiek onderhouden moet worden — dat is een afgeleide taak en hoort onder beroep, niet onder profiel)\n3. bedrijf — taken die AANTOONBAAR voortkomen uit de expliciet ingevulde BEDRIJF-naam of de expliciet ingevulde BEDRIJFSEIGEN TERMEN hieronder\n${bronInstructie}\n\nBELANGRIJKE REGEL VOOR DE PROFIEL-TAG: gebruik "bron":"profiel" ALLEEN als de taak vrijwel letterlijk terug te vinden is in de FUNCTIEPROFIEL-tekst. Als je moet redeneren of interpreteren om van een genoemd feit tot de taak te komen (ook al is die redenering logisch en plausibel), is het GEEN profiel-taak maar een beroep-taak. Twijfel je? Kies dan beroep, niet profiel.\n\nBELANGRIJKE REGEL VOOR DE BEDRIJF-TAG: gebruik "bron":"bedrijf" ALLEEN wanneer een taak concreet te herleiden is tot de ingevulde bedrijfsnaam of een ingevulde bedrijfseigen term. Verzin GEEN bedrijfscontext en maak GEEN aannames over hoe dit specifieke bedrijf werkt als daar geen concrete basis voor is. Een taak die generiek bij het beroep hoort (bijv. werkoverleg, toolboxmeetings, samenwerken in teams, projecten opleveren) hoort onder "beroep", ook als hij ook toevallig bij een bedrijf zou kunnen passen. Als er geen bedrijfsnaam en geen bedrijfseigen termen zijn ingevuld, gebruik dan NOOIT de tag "bedrijf".\n\nFUNCTIEPROFIEL: ${functieprofiel}\n${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}\n${eigenTaal ? `BEDRIJFSEIGEN TERMEN: ${eigenTaal}` : ''}\n${bronTeksten ? `\nAANVULLENDE BRONNEN:\n${bronTeksten}` : ''}\n\nJSON (direct, geen markdown):\n{"functietitel":"string","samenvatting":"max 2 zinnen","vergelijkbare_titels":["string"],"taken":[{"id":"T01","taak":"concrete taakomschrijving","bron":"profiel|beroep|bedrijf|bron","frequentie":"dagelijks|wekelijks|maandelijks","belang":"hoog|middel|laag","geselecteerd":true}]}\n\nGenereer 15-25 taken. Wees volledig en concreet.`,
    apiKey
  );
  return { ...taakResultaat, bronnenStatus };
}

async function koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey) {
  const { hard, soft } = laadEsco();
  const { topHard, soft: softList } = selecteerRelevante(functietitel, taken, hard, soft);
  const hardLijst = topHard.map(r => `${r[0]}|${r[1]}`).join('\n');
  const softLijst = softList.map(r => `${r[0]}|${r[1]}`).join('\n');
  const takenTekst = taken.map(t => {
    const kandidaten = scoreSkillsVoorTaak(t.taak, topHard, 8);
    const kandidatenTekst = kandidaten.length
      ? kandidaten.map(r => r[0]).join(', ')
      : '(geen sterke specifieke kandidaat gevonden op trefwoorden — kies alleen uit de algemene lijst als er echt een goede match bij zit, anders 0 hardskills voor deze taak)';
    return `- ${t.id}: ${t.taak}\n  Sterkste specifieke kandidaten voor DEZE taak (prioriteer deze boven de algemene lijst): ${kandidatenTekst}`;
  }).join('\n');
  const resultaat = await vraagClaude(
    'Je bent ESCO-expert en skills-analist. Geef ALLEEN geldige JSON terug, geen markdown.\nKRITIEKE REGEL: gebruik skills UITSLUITEND uit de meegestuurde ESCO-lijsten.\nGebruik het exacte label en de exacte code. Verzin NOOIT zelf skills of codes.\nMAX 2 hardskills en 1 softskill per taak — kies liever minder maar precieze skills dan het maximum vol te maken.\nGEEN GEFORCEERDE MATCH: het is prima als een taak 0 hardskills of 0 softskills krijgt wanneer er geen goede match is. Verzin nooit een skill die niet echt bij de taak past, alleen om het maximum te vullen.\nBELANGRIJK VOOR BEDRIJFSEIGEN TERMEN: kies voor elke bedrijfseigen term (zie BEDRIJFSEIGEN TERMEN) ÉÉN vaste ESCO-skill die het beste past, en gebruik exact diezelfde skill-naam en code voor die term bij ELKE taak waar hij relevant is. Kies nooit voor verschillende taken een andere ESCO-skill voor dezelfde bedrijfseigen term — dit veroorzaakt dubbele/inconsistente rijen in de uiteindelijke skillset.\nBELANGRIJK TEGEN GENERIEKE MATCHES: kies voor elke taak de SPECIFIEKSTE en meest onderscheidende passende skill die inhoudelijk bij dezelfde branche/sector hoort als de functie en de taak. Elke taak heeft een eigen regel "Sterkste specifieke kandidaten voor DEZE taak" — gebruik die als suggestie, niet als verplichting. NEGEER een kandidaat als deze duidelijk uit een andere branche komt dan de functie (bijv. een skill over spoorwegen, optiek, voedselverwerking of transport van gevaarlijke stoffen bij een algemene monteursfunctie), ook als er toevallig woordoverlap is — kies in dat geval liever een neutralere, bredere skill uit de ALGEMENE BESCHIKBARE HARDSKILLS-lijst die wél bij de sector past. Vermijd tegelijk dat één brede skill aan veel verschillende, inhoudelijk uiteenlopende taken wordt gekoppeld.\nSOFTSKILL-DIVERSITEIT: verken de volledige softskills-lijst en kies de skill die het beste bij de specifieke taak past, in plaats van steeds terug te vallen op dezelfde paar algemene termen (zoals "zelfstandig werken" of "verantwoordelijkheid nemen") als er een specifiekere optie in de lijst staat die beter aansluit bij wat de taak inhoudelijk vraagt.',
    `Koppel ESCO-skills aan taken voor: ${functietitel}\n\nTAKEN:\n${takenTekst}\n${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}\n${eigenTaal ? `BEDRIJFSEIGEN TERMEN (eigen:true, gebruik per term ALTIJD dezelfde ESCO-skill): ${eigenTaal}` : ''}\n\nALGEMENE BESCHIKBARE HARDSKILLS (label|code) — vul aan met deze lijst als de taak-specifieke kandidaten hierboven niet passen:\n${hardLijst}\n\nBESCHIKBARE SOFTSKILLS (label|code):\n${softLijst}\n\nJSON (direct, geen markdown):\n{\n  "kerncompetenties": [{"naam":"string","omschrijving":"string","toelichting":"string"}],\n  "taken": [{\n    "id": "T01",\n    "hardskills": [{"skill": "exacte label","esco_code": "exacte 8-karakter code","niveau": "Basis|Gevorderd|Expert","bron": "profiel|beroep|bedrijf","toelichting": "waarom relevant","eigen": false}],\n    "softskills": [{"softskill": "exacte label","esco_code": "exacte 8-karakter code","niveau": "Basis|Gevorderd|Expert","bron": "profiel|beroep|bedrijf","toelichting": "waarom relevant","eigen": false}]\n  }]\n}`,
    apiKey
  );
  const escoLookup = {};
  [...hard, ...soft].forEach(r => {
    escoLookup[r[1]] = { esco_label: r[0], esco_uri: r[3], esco_definitie: r[4] || null, esco_matched: true };
  });
  return {
    ...resultaat,
    taken: (resultaat.taken ?? []).map(taak => ({
      ...taak,
      hardskills: (taak.hardskills ?? []).map(s => {
        const l = escoLookup[s.esco_code] ?? {};
        return { ...s, esco_label: l.esco_label ?? s.skill, esco_uri: l.esco_uri ?? null, esco_definitie: l.esco_definitie ?? null, esco_matched: l.esco_matched ?? false };
      }),
      softskills: (taak.softskills ?? []).map(s => {
        const l = escoLookup[s.esco_code] ?? {};
        return { ...s, esco_label: l.esco_label ?? s.softskill, esco_uri: l.esco_uri ?? null, esco_definitie: l.esco_definitie ?? null, esco_matched: l.esco_matched ?? false };
      }),
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Alleen POST' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet ingesteld' });
  try {
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal, bronnen, pdfTekst, samenvatting, skills, bronnenTekst } = req.body ?? {};
    if (stap === 1) {
      if (!functieprofiel) return res.status(400).json({ error: 'functieprofiel verplicht' });
      return res.status(200).json(await genereerTaken(functieprofiel, bedrijf, eigenTaal, bronnen, pdfTekst||'', apiKey));
    }
    if (stap === 2) {
      if (!taken?.length) return res.status(400).json({ error: 'taken verplicht' });
      return res.status(200).json(await koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey));
    }
    if (stap === 3) {
      const takenTekst = (taken||[]).slice(0,15).map(t => '- ' + t.taak).join('\n');
      const hardTekst = (skills?.hard||[]).map(s => s.skill).join(', ');
      const softTekst = (skills?.soft||[]).map(s => s.softskill).join(', ');
      const res2 = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0,
          system: 'Je bent een expert HR-adviseur. Schrijf een professionele functieomschrijving in alineas zonder kopjes. Derde persoon. Maximaal 4 alineas.',
          messages: [{ role: 'user', content: 'FUNCTIETITEL: ' + functietitel + '\nBEDRIJF: ' + (bedrijf||'onbekend') + '\nSAMENVATTING: ' + (samenvatting||'') + '\nTAKEN:\n' + takenTekst + '\nHARDSKILLS: ' + hardTekst + '\nSOFTSKILLS: ' + softTekst + (bronnenTekst ? '\nCONTEXT: ' + bronnenTekst : '') + '\n\nSchrijf 3-4 professionele alineas over deze functie, geschikt om te delen met klanten.' }]
        }),
      });
      if (!res2.ok) throw new Error('Claude omschrijving fout: ' + res2.status);
      const data2 = await res2.json();
      return res.status(200).json({ omschrijving: data2.content?.[0]?.text ?? '' });
    }
    return res.status(400).json({ error: `Onbekende stap: ${stap}` });
  } catch (e) {
    console.error('Fout:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
