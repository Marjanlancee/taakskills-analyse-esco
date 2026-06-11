export const config = { api: { bodyParser: true } };

function buildSystemPrompt(bedrijf, eigenTaal) {
  const eigenBlok = eigenTaal?.trim()
    ? `\nHet bedrijf heet: ${bedrijf || 'onbekend'}.\nEigen vakjargon/competentietaal (gebruik deze termen als skillnaam, markeer met "eigen":true):\n${eigenTaal}\n`
    : '';

  return `Je bent een expert in functie-analyse en skills-based werken.
Je krijgt een functieprofiel en genereert een gestructureerde breakdown.
${eigenBlok}
BELANGRIJK: Voor elke skill geef je TWO namen:
1. "skill" = de naam zoals het bedrijf/sector het noemt (vakjargon, praktijktaal)
2. "esco_zoekterm" = de meest passende officiële ESCO-skillnaam in het Nederlands

Voorbeelden:
- vakjargon "veldbekabeling" → esco_zoekterm "contactdozen bedraden"
- vakjargon "schakelkast bouwen" → esco_zoekterm "elektrische schakelkasten assembleren"  
- vakjargon "inregelen" → esco_zoekterm "elektrische installaties testen"
- vakjargon "klantgesprek voeren" → esco_zoekterm "communiceren met klanten"
- vakjargon "rapport schrijven" → esco_zoekterm "technische documentatie opstellen"

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks. Begin met { en eindig met }.

{"functietitel":"string","samenvatting":"string","vergelijkbare_titels":["string"],"taken":[{"id":1,"taak":"string","bron":"functieprofiel|aangevuld|beide","frequentie":"dagelijks|wekelijks|maandelijks|incidenteel","belang":"hoog|middel|laag","vakmanschap":"hoog|middel|laag","taak_skills":[{"skill":"vakjargon naam","esco_zoekterm":"officiële ESCO naam","niveau":"Basis|Gevorderd|Expert","toelichting":"string","eigen":false}],"generieke_competenties":[{"competentie":"string","toelichting":"string","eigen":false}]}],"kerncompetenties":[{"competentie":"string","definitie":"string","eigen":false}]}

Regels:
- 8-12 taken, actief geformuleerd en specifiek
- Per taak: 2-3 skills, 2-3 generieke competenties
- Kerncompetenties: 4-5 stuks
- bron: "functieprofiel" als expliciet vermeld, "aangevuld" als toegevoegd, "beide" als beide
- Basis=uitvoerend/begeleiding, Gevorderd=zelfstandig/complex, Expert=strategisch/begeleidt anderen
- eigen:true alleen als de term uit de eigen competentietaal van het bedrijf komt`;
}

function matchEsco(zoekterm, escoData) {
  if (!escoData || !zoekterm) return null;
  const q = zoekterm.toLowerCase().trim();
  
  // 1. Exacte match
  let m = escoData.find(s => s[0].toLowerCase() === q);
  if (m) return { label: m[0], code: m[1] };
  
  // 2. Bevat match
  m = escoData.find(s => s[0].toLowerCase().includes(q));
  if (m) return { label: m[0], code: m[1] };
  
  // 3. Zoekterm bevat ESCO label
  m = escoData.find(s => q.includes(s[0].toLowerCase()) && s[0].length > 5);
  if (m) return { label: m[0], code: m[1] };
  
  // 4. Beste woordoverlap
  const words = q.split(' ').filter(w => w.length > 3);
  let best = null, bestScore = 0;
  for (const s of escoData) {
    const sl = s[0].toLowerCase();
    const score = words.filter(w => sl.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (bestScore >= 1 && best) return { label: best[0], code: best[1] };
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { functieprofiel, bedrijf, eigenTaal, escoData } = req.body;
    if (!functieprofiel) return res.status(400).json({ error: 'Geen functieprofiel meegegeven' });

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
    if (claudeData.error) return res.status(500).json({ error: claudeData.error.message });

    const raw = (claudeData.content || []).map(i => i.text || '').join('');
    
    let parsed;
    try { parsed = JSON.parse(raw.trim()); }
    catch {
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try { parsed = JSON.parse(stripped); }
      catch {
        const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
        if (a !== -1 && b !== -1) parsed = JSON.parse(raw.slice(a, b + 1));
        else throw new Error('Kon geen geldig JSON vinden');
      }
    }

    // Verrijk skills: match esco_zoekterm met ESCO database
    if (escoData && Array.isArray(escoData) && parsed.taken) {
      parsed.taken = parsed.taken.map(t => ({
        ...t,
        taak_skills: (t.taak_skills || []).map(s => {
          // Probeer te matchen op esco_zoekterm (Claude's voorstel voor ESCO naam)
          const zoekterm = s.esco_zoekterm || s.skill;
          const match = matchEsco(zoekterm, escoData);
          return {
            ...s,
            esco_code: match ? match.code : null,
            esco_label: match ? match.label : null,
            esco_matched: !!match
          };
        })
      }));
    }

    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
