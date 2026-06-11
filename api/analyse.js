export const config = { api: { bodyParser: true } };

// ─── ESCO selectie ────────────────────────────────────────────────────────────
function selectEscoSkills(functietitel, taken, escoData, maxSize=300) {
  if (!escoData || !escoData.length) return [];
  const titleWords = functietitel.toLowerCase().split(' ').filter(w => w.length > 3);
  const takenWords = [...new Set(taken.flatMap(t => t.toLowerCase().split(' ').filter(w => w.length > 4)))];
  
  const scored = [];
  for (const s of escoData) {
    const label = s[0].toLowerCase();
    let score = titleWords.reduce((a, w) => a + (label.includes(w) ? 3 : 0), 0);
    score += takenWords.reduce((a, w) => a + (label.includes(w) ? 1 : 0), 0);
    if (score > 0) scored.push([score, s]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  
  const selected = scored.slice(0, maxSize - 60).map(x => x[1]);
  const codes = new Set(selected.map(s => s[1]));
  for (const s of escoData) {
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
- Kopieer de naam EXACT zoals in de lijst (inclusief spaties en leestekens)
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
        // Exacte match
        const exact = escoLabelMap.get(name.toLowerCase());
        if (exact) return { code: exact, label: name };
        // Zoek in selectie
        const inSelection = escoSelection.find(s => s[0].toLowerCase() === name.toLowerCase());
        if (inSelection) return { code: inSelection[1], label: inSelection[0] };
        // Gedeeltelijke match in selectie
        const partial = escoSelection.find(s => s[0].toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(s[0].toLowerCase()));
        if (partial) return { code: partial[1], label: partial[0] };
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
