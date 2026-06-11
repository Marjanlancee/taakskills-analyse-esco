// api/analyse.js — Functieprofiel Decompositor
// ESCO Webservice API v1.2.0 geïntegreerd (live lookup per skill)
// Vercel serverless function

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ESCO_API      = 'https://ec.europa.eu/esco/api';
const ESCO_VERSION  = '1.2.0';

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
      signal: AbortSignal.timeout(4000), // 4 sec timeout per skill
    });

    if (!res.ok) return null;

    const data = await res.json();
    const hits = data?._embedded?.results ?? [];
    if (hits.length === 0) return null;

    const top = hits[0];

    // URI bevat de ESCO-code (laatste deel na laatste /)
    const uri        = top.uri ?? '';
    const escoCode   = uri.split('/').pop() ?? null;
    const score      = Math.round((top.score ?? 0.8) * 100);

    // Preferredlabel in NL, fallback EN
    const label =
      top.preferredLabel?.nl ??
      top.preferredLabel?.en ??
      top.title ??
      skillNaam;

    // Definitie
    const definitie =
      top.description?.nl?.literal ??
      top.description?.en?.literal ??
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

// Batch: alle skills tegelijk opzoeken (parallel, met fallback bij mislukking)
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
      model:      'claude-sonnet-4-20250514',
      max_tokens: 4096,
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

  // JSON extraheren (Claude omhult soms met ```json ... ```)
  const match = tekst.match(/```json\s*([\s\S]*?)\s*```/) ?? tekst.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  const jsonTekst = match ? match[1] ?? match[0] : tekst;

  try {
    return JSON.parse(jsonTekst);
  } catch {
    throw new Error('Claude gaf geen geldig JSON terug: ' + tekst.slice(0, 300));
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

Geef terug als JSON:
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

// ─── Stap 2: Skills koppelen + ESCO live verrijking ──────────────────────────

async function koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey) {
  const sys = `Je bent een ESCO-expert en skills-analist. 
Je koppelt concrete taken aan hardskills en softskills.
Geef ALLEEN geldige JSON terug. Geen markdown of tekst buiten de JSON.`;

  const takenTekst = taken.map(t => `- ${t.id}: ${t.taak}`).join('\n');

  const prompt = `Koppel ESCO-skills aan deze taken voor functie: ${functietitel}

TAKEN:
${takenTekst}

${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN (markeer als eigen:true): ${eigenTaal}` : ''}

Geef terug als JSON:
{
  "kerncompetenties": [
    {
      "naam": "string",
      "omschrijving": "string",
      "toelichting": "string"
    }
  ],
  "taken": [
    {
      "id": "T01",
      "hardskills": [
        {
          "skill": "Exacte Nederlandse skilnaam",
          "niveau": "Basis|Gevorderd|Expert",
          "bron": "profiel|beroep|bedrijf",
          "toelichting": "string",
          "eigen": false
        }
      ],
      "softskills": [
        {
          "softskill": "Exacte softskill naam",
          "niveau": "Basis|Gevorderd|Expert",
          "bron": "profiel|beroep|bedrijf",
          "toelichting": "string",
          "eigen": false
        }
      ]
    }
  ]
}

Regels:
- 3-6 hardskills en 2-4 softskills per taak
- Gebruik precieze, gangbare Nederlandse terminologie (zodat ESCO-matching werkt)
- Markeer bedrijfseigen termen als eigen:true
- Geen ESCO-codes invullen — die worden automatisch opgezocht`;

  const claudeResultaat = await vraagClaude(sys, prompt, apiKey);

  // ── ESCO live verrijking ──────────────────────────────────────────────────
  // Verzamel alle unieke hardskills + softskills
  const alleHardskills = [...new Set(
    (claudeResultaat.taken ?? []).flatMap(t => (t.hardskills ?? []).map(s => s.skill))
  )];
  const alleSoftskills = [...new Set(
    (claudeResultaat.taken ?? []).flatMap(t => (t.softskills ?? []).map(s => s.softskill))
  )];

  // Parallel ESCO lookups voor hard- én softskills
  const [escoHard, escoSoft] = await Promise.all([
    verrijkSkillsMetEsco(alleHardskills, 'nl'),
    verrijkSkillsMetEsco(alleSoftskills, 'nl'),
  ]);

  // Verrijking terugschrijven naar het resultaat
  const verrijktResultaat = {
    ...claudeResultaat,
    taken: (claudeResultaat.taken ?? []).map(taak => ({
      ...taak,
      hardskills: (taak.hardskills ?? []).map(s => ({
        ...s,
        ...(escoHard[s.skill] ?? {}),
      })),
      softskills: (taak.softskills ?? []).map(s => ({
        ...s,
        ...(escoSoft[s.softskill] ?? {}),
      })),
    })),
  };

  return verrijktResultaat;
}

// ─── Vercel handler ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Alleen POST' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet ingesteld in Vercel omgevingsvariabelen' });

  try {
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal } = req.body ?? {};

    if (stap === 1) {
      if (!functieprofiel) return res.status(400).json({ error: 'functieprofiel is verplicht' });
      const resultaat = await genereerTaken(functieprofiel, bedrijf, eigenTaal, apiKey);
      return res.status(200).json(resultaat);
    }

    if (stap === 2) {
      if (!taken?.length) return res.status(400).json({ error: 'taken zijn verplicht' });
      const resultaat = await koppelSkills(functietitel, taken, bedrijf, eigenTaal, apiKey);
      return res.status(200).json(resultaat);
    }

    return res.status(400).json({ error: `Onbekende stap: ${stap}` });

  } catch (e) {
    console.error('Handler fout:', e);
    return res.status(500).json({ error: e.message ?? 'Onbekende fout' });
  }
}
