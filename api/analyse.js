export const config = { api: { bodyParser: true } };

// ─── ESCO selectie ────────────────────────────────────────────────────────────
function selectEscoSkills(functietitel, taken, escoData, maxSize=250) {
  if (!escoData || !escoData.length) return [];
  // Filter: alleen zinvolle labels (min 10 tekens, minimaal 2 woorden)
  const filtered = escoData.filter(s => s[0].length > 10 && s[0].includes(' '));
  
  const titleWords = functietitel.toLowerCase().split(' ').filter(w => w.length > 3);
  const takenWords = [...new Set(taken.flatMap(t => t.toLowerCase().split(' ').filter(w => w.length > 4)))];
  
  const scored = [];
  for (const s of filtered) {
    const label = s[0].toLowerCase();
    let score = titleWords.reduce((a, w) => a + (label.includes(w) ? 3 : 0), 0);
    score += takenWords.reduce((a, w) => a + (label.includes(w) ? 1 : 0), 0);
    if (score > 0) scored.push([score, s]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  
  const selected = scored.slice(0, maxSize - 50).map(x => x[1]);
  const codes = new Set(selected.map(s => s[1]));
  // Voeg transversal toe (communiceren, samenwerken etc)
  for (const s of filtered) {
    if (s[2] === 'tr' && !codes.has(s[1]) && selected.length < maxSize) {
      selected.push(s); codes.add(s[1]);
    }
  }
  return selected;
}

// ─── Prompt stap 1: Taken ────────────────────────────────────────────────────
function promptTaken(bedrijf, eigenTaal) {
  const eigenBlok = eigenTaal?.trim()
    ? `\nHet bedrijf heet: ${bedrijf || 'onbekend'}.\nBedrijfsskills: ${eigenTaal}\n` : '';
  return `Je bent een expert in functie-analyse.
${eigenBlok}
Genereer 20-40 taken voor dit functieprofiel.

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks.

{"functietitel":"string","samenvatting":"string","vergelijkbare_titels":["string"],"taken":[{"id":1,"taak":"string","bron":"profiel|beroep|beide","frequentie":"dagelijks|wekelijks|maandelijks|incidenteel","belang":"hoog|middel|laag","vakmanschap":"hoog|middel|laag","geselecteerd":true}]}

- 20-40 taken, actief geformuleerd
- bron: "profiel"=uit vacaturetekst, "beroep"=aangevuld, "beide"=beide
- geselecteerd: true voor top 15, false voor de rest`;
}

// ─── Prompt stap 2: Skills via nummers ───────────────────────────────────────
function promptSkills(functietitel, taken, bedrijf, eigenTaal, escoSelection) {
  const eigenTermen = eigenTaal?.trim()
    ? eigenTaal.split(/[,\n]/).map(t => t.trim()).filter(Boolean) : [];
  const eigenBlok = eigenTermen.length
    ? `\nBedrijfsskills van ${bedrijf || 'dit bedrijf'} — gebruik de bedrijfsterm als skillnaam, maar kies het bijbehorende ESCO-nummer:\n${eigenTermen.join(', ')}\n` : '';

  // Numbered ESCO list
  const escoLijst = escoSelection.map(s => s[0]).join('\n');
  const takenlijst = taken.map(t => `${t.id}. ${t.taak}`).join('\n');

  return `Je bent een expert in skills-based werken.
Functie: ${functietitel}
${eigenBlok}
Koppel skills aan taken. Kies UITSLUITEND uit de onderstaande genummerde ESCO-lijst.
Geef het NUMMER terug (niet de naam, niet een code — alleen het nummer).

ESCO LIJST:
${escoLijst}

BELANGRIJK:
- Hardskills = technische vaardigheden (WAT iemand doet)
- Softskills = gedragscompetenties (HOE iemand werkt: communiceren, samenwerken, nauwkeurig)
- Nooit technische skills bij softskills
- Bronnen: "profiel"=staat in vacaturetekst, "beroep"=hoort bij beroep, "bedrijf"=bedrijfsskill

Taken:
${takenlijst}

GEEF ALLEEN GELDIG JSON TERUG. Geen uitleg, geen markdown, geen backticks.

{"taken":[{"id":1,"hardskills":[{"skill":"exacte naam uit lijst","niveau":"Basis|Gevorderd|Expert","toelichting":"kort","bron":"profiel|beroep|bedrijf","eigen":false}],"softskills":[{"softskill":"exacte naam uit lijst","niveau":"Basis|Gevorderd|Expert","toelichting":"kort","bron":"profiel|beroep|bedrijf","eigen":false}]}]}

- Per taak: 2-3 hardskills, 2 softskills  
- Kopieer de naam EXACT zoals in de lijst — inclusief alle woorden, spaties en leestekens
- Gebruik NOOIT een verkorte of aangepaste versie van de naam
- Voor bedrijfsskills: kies de best passende ESCO-naam, maar zet bron:"bedrijf" en eigen:true
- eigen:true ALLEEN voor bedrijfsskills`;
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
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8000, system: promptTaken(bedrijf, eigenTaal), messages: [{ role: 'user', content: `Analyseer dit functieprofiel:\n\n${functieprofiel}` }] })
      });
      const d = await r.json();
      if (d.error) return res.status(500).json({ error: d.error.message });
      const raw = (d.content || []).map(i => i.text || '').join('');
      let parsed;
      try { parsed = JSON.parse(raw.trim()); }
      catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); parsed = JSON.parse(raw.slice(a, b + 1)); }
      return res.status(200).json(parsed);

    } else if (stap === 2) {
      if (!taken || !functietitel) return res.status(400).json({ error: 'Geen taken meegegeven' });

      // Selecteer relevante ESCO skills
      const taakNamen = taken.map(t => t.taak);
      const escoSelection = selectEscoSkills(functietitel, taakNamen, escoData || [], 300);

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8000, system: promptSkills(functietitel, taken, bedrijf, eigenTaal, escoSelection), messages: [{ role: 'user', content: 'Koppel ESCO-skills aan de taken.' }] })
      });
      const d = await r.json();
      if (d.error) return res.status(500).json({ error: d.error.message });
      const raw = (d.content || []).map(i => i.text || '').join('');
      let parsed;
      try { parsed = JSON.parse(raw.trim()); }
      catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); parsed = JSON.parse(raw.slice(a, b + 1)); }

      // Vertaal namen naar ESCO codes via exacte lookup
      const escoLabelMap = new Map(escoData.map(s => [s[0].toLowerCase(), s[1]]));
      const eigenTermen = eigenTaal?.trim()
        ? eigenTaal.split(/[,\n]/).map(t => t.trim()).filter(Boolean) : [];

      const lookupCode = (name) => {
        if (!name) return null;
        const q = name.toLowerCase().trim();
        
        // 1. Exacte match in volledige database (100% betrouwbaar)
        const exact = escoLabelMap.get(q);
        if (exact) return { code: exact, label: name, confidence: 100 };
        
        // 2. Exacte match in selectie
        const inSel = escoSelection.find(s => s[0].toLowerCase() === q);
        if (inSel) return { code: inSel[1], label: inSel[0], confidence: 100 };
        
        // 3. Naam bevat ESCO-label (kortste = meest specifiek)
        const contains = escoData.filter(s => q.includes(s[0].toLowerCase()) && s[0].length > 10);
        if (contains.length) {
          contains.sort((a, b) => b[0].length - a[0].length);
          return { code: contains[0][1], label: contains[0][0], confidence: 85 };
        }
        
        // 4. ESCO-label bevat naam
        const reverse = escoData.filter(s => s[0].toLowerCase().includes(q) && q.length > 8);
        if (reverse.length) {
          reverse.sort((a, b) => a[0].length - b[0].length);
          return { code: reverse[0][1], label: reverse[0][0], confidence: 80 };
        }
        
        // 5. Woordoverlap in volledige database
        const words = q.split(' ').filter(w => w.length > 4);
        if (words.length >= 2) {
          let best = null, bestScore = 0;
          for (const s of escoData) {
            const sl = s[0].toLowerCase();
            const score = words.reduce((a, w) => a + (sl.includes(w) ? w.length : 0), 0);
            if (score > bestScore) { bestScore = score; best = s; }
          }
          if (bestScore >= 10 && best) return { code: best[1], label: best[0], confidence: 60 };
        }
        
        // Geen match gevonden
        return null;
      };

      parsed.taken = (parsed.taken || []).map(t => ({
        ...t,
        hardskills: (t.hardskills || []).map(s => {
          const isEigen = s.eigen || s.bron === 'bedrijf';
          const found = lookupCode(s.skill || '');
          return found
            ? { ...s, skill: isEigen ? (s.skill || found.label) : found.label, esco_code: found.code, esco_label: found.label, esco_matched: true, eigen: isEigen }
            : { ...s, esco_code: null, esco_label: null, esco_matched: false };
        }),
        softskills: (t.softskills || []).map(s => {
          const isEigen = s.eigen || s.bron === 'bedrijf';
          const found = lookupCode(s.softskill || '');
          return found
            ? { ...s, softskill: isEigen ? (s.softskill || found.label) : found.label, esco_code: found.code, esco_label: found.label, esco_matched: true, eigen: isEigen }
            : { ...s, esco_code: null, esco_label: null, esco_matched: false };
        })
      }));

      return res.status(200).json(parsed);

    } else {
      return res.status(400).json({ error: 'Ongeldige stap.' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
