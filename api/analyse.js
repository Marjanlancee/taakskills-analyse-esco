// api/analyse.js — Functieprofiel Decompositor
// ESCO: volledige URI + beschrijving, Claude kiest uit echte ESCO-lijst

import fs from 'fs';
import path from 'path';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ─── Laad ESCO bestanden (gecached) ──────────────────────────────────────────
// Formaat: [label, short_code, type, full_uri, description]

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

// ─── Selecteer relevante skills op basis van context ─────────────────────────

function selecteerRelevante(functietitel, taken, hard, soft) {
  const context = [functietitel, ...taken.map(t => t.taak)].join(' ').toLowerCase();

  const gescoord = hard.map(row => {
    const label = row[0].toLowerCase();
    const woorden = label.split(/\s+/).filter(w => w.length > 3);
    const score = woorden.filter(w => context.includes(w)).length;
    return { row, score };
  });

  gescoord.sort((a, b) => b.score - a.score);
  const topHard = gescoord.slice(0, 400).map(g => g.row);

  return { topHard, soft };
}

// ─── JSON reparatie ───────────────────────────────────────────────────────────

function herstelJson(json) {
  try { JSON.parse(json); return json; } catch { /**/ }
  const opens = [];
  let inStr = false, esc = false;
  for (const c of json) {
    if (esc)        { esc = false; continue; }
    if (c === '\\') { esc = true;  continue; }
    if (c === '"')  { inStr = !inStr; continue; }
    if (inStr)      continue;
    if (c === '{')       opens.push('}');
    else if (c === '[')  opens.push(']');
    else if (c === '}' || c === ']') opens.pop();
  }
  let r = json.trimEnd().replace(/,\s*$/, '').replace(/,\s*([}\]])/g, '$1');
  for (let i = opens.length - 1; i >= 0; i--) r += opens[i];
  return r;
}

// ─── Claude aanroep ───────────────────────────────────────────────────────────

async function vraagClaude(sys, prompt, apiKey) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 8192,
      system:     sys,
      messages:   [{ role: 'user', content: prompt }],
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

// ─── Stap 1: Taken genereren ──────────────────────────────────────────────────

async function genereerTaken(functieprofiel, bedrijf, eigenTaal, apiKey) {
  return vraagClaude(
    `Je bent expert in functie-analyse en skills-based werken. Geef ALLEEN geldige JSON terug, geen markdown.`,
    `Analyseer dit functieprofiel grondig. Haal ALLE taken op:
1. Taken die expliciet in het profiel staan
2. Taken die standaard bij dit beroep horen (sectorkennis)
3. Taken die bij de context van het bedrijf horen

FUNCTIEPROFIEL: ${functieprofiel}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN: ${eigenTaal}` : ''}

JSON (direct, geen markdown):
{"functietitel":"string","samenvatting":"max 2 zinnen","vergelijkbare_titels":["string"],"taken":[{"id":"T01","taak":"concrete taakomschrijving","bron":"profiel|beroep|bedrijf","frequentie":"dagelijks|wekelijks|maandelijks","belang":"hoog|middel|laag","geselecteerd":true}]}

Genereer 15-30 taken afhankelijk van de complexiteit van de functie. Wees volledig en concreet.`,
    apiKey
  );
}

// ─── Stap 2: Skills koppelen via ESCO-selectie ────────────────────────────────

async function koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey) {
  const { hard, soft } = laadEsco();
  const { topHard, soft: softList } = selecteerRelevante(functietitel, taken, hard, soft);

  // Stuur label|code|definitie mee zodat Claude ook de definitie kent
  const hardLijst = topHard.map(r => `${r[0]}|${r[1]}|${r[4] ? r[4].slice(0,80) : ''}`).join('\n');
  const softLijst = softList.map(r => `${r[0]}|${r[1]}|${r[4] ? r[4].slice(0,80) : ''}`).join('\n');
  const takenTekst = taken.map(t => `- ${t.id}: ${t.taak}`).join('\n');

  const resultaat = await vraagClaude(
    `Je bent ESCO-expert en skills-analist. Geef ALLEEN geldige JSON terug, geen markdown.
KRITIEKE REGEL: gebruik skills UITSLUITEND uit de meegestuurde ESCO-lijsten.
Gebruik het exacte label en de exacte code. Verzin NOOIT zelf skills of codes.
MAX 3 hardskills en 2 softskills per taak.`,

    `Koppel ESCO-skills aan taken voor: ${functietitel}

TAKEN:
${takenTekst}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN (eigen:true): ${eigenTaal}` : ''}

BESCHIKBARE HARDSKILLS (label|code|definitie-preview):
${hardLijst}

BESCHIKBARE SOFTSKILLS (label|code|definitie-preview):
${softLijst}

JSON (direct, geen markdown):
{
  "kerncompetenties": [{"naam":"string","omschrijving":"string","toelichting":"string"}],
  "taken": [{
    "id": "T01",
    "hardskills": [{
      "skill": "exacte label uit de lijst",
      "esco_code": "exacte 8-karakter code uit de lijst",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "waarom relevant voor deze taak",
      "eigen": false
    }],
    "softskills": [{
      "softskill": "exacte label uit de lijst",
      "esco_code": "exacte 8-karakter code uit de lijst",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "waarom relevant voor deze taak",
      "eigen": false
    }]
  }]
}`,
    apiKey
  );

  // Bouw ESCO-lookup voor volledige verrijking
  const escoLookup = {};
  [...hard, ...soft].forEach(r => {
    escoLookup[r[1]] = {
      esco_label:      r[0],
      esco_uri:        r[3],
      esco_definitie:  r[4] || null,
      esco_matched:    true,
      esco_confidence: 100,
    };
  });

  // Verrijk resultaat met volledige ESCO-data
  return {
    ...resultaat,
    taken: (resultaat.taken ?? []).map(taak => ({
      ...taak,
      hardskills: (taak.hardskills ?? []).map(s => {
        const lookup = escoLookup[s.esco_code] ?? {};
        return {
          ...s,
          esco_label:      lookup.esco_label      ?? s.skill,
          esco_uri:        lookup.esco_uri        ?? null,
          esco_definitie:  lookup.esco_definitie  ?? null,
          esco_matched:    lookup.esco_matched    ?? false,
          esco_confidence: lookup.esco_confidence ?? 0,
        };
      }),
      softskills: (taak.softskills ?? []).map(s => {
        const lookup = escoLookup[s.esco_code] ?? {};
        return {
          ...s,
          esco_label:      lookup.esco_label      ?? s.softskill,
          esco_uri:        lookup.esco_uri        ?? null,
          esco_definitie:  lookup.esco_definitie  ?? null,
          esco_matched:    lookup.esco_matched    ?? false,
          esco_confidence: lookup.esco_confidence ?? 0,
        };
      }),
    })),
  };
}

// ─── Vercel handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Alleen POST' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet ingesteld' });

  try {
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal } = req.body ?? {};
    if (stap === 1) {
      if (!functieprofiel) return res.status(400).json({ error: 'functieprofiel verplicht' });
      return res.status(200).json(await genereerTaken(functieprofiel, bedrijf, eigenTaal, apiKey));
    }
    if (stap === 2) {
      if (!taken?.length) return res.status(400).json({ error: 'taken verplicht' });
      return res.status(200).json(await koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey));
    }
    return res.status(400).json({ error: `Onbekende stap: ${stap}` });
  } catch (e) {
    console.error('Fout:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
