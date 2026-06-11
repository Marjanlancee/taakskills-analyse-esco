// api/analyse.js — Vercel serverless function
// Handles: Claude analysis + ESCO skill matching

export const config = { api: { bodyParser: true } };

// ─── ESCO matching ───────────────────────────────────────────────────────────
// We embed a compact lookup table of the most common HR-relevant ESCO skills
// The full database is loaded client-side for enrichment

function matchEsco(skillName, escoData) {
  if (!escoData || !skillName) return null;
  const q = skillName.toLowerCase().trim();
  
  // 1. Exact match
  let m = escoData.find(s => s[0].toLowerCase() === q);
  if (m) return { label: m[0], code: m[1] };
  
  // 2. Contains match
  m = escoData.find(s => s[0].toLowerCase().includes(q) || q.includes(s[0].toLowerCase()));
  if (m) return { label: m[0], code: m[1] };
  
  // 3. Best word overlap
  const words = q.split(' ').filter(w => w.length > 3);
  let best = null, bestScore = 0;
  for (const s of escoData) {
    const sl = s[0].toLowerCase();
    const score = words.filter(w => sl.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (bestScore > 0 && best) return { label: best[0], code: best[1] };
  return null;
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(bedrijf, eigenTaal) {
  const eigenBlok = eigenTaal?.trim()
    ? `\nHet bedrijf heet: ${bedrijf || 'onbekend'}.\nEigen competentietaal (markeer met "eigen":true): ${eigenTaal}\n`
    : '';

  return `Je bent een expert in functie-analyse en skills-based werken.
Je krijgt een functieprofiel en genereert een gestructureerde breakdown.
${eigenBlok}
Analyseer de functie grondig. Vul taken aan op basis van je kennis van vergelijkbare functies.

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks. Begin met { en eindig met }.

{"functietitel":"string","samenvatting":"string","vergelijkbare_titels":["string"],"taken":[{"id":1,"taak":"string","bron":"functieprofiel|aangevuld|beide","frequentie":"dagelijks|wekelijks|maandelijks|incidenteel","belang":"hoog|middel|laag","vakmanschap":"hoog|middel|laag","taak_skills":[{"skill":"string","niveau":"Basis|Gevorderd|Expert","toelichting":"string","eigen":false}],"generieke_competenties":[{"competentie":"string","toelichting":"string","eigen":false}]}],"kerncompetenties":[{"competentie":"string","definitie":"string","eigen":false}]}

Regels:
- Genereer 8-12 taken, actief geformuleerd en specifiek
- Per taak: 2-3 skills, 2-3 generieke competenties
- Kerncompetenties: 4-5 stuks
- bron: "functieprofiel" als expliciet vermeld, "aangevuld" als toegevoegd op basis van de functie, "beide" als beide
- Basis=uitvoerend/begeleiding, Gevorderd=zelfstandig/complex, Expert=strategisch/begeleidt anderen
- eigen:true alleen als de term uit de eigen competentietaal van het bedrijf komt`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { functieprofiel, bedrijf, eigenTaal, escoData } = req.body;

    if (!functieprofiel) {
      return res.status(400).json({ error: 'Geen functieprofiel meegegeven' });
    }

    // Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 6000,
        system: buildSystemPrompt(bedrijf, eigenTaal),
        messages: [{ role: 'user', content: `Analyseer dit functieprofiel:\n\n${functieprofiel}` }]
      })
    });

    const claudeData = await claudeRes.json();
    
    if (claudeData.error) {
      return res.status(500).json({ error: claudeData.error.message });
    }

    const raw = (claudeData.content || []).map(i => i.text || '').join('');
    
    // Parse JSON — try multiple strategies
    let parsed;
    try { parsed = JSON.parse(raw.trim()); }
    catch {
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try { parsed = JSON.parse(stripped); }
      catch {
        const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
        if (a !== -1 && b !== -1) {
          parsed = JSON.parse(raw.slice(a, b + 1));
        } else {
          throw new Error('Kon geen geldig JSON vinden in de response');
        }
      }
    }

    // Enrich skills with ESCO matches if client sent escoData
    if (escoData && Array.isArray(escoData) && parsed.taken) {
      parsed.taken = parsed.taken.map(t => ({
        ...t,
        taak_skills: (t.taak_skills || []).map(s => {
          const match = matchEsco(s.skill, escoData);
          if (match) {
            return { ...s, skill: match.label, esco_code: match.code, esco_matched: true };
          }
          return { ...s, esco_matched: false };
        })
      }));
    }

    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
