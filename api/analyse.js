export const config = { api: { bodyParser: true } };

// ─── ESCO matching ────────────────────────────────────────────────────────────
function matchEsco(zoekterm, escoData) {
  if (!escoData || !zoekterm) return null;
  const q = zoekterm.toLowerCase().trim();
  let m = escoData.find(s => s[0].toLowerCase() === q);
  if (m) return { label: m[0], code: m[1] };
  m = escoData.find(s => s[0].toLowerCase().includes(q));
  if (m) return { label: m[0], code: m[1] };
  m = escoData.find(s => q.includes(s[0].toLowerCase()) && s[0].length > 5);
  if (m) return { label: m[0], code: m[1] };
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

// ─── Prompt stap 1: Taken genereren ──────────────────────────────────────────
function promptTaken(bedrijf, eigenTaal) {
  const eigenBlok = eigenTaal?.trim()
    ? `\nHet bedrijf heet: ${bedrijf || 'onbekend'}.\nBedrijfsskills (verplichte skills/kernwaarden): ${eigenTaal}\n`
    : '';
  return `Je bent een expert in functie-analyse.
Je krijgt een functieprofiel en genereert een zo volledig mogelijke takenlijst.
${eigenBlok}
Analyseer de functie en genereer 20-40 taken. Gebruik:
- Taken uit het functieprofiel zelf
- Taken die logisch horen bij vergelijkbare functies
- Denk aan: uitvoering, voorbereiding, administratie, overleg, veiligheid, kwaliteit, coaching, klantcontact

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks.

{"functietitel":"string","samenvatting":"string","vergelijkbare_titels":["string"],"taken":[{"id":1,"taak":"string","bron":"functieprofiel|aangevuld|beide","frequentie":"dagelijks|wekelijks|maandelijks|incidenteel","belang":"hoog|middel|laag","vakmanschap":"hoog|middel|laag","geselecteerd":true}]}

Regels:
- 20-40 taken, actief geformuleerd
- bron: functieprofiel / aangevuld / beide
- Sorteer van meest naar minst relevant
- geselecteerd: true voor de top 15 meest relevante taken, false voor de rest`;
}

// ─── Prompt stap 2: Skills koppelen ──────────────────────────────────────────
function promptSkills(functietitel, taken, bedrijf, eigenTaal) {
  const eigenBlok = eigenTaal?.trim()
    ? `\nBedrijfsskills van ${bedrijf || 'dit bedrijf'} (markeer met "eigen":true): ${eigenTaal}\n`
    : '';
  const takenlijst = taken.map(t => `${t.id}. ${t.taak}`).join('\n');
  return `Je bent een expert in skills-based werken.
Functie: ${functietitel}
${eigenBlok}
Koppel ESCO-skills aan de volgende taken. Geef per skill de vakjargon-naam EN de officiële ESCO-zoekterm.

Taken:
${takenlijst}

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks.

{"taken":[{"id":1,"hardskills":[{"skill":"vakjargon naam","esco_zoekterm":"officiële ESCO naam","niveau":"Basis|Gevorderd|Expert","toelichting":"kort","eigen":false}],"softskills":[{"softskill":"naam","toelichting":"kort","eigen":false}]}],"kerncompetenties":[{"competentie":"string","definitie":"string","eigen":false}]}

Regels:
- Per taak: 2-3 hardskills, 2 softskills
- Kerncompetenties: 4-5 stuks
- Vakjargon = praktijktaal die het bedrijf gebruikt
- ESCO zoekterm = officiële Nederlandse ESCO naam
- Basis=uitvoerend, Gevorderd=zelfstandig, Expert=strategisch
- eigen:true alleen voor bedrijfsskills`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal, escoData } = req.body;

    if (stap === 1) {
      // Stap 1: Taken genereren
      if (!functieprofiel) return res.status(400).json({ error: 'Geen functieprofiel meegegeven' });
      
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 8000,
          system: promptTaken(bedrijf, eigenTaal),
          messages: [{ role: 'user', content: `Analyseer dit functieprofiel:\n\n${functieprofiel}` }]
        })
      });
      const claudeData = await claudeRes.json();
      if (claudeData.error) return res.status(500).json({ error: claudeData.error.message });
      const raw = (claudeData.content || []).map(i => i.text || '').join('');
      let parsed;
      try { parsed = JSON.parse(raw.trim()); }
      catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); parsed = JSON.parse(raw.slice(a, b+1)); }
      return res.status(200).json(parsed);

    } else if (stap === 2) {
      // Stap 2: Skills koppelen
      if (!taken || !functietitel) return res.status(400).json({ error: 'Geen taken meegegeven' });
      
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 8000,
          system: promptSkills(functietitel, taken, bedrijf, eigenTaal),
          messages: [{ role: 'user', content: 'Koppel ESCO-skills aan deze taken.' }]
        })
      });
      const claudeData = await claudeRes.json();
      if (claudeData.error) return res.status(500).json({ error: claudeData.error.message });
      const raw = (claudeData.content || []).map(i => i.text || '').join('');
      let parsed;
      try { parsed = JSON.parse(raw.trim()); }
      catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); parsed = JSON.parse(raw.slice(a, b+1)); }

      // ESCO matching
      if (escoData && Array.isArray(escoData)) {
        parsed.taken = (parsed.taken || []).map(t => ({
          ...t,
          hardskills: (t.hardskills || []).map(s => {
            const match = matchEsco(s.esco_zoekterm || s.skill, escoData);
            return { ...s, esco_code: match?.code || null, esco_label: match?.label || null, esco_matched: !!match };
          })
        }));
      }
      return res.status(200).json(parsed);

    } else {
      return res.status(400).json({ error: 'Ongeldige stap. Gebruik stap 1 of 2.' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
} 
