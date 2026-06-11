// api/analyse.js — Functieprofiel Decompositor
// ESCO Webservice API v1.2.0 — live lookup via _links.self.uri (HAL)

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ESCO_API      = 'https://ec.europa.eu/esco/api';
const ESCO_VERSION  = '1.2.0';

// ─── JSON reparatie: sluit afgekapte JSON netjes af ──────────────────────────

function herstelAfgekapteJson(json) {
  try {
    JSON.parse(json);
    return json; // al geldig
  } catch {
    const opens = [];
    let inString = false;
    let escape = false;

    for (let i = 0; i < json.length; i++) {
      const c = json[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') opens.push('}');
      else if (c === '[') opens.push(']');
      else if (c === '}' || c === ']') opens.pop();
    }

    // Verwijder trailing komma's, sluit openstaande structuren
    let repaired = json.trimEnd().replace(/,\s*$/, '').replace(/,\s*([}\]])/g, '$1');
    for (let i = opens.length - 1; i >= 0; i--) {
      repaired += opens[i];
    }
    return repaired;
  }
}

// ─── ESCO live lookup ────────────────────────────────────────────────────────

async function escoZoekSkill(skillNaam, taal = 'nl') {
  try {
    const params = new URLSearchParams({
      text:            skillNaam,
      language:        taal,
      type:            'skill',
      selectedVersion: ESCO_VERSION,
      limit:           '5',
    });

    const res = await fetch(`${ESCO_API}/search?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const hits = data?._embedded?.results ?? [];
    if (hits.length === 0) return null;

    const top = hits[0];

    // URI zit in _links.self.uri (HAL-formaat)
    const uri      = top?._links?.self?.uri ?? top?.uri ?? '';
    const escoCode = uri ? uri.split('/').pop() : null;

    const rawScore = top.score ?? 0;
    const score    = rawScore > 1 ? Math.round(rawScore) : Math.round(rawScore * 100);

    const label = top.title
      ?? top?.preferredLabel?.[taal]
      ?? top?.preferredLabel?.en
      ?? skillNaam;

    const definitie =
      top?.description?.[taal]?.literal ??
      top?.description?.en?.literal ??
      null;

    return {
      esco_uri:        uri,
      esco_code:       escoCode,
      esco_label:      label,
      esco_definitie:  definitie,
      esco_matched:    true,
      esco_confidence: score,
    };
  } catch {
    return null;
  }
}

async function verrijkSkillsMetEsco(skills, taal = 'nl') {
  const resultaten = await Promise.allSettled(
    skills.map(s => escoZoekSkill(s, taal))
  );
  const map = {};
  skills.forEach((skill, i) => {
    map[skill] =
      resultaten[i].status === 'fulfilled' && resultaten[i].value
        ? resultaten[i].value
        : { esco_code: null, esco_label: skill, esco_definitie: null, esco_matched: false, esco_confidence: 0 };
  });
  return map;
}

// ─── Claude API aanroep ──────────────────────────────────────────────────────

async function vraagClaude(systeemPrompt, gebruikersBericht, apiKey) {
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
      system:     systeemPrompt,
      messages:   [{ role: 'user', content: gebruikersBericht }],
    }),
  });

  if (!res.ok) {
    const fout = await res.text();
    throw new Error(`Claude API fout: ${res.status} — ${fout}`);
  }

  const data = await res.json();
  const tekst = data.content?.[0]?.text ?? '';

  // Robuuste JSON-extractie (ook bij afgekapte codeblokken)
  let jsonTekst = tekst;

  const volledigBlok = tekst.match(/```json\s*([\s\S]*?)```/);
  if (volledigBlok) {
    jsonTekst = volledigBlok[1].trim();
  } else {
    const openBlok = tekst.match(/```json\s*([\s\S]*)/);
    if (openBlok) {
      jsonTekst = openBlok[1].trim();
    } else {
      const rawMatch = tekst.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (rawMatch) jsonTekst = rawMatch[0];
    }
  }

  // Repareer afgekapte JSON
  jsonTekst = herstelAfgekapteJson(jsonTekst);

  try {
    return JSON.parse(jsonTekst);
  } catch {
    throw new Error('Claude gaf geen geldig JSON terug: ' + tekst.slice(0, 400));
  }
}

// ─── Stap 1: Taken genereren ─────────────────────────────────────────────────

async function genereerTaken(functieprofiel, bedrijf, eigenTaal, apiKey) {
  const sys = `Je bent een expert in functie-analyse en skills-based werken.
Je analyseert functieprofielen en genereert een gestructureerde takenlijst in het Nederlands.
Geef ALLEEN geldige JSON terug, geen markdown of toelichting buiten de JSON.`;

  const prompt = `Analyseer dit functieprofiel en genereer een takenlijst:

FUNCTIEPROFIEL:
${functieprofiel}

${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN: ${eigenTaal}` : ''}

Geef terug als JSON (geen markdown eromheen):
{
  "functietitel": "string",
  "samenvatting": "string (max 2 zinnen)",
  "vergelijkbare_titels": ["string"],
  "taken": [
    {
      "id": "T01",
      "taak": "Concrete taakomschrijving",
      "bron": "profiel|beroep|bedrijf",
      "frequentie": "dagelijks|wekelijks|maandelijks",
      "belang": "hoog|middel|laag",
      "geselecteerd": true
    }
  ]
}

Genereer 8-15 taken. Wees concreet en actiegericht.`;

  return vraagClaude(sys, prompt, apiKey);
}

// ─── Stap 2: Skills koppelen + ESCO verrijking ───────────────────────────────

async function koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey) {
  const sys = `Je bent een ESCO-expert en skills-analist.
Je koppelt concrete taken aan hardskills en softskills.
Geef ALLEEN geldige JSON terug. Geen markdown, geen tekst buiten de JSON.
Houd de response compact — max 3 hardskills en 2 softskills per taak.`;

  const takenTekst = taken.map(t => `- ${t.id}: ${t.taak}`).join('\n');

  const prompt = `Koppel ESCO-skills aan deze taken voor functie: ${functietitel}

TAKEN:
${takenTekst}

${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN (markeer als eigen:true): ${eigenTaal}` : ''}

Geef terug als JSON (geen markdown eromheen):
{
  "kerncompetenties": [
    { "naam": "string", "omschrijving": "string", "toelichting": "string" }
  ],
  "taken": [
    {
      "id": "T01",
      "hardskills": [
        { "skill": "Nederlandse skillnaam", "niveau": "Basis|Gevorderd|Expert", "bron": "profiel|beroep|bedrijf", "toelichting": "kort", "eigen": false }
      ],
      "softskills": [
        { "softskill": "Softskill naam", "niveau": "Basis|Gevorderd|Expert", "bron": "profiel|beroep|bedrijf", "toelichting": "kort", "eigen": false }
      ]
    }
  ]
}

Regels:
- MAX 3 hardskills en MAX 2 softskills per taak (houd het compact)
- Gebruik gangbare Nederlandse terminologie voor goede ESCO-matching
- Markeer bedrijfseigen termen als eigen:true
- Geen ESCO-codes invullen — worden automatisch live opgezocht`;

  const claudeResultaat = await vraagClaude(sys, prompt, apiKey);

  // ESCO live verrijking
  const alleHardskills = [...new Set(
    (claudeResultaat.taken ?? []).flatMap(t => (t.hardskills ?? []).map(s => s.skill))
  )];
  const alleSoftskills = [...new Set(
    (claudeResultaat.taken ?? []).flatMap(t => (t.softskills ?? []).map(s => s.softskill))
  )];

  const [escoHard, escoSoft] = await Promise.all([
    verrijkSkillsMetEsco(alleHardskills, 'nl'),
    verrijkSkillsMetEsco(alleSoftskills, 'nl'),
  ]);

  return {
    ...claudeResultaat,
    taken: (claudeResultaat.taken ?? []).map(taak => ({
      ...taak,
      hardskills: (taak.hardskills ?? []).map(s => ({ ...s, ...(escoHard[s.skill] ?? {}) })),
      softskills: (taak.softskills ?? []).map(s => ({ ...s, ...(escoSoft[s.softskill] ?? {}) })),
    })),
  };
}

// ─── Vercel handler ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Alleen POST' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet ingesteld in Vercel' });

  try {
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal } = req.body ?? {};

    if (stap === 1) {
      if (!functieprofiel) return res.status(400).json({ error: 'functieprofiel is verplicht' });
      return res.status(200).json(await genereerTaken(functieprofiel, bedrijf, eigenTaal, apiKey));
    }

    if (stap === 2) {
      if (!taken?.length) return res.status(400).json({ error: 'taken zijn verplicht' });
      return res.status(200).json(await koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey));
    }

    return res.status(400).json({ error: `Onbekende stap: ${stap}` });

  } catch (e) {
    console.error('Handler fout:', e);
    return res.status(500).json({ error: e.message ?? 'Onbekende fout' });
  }
}
