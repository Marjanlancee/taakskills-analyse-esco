// api/analyse.js — Functieprofiel Decompositor
// ESCO Webservice API v1.2.0 — zoekt altijd in het Engels voor beste coverage

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ESCO_API      = 'https://ec.europa.eu/esco/api';
const ESCO_VERSION  = '1.2.0';

// ─── JSON reparatie bij afgekapte responses ───────────────────────────────────

function herstelAfgekapteJson(json) {
  try { JSON.parse(json); return json; } catch { /* doorgaan */ }
  const opens = [];
  let inString = false, escape = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (escape)         { escape = false; continue; }
    if (c === '\\')     { escape = true;  continue; }
    if (c === '"')      { inString = !inString; continue; }
    if (inString)       continue;
    if (c === '{')      opens.push('}');
    else if (c === '[') opens.push(']');
    else if (c === '}' || c === ']') opens.pop();
  }
  let r = json.trimEnd().replace(/,\s*$/, '').replace(/,\s*([}\]])/g, '$1');
  for (let i = opens.length - 1; i >= 0; i--) r += opens[i];
  return r;
}

// ─── ESCO live lookup — altijd Engels ────────────────────────────────────────

async function escoZoekSkill(skillNaamEn) {
  try {
    const params = new URLSearchParams({
      text:            skillNaamEn,
      language:        'en',
      type:            'skill',
      selectedVersion: ESCO_VERSION,
      limit:           '3',
    });

    const res = await fetch(`${ESCO_API}/search?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const hits = data?._embedded?.results ?? [];
    if (hits.length === 0) return null;

    const top   = hits[0];
    const uri   = top?._links?.self?.uri ?? top?.uri ?? '';
    const code  = uri ? uri.split('/').pop() : null;
    const score = top.score > 1 ? Math.round(top.score) : Math.round((top.score ?? 0) * 100);

    // Geef NL-label terug als die beschikbaar is, anders Engels
    const labelNl = top?.preferredLabel?.nl;
    const labelEn = top?.preferredLabel?.en ?? top.title ?? skillNaamEn;
    const definitieNl = top?.description?.nl?.literal ?? null;
    const definitieEn = top?.description?.en?.literal ?? null;

    return {
      esco_uri:        uri,
      esco_code:       code,
      esco_label:      labelNl ?? labelEn,
      esco_label_en:   labelEn,
      esco_definitie:  definitieNl ?? definitieEn,
      esco_matched:    true,
      esco_confidence: score,
    };
  } catch {
    return null;
  }
}

async function verrijkSkillsMetEsco(skillsEnMap) {
  // skillsEnMap = { "Nederlandse naam": "English search term" }
  const entries = Object.entries(skillsEnMap);
  const resultaten = await Promise.allSettled(
    entries.map(([, en]) => escoZoekSkill(en))
  );
  const map = {};
  entries.forEach(([nl], i) => {
    map[nl] = resultaten[i].status === 'fulfilled' && resultaten[i].value
      ? resultaten[i].value
      : { esco_code: null, esco_label: nl, esco_definitie: null, esco_matched: false, esco_confidence: 0 };
  });
  return map;
}

// ─── Claude API aanroep ───────────────────────────────────────────────────────

async function vraagClaude(sys, prompt, apiKey) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 8192,
      system:     sys,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API fout: ${res.status} — ${await res.text()}`);

  const tekst = (await res.json()).content?.[0]?.text ?? '';

  let jsonTekst = tekst;
  const volledig = tekst.match(/```json\s*([\s\S]*?)```/);
  if (volledig) {
    jsonTekst = volledig[1].trim();
  } else {
    const open = tekst.match(/```json\s*([\s\S]*)/);
    if (open) jsonTekst = open[1].trim();
    else {
      const raw = tekst.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (raw) jsonTekst = raw[0];
    }
  }

  jsonTekst = herstelAfgekapteJson(jsonTekst);
  try { return JSON.parse(jsonTekst); }
  catch { throw new Error('Ongeldige JSON van Claude: ' + tekst.slice(0, 400)); }
}

// ─── Stap 1: Taken genereren ──────────────────────────────────────────────────

async function genereerTaken(functieprofiel, bedrijf, eigenTaal, apiKey) {
  const sys = `Je bent expert in functie-analyse en skills-based werken. Geef ALLEEN geldige JSON terug, geen markdown omheen.`;
  const prompt = `Analyseer dit functieprofiel en geef een takenlijst terug als JSON:

FUNCTIEPROFIEL: ${functieprofiel}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN: ${eigenTaal}` : ''}

JSON-formaat (direct, geen markdown):
{"functietitel":"string","samenvatting":"max 2 zinnen","vergelijkbare_titels":["string"],"taken":[{"id":"T01","taak":"string","bron":"profiel|beroep|bedrijf","frequentie":"dagelijks|wekelijks|maandelijks","belang":"hoog|middel|laag","geselecteerd":true}]}

Genereer 8-15 taken. Concreet en actiegericht.`;
  return vraagClaude(sys, prompt, apiKey);
}

// ─── Stap 2: Skills koppelen + ESCO verrijking ────────────────────────────────

async function koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey) {
  const sys = `Je bent ESCO-expert en skills-analist. Geef ALLEEN geldige JSON terug, geen markdown omheen.
Voor elke skill geef je ZOWEL een Nederlandse naam (skill_nl) ALS een Engelse ESCO-zoekterm (skill_en).
De Engelse zoekterm moet overeenkomen met hoe ESCO de skill noemt (bijv. "install electrical systems", "read technical drawings").
Maximaal 3 hardskills en 2 softskills per taak.`;

  const takenTekst = taken.map(t => `- ${t.id}: ${t.taak}`).join('\n');
  const prompt = `Koppel skills aan taken voor: ${functietitel}

TAKEN:
${takenTekst}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN (eigen:true): ${eigenTaal}` : ''}

JSON-formaat (direct, geen markdown):
{
  "kerncompetenties": [{"naam":"string","omschrijving":"string","toelichting":"string"}],
  "taken": [{
    "id": "T01",
    "hardskills": [{
      "skill": "Nederlandse naam",
      "skill_en": "English ESCO search term",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "kort",
      "eigen": false
    }],
    "softskills": [{
      "softskill": "Nederlandse naam",
      "softskill_en": "English ESCO search term",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "kort",
      "eigen": false
    }]
  }]
}`;

  const resultaat = await vraagClaude(sys, prompt, apiKey);

  // Bouw NL→EN maps voor ESCO lookup
  const hardMap = {};
  const softMap = {};
  (resultaat.taken ?? []).forEach(t => {
    (t.hardskills ?? []).forEach(s => { if (!hardMap[s.skill]) hardMap[s.skill] = s.skill_en ?? s.skill; });
    (t.softskills ?? []).forEach(s => { if (!softMap[s.softskill]) softMap[s.softskill] = s.softskill_en ?? s.softskill; });
  });

  const [escoHard, escoSoft] = await Promise.all([
    verrijkSkillsMetEsco(hardMap),
    verrijkSkillsMetEsco(softMap),
  ]);

  return {
    ...resultaat,
    taken: (resultaat.taken ?? []).map(taak => ({
      ...taak,
      hardskills: (taak.hardskills ?? []).map(s => ({ ...s, ...(escoHard[s.skill] ?? {}) })),
      softskills: (taak.softskills ?? []).map(s => ({ ...s, ...(escoSoft[s.softskill] ?? {}) })),
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
    console.error('Fout:', e);
    return res.status(500).json({ error: e.message });
  }
}
