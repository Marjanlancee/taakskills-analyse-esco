export const config = { api: { bodyParser: true } };

// ─── ESCO selectie op basis van functie ──────────────────────────────────────
function selectEscoSkills(functietitel, taken, escoData, maxSize=400) {
  if (!escoData || !escoData.length) return [];
  
  const titleWords = functietitel.toLowerCase().split(' ').filter(w => w.length > 3);
  const takenWords = [...new Set(taken.flatMap(t => t.toLowerCase().split(' ').filter(w => w.length > 4)))];
  
  // Score every skill
  const scored = [];
  for (const s of escoData) {
    const label = s[0].toLowerCase();
    let score = 0;
    for (const w of titleWords) if (label.includes(w)) score += 3;
    for (const w of takenWords) if (label.includes(w)) score += 1;
    if (score > 0) scored.push([score, s]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  
  const selected = scored.slice(0, maxSize - 80).map(x => x[1]);
  const codes = new Set(selected.map(s => s[1]));
  
  // Always add transversal skills (samenwerken, communiceren etc)
  for (const s of escoData) {
    if (s[2] === 'tr' && !codes.has(s[1])) {
      selected.push(s);
      codes.add(s[1]);
      if (selected.length >= maxSize) break;
    }
  }
  return selected;
}

// ─── ESCO matching ────────────────────────────────────────────────────────────
function matchEsco(zoekterm, escoData) {
  if (!escoData || !zoekterm) return null;
  const q = zoekterm.toLowerCase().trim();
  
  // 1. Exact match
  let m = escoData.find(s => s[0].toLowerCase() === q);
  if (m) return { label: m[0], code: m[1] };
  
  // 2. Zoekterm zit volledig in ESCO label (kortste match wint)
  const containsMatches = escoData.filter(s => s[0].toLowerCase().includes(q) && q.length > 5);
  if (containsMatches.length) {
    containsMatches.sort((a, b) => a[0].length - b[0].length); // kortste = meest specifiek
    return { label: containsMatches[0][0], code: containsMatches[0][1] };
  }
  
  // 3. ESCO label zit volledig in zoekterm (langste match wint)
  const reverseMatches = escoData.filter(s => q.includes(s[0].toLowerCase()) && s[0].length > 6);
  if (reverseMatches.length) {
    reverseMatches.sort((a, b) => b[0].length - a[0].length); // langste = meest specifiek
    return { label: reverseMatches[0][0], code: reverseMatches[0][1] };
  }
  
  // 4. Word overlap - gewogen, penalty voor irrelevante woorden
  const words = q.split(' ').filter(w => w.length > 3);
  if (!words.length) return null;
  
  let best = null, bestScore = 0;
  for (const s of escoData) {
    const sl = s[0].toLowerCase();
    const slWords = sl.split(' ').filter(w => w.length > 3);
    const matchedWords = words.filter(w => sl.includes(w));
    if (!matchedWords.length) continue;
    
    // Score = matched word length sum / total esco word count (precision)
    const matchScore = matchedWords.reduce((a, w) => a + w.length, 0);
    const precision = matchScore / (slWords.length + 1); // penalty for long ESCO labels
    
    if (precision > bestScore) { bestScore = precision; best = s; }
  }
  
  if (bestScore >= 3 && best) return { label: best[0], code: best[1] };
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
- bron: "profiel" als uit vacaturetekst, "beroep" als aangevuld vanuit beroepskennis, "beide" als beide
- Sorteer van meest naar minst relevant
- geselecteerd: true voor de top 15 meest relevante taken, false voor de rest`;
}

// ─── Prompt stap 2: Skills koppelen met ESCO lijst ───────────────────────────
function promptSkills(functietitel, taken, bedrijf, eigenTaal, escoSelection) {
  const eigenTermen = eigenTaal?.trim()
    ? eigenTaal.split(/[,\n]/).map(t => t.trim()).filter(Boolean)
    : [];
  const eigenBlok = eigenTermen.length
    ? `\nBedrijfsskills van ${bedrijf || 'dit bedrijf'}: ${eigenTermen.join(', ')}
BELANGRIJK voor bedrijfsskills:
- Gebruik de bedrijfsterm als "skill" veld (dit is de bedrijfsspecifieke naam)
- Zoek de best passende ESCO-skill uit de lijst hierboven
- Vul de OFFICIËLE ESCO-naam in het "skill" veld NIET in — gebruik alleen de bedrijfsterm
- Geef bron:"bedrijf" en eigen:true
- Voorbeeld: bedrijfsterm "veldbekabeling" → skill:"veldbekabeling", esco_code:"[code van bekabeling installeren]"\n`
    : '';
  const takenlijst = taken.map(t => `${t.id}. ${t.taak}`).join('\n');
  
  // Format ESCO selection as lookup table
  const escoLijst = escoSelection.slice(0, 350)
    .map(s => `${s[0]} | ${s[1]}`)
    .join('\n');

  return `Je bent een expert in skills-based werken.
Functie: ${functietitel}
${eigenBlok}

VERPLICHT: Gebruik UITSLUITEND de onderstaande ESCO-skills. Kies de best passende skill uit de lijst.
Geef voor elke skill de exacte naam en code zoals in de lijst staat.

ESCO SKILLS LIJST (naam | code):
${escoLijst}

BELANGRIJK onderscheid:
- Hardskills = technische vaardigheden (WAT iemand kan doen)
- Softskills = gedragscompetenties (HOE iemand werkt: communiceren, samenwerken, nauwkeurig zijn)
- Zet NOOIT technische skills bij softskills

Drie bronnen:
- bron "profiel": skill staat expliciet in de vacaturetekst
- bron "beroep": skill hoort bij het beroep op basis van vakkennis  
- bron "bedrijf": skill komt uit de bedrijfsskills lijst

Taken:
${takenlijst}

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks.

{"taken":[{"id":1,"hardskills":[{"skill":"exacte naam uit ESCO lijst hierboven","niveau":"Basis|Gevorderd|Expert","toelichting":"kort","bron":"profiel|beroep|bedrijf","eigen":false}],"softskills":[{"softskill":"exacte naam uit ESCO lijst hierboven","niveau":"Basis|Gevorderd|Expert","toelichting":"kort","bron":"profiel|beroep|bedrijf","eigen":false}]}]}

Regels:
- Per taak: 2-3 hardskills, 2 softskills
- Gebruik ALLEEN skillnamen uit de bovenstaande ESCO lijst
- Geef GEEN codes terug — codes worden automatisch opgezocht
- Voor bedrijfsskills: gebruik de bedrijfsterm als skillnaam (niet de ESCO naam)
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
      catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); parsed = JSON.parse(raw.slice(a, b + 1)); }
      return res.status(200).json(parsed);

    } else if (stap === 2) {
      if (!taken || !functietitel) return res.status(400).json({ error: 'Geen taken meegegeven' });
      
      // Select relevant ESCO skills based on function and tasks
      const taakNamen = taken.map(t => t.taak);
      const escoSelection = selectEscoSkills(functietitel, taakNamen, escoData || [], 400);
      
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 8000,
          system: promptSkills(functietitel, taken, bedrijf, eigenTaal, escoSelection),
          messages: [{ role: 'user', content: 'Koppel ESCO-skills aan deze taken.' }]
        })
      });
      const claudeData = await claudeRes.json();
      if (claudeData.error) return res.status(500).json({ error: claudeData.error.message });
      const raw = (claudeData.content || []).map(i => i.text || '').join('');
      let parsed;
      try { parsed = JSON.parse(raw.trim()); }
      catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); parsed = JSON.parse(raw.slice(a, b + 1)); }

      // Enrich met echte ESCO codes uit database - NOOIT Claude-gegenereerde codes gebruiken
      if (escoData && Array.isArray(escoData)) {
        const escoLabelMap = new Map(escoData.map(s => [s[0].toLowerCase(), s[1]]));
        
        const enrichSkill = (name) => {
          // Altijd opzoeken in database - nooit vertrouwen op Claude-code
          const exactCode = escoLabelMap.get(name.toLowerCase());
          if (exactCode) return { esco_code: exactCode, esco_label: name, esco_matched: true };
          const match = matchEsco(name, escoData);
          if (match) return { esco_code: match.code, esco_label: match.label, esco_matched: true };
          return { esco_code: null, esco_label: null, esco_matched: false };
        };
        
        parsed.taken = (parsed.taken || []).map(t => ({
          ...t,
          hardskills: (t.hardskills || []).map(s => ({ ...s, ...enrichSkill(s.skill) })),
          softskills: (t.softskills || []).map(s => ({ ...s, ...enrichSkill(s.softskill) }))
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
