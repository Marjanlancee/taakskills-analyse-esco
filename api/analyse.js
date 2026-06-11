export const config = { api: { bodyParser: true } };

// ─── ESCO matching ────────────────────────────────────────────────────────────
function matchEsco(zoekterm, escoData) {
  if (!escoData || !zoekterm) return null;
  const q = zoekterm.toLowerCase().trim();
  
  // 1. Exacte match
  let m = escoData.find(s => s[0].toLowerCase() === q);
  if (m) return { label: m[0], code: m[1] };
  
  // 2. ESCO label zit volledig in zoekterm
  m = escoData.find(s => q.includes(s[0].toLowerCase()) && s[0].length > 6);
  if (m) return { label: m[0], code: m[1] };
  
  // 3. Zoekterm zit volledig in ESCO label
  m = escoData.find(s => s[0].toLowerCase().includes(q) && q.length > 5);
  if (m) return { label: m[0], code: m[1] };
  
  // 4. Woordoverlap scoring - gewogen op woordlengte
  const words = q.split(' ').filter(w => w.length > 3);
  if (words.length === 0) return null;
  
  let best = null, bestScore = 0;
  for (const s of escoData) {
    const sl = s[0].toLowerCase();
    // Score = som van lengtes van overeenkomende woorden
    let score = 0;
    for (const w of words) {
      if (sl.includes(w)) score += w.length;
    }
    // Bonus als ESCO label ook korte woorden deelt
    const escoWords = sl.split(' ').filter(w => w.length > 3);
    for (const ew of escoWords) {
      if (q.includes(ew)) score += ew.length * 0.5;
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  
  // Minimale score om valse matches te vermijden
  if (bestScore >= 6 && best) return { label: best[0], code: best[1] };
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

{"functietitel":"string","samenvatting":"string","vergelijkbare_titels":["string"],"taken":[{"id":1,"taak":"string","bron":"profiel|beroep|beide","frequentie":"dagelijks|wekelijks|maandelijks|incidenteel","belang":"hoog|middel|laag","vakmanschap":"hoog|middel|laag","geselecteerd":true}]}

Regels:
- 20-40 taken, actief geformuleerd
- bron: "profiel" als taak uit het functieprofiel komt, "beroep" als aangevuld vanuit beroepskennis, "beide" als beide
- Sorteer van meest naar minst relevant
- geselecteerd: true voor de top 15 meest relevante taken, false voor de rest`;
}

// ─── Prompt stap 2: Skills koppelen ──────────────────────────────────────────
function promptSkills(functietitel, taken, bedrijf, eigenTaal) {
  const eigenTermen = eigenTaal?.trim() 
    ? eigenTaal.split(/[,\n]/).map(t => t.trim()).filter(Boolean)
    : [];
  const eigenBlok = eigenTermen.length
    ? `\nBedrijfsskills van ${bedrijf||"dit bedrijf"} (ALLEEN deze termen krijgen bron:"bedrijf" en eigen:true): ${eigenTermen.join(", ")}\n`
    : "";
  const takenlijst = taken.map(t => `${t.id}. ${t.taak}`).join("\n");
  
  return `Je bent een expert in skills-based werken.
Functie: ${functietitel}
${eigenBlok}
Koppel voor elke taak hardskills en softskills. Gebruik drie bronnen:
- bron "profiel": skill staat expliciet in het functieprofiel/vacaturetekst
- bron "beroep": skill hoort bij het beroep/sector op basis van vakkennis
- bron "bedrijf": skill komt UITSLUITEND uit de opgegeven bedrijfsskills lijst

BELANGRIJK onderscheid:
- Hardskills = technische vaardigheden (wat iemand kan doen, bijv. "tekeningen lezen", "bekabeling aansluiten")
- Softskills = gedragscompetenties (hoe iemand werkt, bijv. "samenwerken", "communiceren", "nauwkeurigheid")
- Zet NOOIT technische skills bij softskills
- Softskills zijn altijd gedrag, houding of communicatie

Voor elke skill:
1. "skill" of "softskill" = vakjargon/praktijknaam
2. "esco_zoekterm" = officiële Nederlandse ESCO-naam
3. "bron" = profiel | beroep | bedrijf
4. "niveau" = Basis | Gevorderd | Expert
5. eigen:true ALLEEN als bron="bedrijf"

Taken:
${takenlijst}

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks.

{"taken":[{"id":1,"hardskills":[{"skill":"vakjargon","esco_zoekterm":"ESCO naam","niveau":"Basis|Gevorderd|Expert","toelichting":"kort","bron":"profiel|beroep|bedrijf","eigen":false}],"softskills":[{"softskill":"gedragscompetentie","esco_zoekterm":"ESCO naam","niveau":"Basis|Gevorderd|Expert","toelichting":"kort","bron":"profiel|beroep|bedrijf","eigen":false}]}]}

Regels:
- Per taak: 2-3 hardskills, 2 softskills
- GEEN kerncompetenties sectie
- Softskills zijn ALTIJD gedragscompetenties, nooit technisch
- eigen:true ALLEEN als de term letterlijk in de bedrijfsskills lijst staat
- Basis=uitvoerend, Gevorderd=zelfstandig, Expert=strategisch`;
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

      // ESCO matching voor hardskills EN softskills
      if (escoData && Array.isArray(escoData)) {
        parsed.taken = (parsed.taken || []).map(t => ({
          ...t,
          hardskills: (t.hardskills || []).map(s => {
            const match = matchEsco(s.esco_zoekterm || s.skill, escoData);
            return { ...s, esco_code: match?.code || null, esco_label: match?.label || null, esco_matched: !!match };
          }),
          softskills: (t.softskills || []).map(s => {
            const match = matchEsco(s.esco_zoekterm || s.softskill, escoData);
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
