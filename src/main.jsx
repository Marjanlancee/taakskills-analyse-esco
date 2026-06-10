import { useState } from "react";

const buildSystemPrompt = (bedrijfsnaam, eigenTaal) => {
  const eigenTaalBlok = eigenTaal.trim() ? `
Het bedrijf heet: ${bedrijfsnaam || "onbekend"}.
De organisatie hanteert de volgende eigen competentietaal — verwerk deze termen waar relevant als skills of competenties, en markeer ze met "eigen": true:
${eigenTaal}
` : "";

  return `Je bent een expert in functie-analyse en skills-based werken.
Je krijgt een functieprofiel en genereert een gestructureerde breakdown.
${eigenTaalBlok}
BELANGRIJK: Geef ALLEEN een geldig JSON-object terug. Geen tekst ervoor of erna. Geen markdown. Geen backticks. Puur JSON.

Geef dit exacte JSON-formaat terug:
{
  "functietitel": "string",
  "samenvatting": "string",
  "taken": [
    {
      "id": 1,
      "taak": "string",
      "taak_skills": [
        {
          "skill": "Nederlandse skillnaam",
          "niveau": "Basis|Gevorderd|Expert",
          "esco_label": "English ESCO skill label",
          "eigen": false
        }
      ],
      "generieke_competenties": [
        { "competentie": "string", "toelichting": "string", "eigen": false }
      ]
    }
  ],
  "kerncompetenties": [
    { "competentie": "string", "definitie": "string", "eigen": false }
  ]
}

Regels:
- Genereer 5-8 taken
- Per taak: 2-4 skills, 2-3 generieke competenties
- Kerncompetenties: 4-5 stuks
- niveau is altijd exact: Basis, Gevorderd, of Expert
- Basis: skill op uitvoerend niveau, onder begeleiding
- Gevorderd: skill wordt zelfstandig toegepast in complexe situaties
- Expert: skill op strategisch niveau, begeleidt anderen
- esco_label is de Engelse ESCO-taxonomienaam
- eigen: true alleen als de skill/competentie uit de eigen competentietaal van het bedrijf komt
- Formuleer taken actief en specifiek`;
};

const NIVEAUS = ["Basis", "Gevorderd", "Expert"];

const NIVEAU = {
  Basis:     { kleur: "#d8f3dc", tekst: "#2d6a4f", border: "#74c69d", dot: "#2d6a4f", desc: "Uitvoerend, onder begeleiding" },
  Gevorderd: { kleur: "#fef3d0", tekst: "#7a5c00", border: "#e8c96a", dot: "#c4860a", desc: "Zelfstandig, complexe situaties" },
  Expert:    { kleur: "#fce4e4", tekst: "#9b2226", border: "#e07070", dot: "#9b2226", desc: "Strategisch, begeleidt anderen" },
};

function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch {}
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error("Kon geen geldig JSON vinden in de respons");
}

function EigenBadge() {
  return (
    <span style={{background:"#f3e8ff",color:"#6b21a8",border:"1px solid #c084fc",padding:"1px 6px",borderRadius:2,fontSize:9,marginLeft:5,letterSpacing:"0.04em"}}>
      Eigen
    </span>
  );
}

export default function App() {
  const [bedrijfsnaam, setBedrijfsnaam] = useState("");
  const [eigenTaal, setEigenTaal] = useState("");
  const [eigenTaalOpen, setEigenTaalOpen] = useState(false);
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [niveauOverrides, setNiveauOverrides] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("taken");
  const [expandedTask, setExpandedTask] = useState(null);

  const analyse = async () => {
    if (!input.trim()) return;
    setLoading(true); setError(null); setResult(null); setExpandedTask(null); setNiveauOverrides({}); setSelectedSkills({});
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: buildSystemPrompt(bedrijfsnaam, eigenTaal),
          messages: [{ role: "user", content: `Analyseer dit functieprofiel:\n\n${input}` }],
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`API fout ${response.status}: ${err?.error?.message || response.statusText}`);
      }
      const data = await response.json();
      const text = (data.content || []).map(i => i.text || "").join("");
      const parsed = extractJSON(text);
      setResult(parsed);
      setActiveTab("taken");
    } catch (err) {
      setError(err.message || "Analyse mislukt");
    } finally {
      setLoading(false);
    }
  };

  const getSkillNiveau = (taakId, skillNaam, original) => {
    const key = `${taakId}-${skillNaam}`;
    return niveauOverrides[key] !== undefined ? niveauOverrides[key] : original;
  };

  const setSkillNiveau = (taakId, skillNaam, niveau) => {
    const key = `${taakId}-${skillNaam}`;
    setNiveauOverrides(prev => ({ ...prev, [key]: niveau }));
  };

  const allSkills = result
    ? [...new Map(
        result.taken.flatMap(t =>
          t.taak_skills.map(s => ({
            ...s,
            niveau: getSkillNiveau(t.id, s.skill, s.niveau),
            taakId: t.id,
          }))
        ).map(s => [s.skill, s])
      ).values()]
    : [];

  const niveauOrder = { Expert: 0, Gevorderd: 1, Basis: 2 };
  const changedCount = Object.keys(niveauOverrides).length;
  const heeftEigenTaal = eigenTaal.trim().length > 0;

  const [selectedSkills, setSelectedSkills] = useState({});

  const toggleSkill = (key) => setSelectedSkills(prev => ({ ...prev, [key]: !prev[key] }));

  const allHardSkills = result
    ? [...new Map(result.taken.flatMap(t => t.taak_skills.map(s => ({
        ...s, niveau: getSkillNiveau(t.id, s.skill, s.niveau), type: "hard"
      }))).map(s => [s.skill, s])).values()]
    : [];

  const allSoftSkills = result
    ? [...new Map(result.taken.flatMap(t => t.generieke_competenties.map(c => ({
        skill: c.competentie, niveau: "Gevorderd", esco_label: "", eigen: c.eigen || false, type: "soft"
      }))).map(s => [s.skill, s])).values()]
    : [];

  const selectedHard = allHardSkills.filter(s => selectedSkills[`hard-${s.skill}`]);
  const selectedSoft = allSoftSkills.filter(s => selectedSkills[`soft-${s.skill}`]);
  const totalSelected = selectedHard.length + selectedSoft.length;

  const exportPDF = () => {
    const w = window.open("", "_blank");
    const hardList = selectedHard.map(s => `<tr><td>${s.skill}</td><td>${s.eigen ? "Eigen" : "ESCO"}</td><td>${s.niveau}</td></tr>`).join("");
    const softList = selectedSoft.map(s => `<tr><td>${s.skill}</td><td>${s.eigen ? "Eigen" : "ESCO"}</td><td>—</td></tr>`).join("");
    w.document.write(`<!DOCTYPE html><html><head><title>Skillset — ${result.functietitel}</title>
    <style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;color:#1a1714;font-size:13px}h1{font-size:22px;font-style:italic;margin-bottom:4px}h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;margin:24px 0 10px;color:#7a7060}p{color:#7a7060;font-size:12px;margin-bottom:20px}table{width:100%;border-collapse:collapse;margin-bottom:24px}th{text-align:left;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#7a7060;padding:6px 10px;border-bottom:2px solid #d8d2c4}td{padding:8px 10px;border-bottom:1px solid #f0ede6;font-size:12px}.footer{margin-top:40px;font-size:10px;color:#a89f8c;border-top:1px solid #d8d2c4;padding-top:12px}</style>
    </head><body>
    <h1>${result.functietitel}</h1>
    <p>${bedrijfsnaam ? `${bedrijfsnaam} · ` : ""}Definitieve skillset · ${selectedHard.length} hardskills · ${selectedSoft.length} softskills</p>
    <h2>Hardskills (${selectedHard.length})</h2>
    <table><thead><tr><th>Skill</th><th>Bron</th><th>Niveau</th></tr></thead><tbody>${hardList}</tbody></table>
    <h2>Softskills / Competenties (${selectedSoft.length})</h2>
    <table><thead><tr><th>Competentie</th><th>Bron</th><th>Niveau</th></tr></thead><tbody>${softList}</tbody></table>
    <div class="footer">Gegenereerd met Functieprofiel Decompositor · ESCO-aligned</div>
    <script>window.onload=()=>{window.print()}<\/script></body></html>`);
    w.document.close();
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist+Mono:wght@300;400;500&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        :root{--bg:#f5f2eb;--surface:#fffef9;--border:#d8d2c4;--border-s:#a89f8c;--text:#1a1714;--muted:#7a7060;--serif:'Instrument Serif',Georgia,serif;--mono:'Geist Mono','Courier New',monospace}
        body{background:var(--bg);color:var(--text);font-family:var(--mono)}
        .app{min-height:100vh}
        .header{border-bottom:1px solid var(--border);padding:26px 44px 22px;display:flex;align-items:flex-end;justify-content:space-between;background:var(--surface)}
        .site-title{font-family:var(--serif);font-size:28px;line-height:1;font-style:italic}
        .site-title span{font-style:normal}
        .eyebrow{font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
        .header-r{font-size:10px;color:var(--muted);text-align:right;line-height:1.8;letter-spacing:.1em}
        .main{display:flex;min-height:calc(100vh - 82px)}
        .sidebar{width:320px;flex-shrink:0;border-right:1px solid var(--border);padding:24px 20px;background:var(--surface);display:flex;flex-direction:column;gap:14px;overflow-y:auto}
        .slabel{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:6px}
        input.field{font-family:var(--mono);font-size:12px;background:var(--bg);border:1px solid var(--border);color:var(--text);outline:none;padding:9px 12px;border-radius:2px;width:100%;transition:border-color .2s}
        input.field:focus{border-color:var(--border-s)}
        input.field::placeholder{color:var(--border-s)}
        textarea{font-family:var(--mono);font-size:12px;line-height:1.7;background:var(--bg);border:1px solid var(--border);color:var(--text);resize:none;outline:none;padding:12px 14px;border-radius:2px;width:100%;transition:border-color .2s}
        textarea:focus{border-color:var(--border-s)}
        textarea::placeholder{color:var(--border-s)}
        .btn-a{width:100%;padding:11px;background:var(--text);color:var(--bg);border:none;font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;border-radius:2px;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .15s}
        .btn-a:hover:not(:disabled){opacity:.82}
        .btn-a:disabled{opacity:.3;cursor:not-allowed}
        .btn-ghost{background:none;border:1px solid var(--border);color:var(--muted);font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:8px;cursor:pointer;border-radius:2px;width:100%;transition:all .15s}
        .btn-ghost:hover{border-color:var(--border-s);color:var(--text)}
        .spin{width:13px;height:13px;border:1.5px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
        @keyframes spin{to{transform:rotate(360deg)}}
        .err{border:1px solid #e07070;background:#fce4e4;color:#9b2226;padding:10px 12px;font-size:11px;line-height:1.5;border-radius:2px;word-break:break-word}
        .legend{border-top:1px solid var(--border);padding-top:14px;margin-top:auto}
        .li{display:flex;align-items:center;gap:8px;font-size:10px;margin-bottom:8px}
        .ld{width:8px;height:8px;border-radius:50%;flex-shrink:0}
        .content{flex:1;display:flex;flex-direction:column;overflow:hidden}
        .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
        .empty-g{font-family:var(--serif);font-style:italic;font-size:60px;color:var(--border);line-height:1}
        .empty-t{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);opacity:.6}
        .ls{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
        .ls-t{font-family:var(--serif);font-style:italic;font-size:20px;color:var(--muted)}
        .lb{width:160px;height:1px;background:var(--border);position:relative;overflow:hidden}
        .lb::after{content:'';position:absolute;left:-60%;width:60%;height:100%;background:var(--text);animation:slide 1.1s ease-in-out infinite}
        @keyframes slide{0%{left:-60%}100%{left:160%}}
        .rh{border-bottom:1px solid var(--border);padding:20px 28px;background:var(--surface)}
        .rt{font-family:var(--serif);font-style:italic;font-size:22px;margin-bottom:2px}
        .rs{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px}
        .rm{display:flex;gap:16px;font-size:10px;color:var(--muted);flex-wrap:wrap;align-items:center}
        .rm strong{color:var(--text)}
        .tabs{display:flex;border-bottom:1px solid var(--border);background:var(--surface)}
        .tab{padding:12px 22px;font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);cursor:pointer;margin-bottom:-1px;transition:all .15s}
        .tab:hover{color:var(--text)}
        .tab.active{color:var(--text);border-bottom-color:var(--text)}
        .tc{flex:1;overflow-y:auto;padding:22px 28px}
        .tk{border:1px solid var(--border);background:var(--surface);border-radius:2px;margin-bottom:7px;overflow:hidden;transition:border-color .15s}
        .tk:hover{border-color:var(--border-s)}
        .tk.open{border-color:var(--text)}
        .tkh{display:flex;align-items:flex-start;gap:14px;padding:12px 14px;cursor:pointer;user-select:none}
        .tnum{font-size:10px;color:var(--muted);flex-shrink:0;width:22px;margin-top:1px}
        .tbody{flex:1;min-width:0}
        .tname{font-size:13px;line-height:1.5;margin-bottom:7px}
        .tchev{font-size:9px;color:var(--muted);flex-shrink:0;margin-top:3px}
        .tex{border-top:1px solid var(--border);padding:14px 14px 16px 50px;background:var(--bg);display:flex;flex-direction:column;gap:14px}
        .secl{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
        .pills{display:flex;flex-wrap:wrap;gap:6px}
        .pill{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:2px;font-size:10px;border:1px solid}
        .pd{width:5px;height:5px;border-radius:50%;flex-shrink:0}
        .eb{background:#e8f0fe;color:#1a56db;border:1px solid #93b4fd;padding:1px 6px;border-radius:2px;font-size:9px;margin-left:5px}
        .ci{display:flex;gap:10px;margin-bottom:6px}
        .cb{color:#c4860a;flex-shrink:0;font-size:10px;margin-top:1px}
        .cn{font-size:12px;font-weight:500}
        .cd{font-size:11px;color:var(--muted);margin-top:1px}
        .sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:7px}
        .sb{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:2px;border:1px solid;font-size:11px}
        .sn{flex:1}
        .se{font-size:9px;opacity:.6;margin-top:2px}
        .snv{font-size:9px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;flex-shrink:0}
        .kc{border:1px solid var(--border);background:var(--surface);padding:14px 16px;display:flex;gap:14px;border-radius:2px;margin-bottom:8px}
        .kn{font-size:10px;color:var(--muted);width:22px;flex-shrink:0}
        .km{font-family:var(--serif);font-style:italic;font-size:17px;margin-bottom:4px}
        .kd{font-size:12px;color:var(--muted);line-height:1.6}
        .fi{animation:fi .3s ease forwards}
        @keyframes fi{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        .changed-badge{background:#fef3d0;color:#7a5c00;border:1px solid #e8c96a;padding:1px 7px;border-radius:2px;font-size:9px;margin-left:2px}
        .eigen-badge-sm{background:#f3e8ff;color:#6b21a8;border:1px solid #c084fc;padding:1px 6px;border-radius:2px;font-size:9px;margin-left:2px}
        .skill-editor{border:1px solid var(--border);background:var(--surface);border-radius:2px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
        .skill-editor-top{display:flex;align-items:center;gap:8px}
        .skill-editor-name{font-size:12px;flex:1}
        .skill-editor-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:2px;font-size:10px;border:1px solid;flex-shrink:0}
        .slider-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--muted);margin-top:3px}
        input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;outline:none;cursor:pointer;background:var(--border)}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:var(--text);cursor:pointer;border:2px solid var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.2)}
        input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--text);cursor:pointer;border:2px solid var(--surface)}
        .was-changed{font-size:9px;color:var(--muted);margin-left:4px;opacity:.7}
        .toggle-btn{display:flex;align-items:center;justify-content:space-between;width:100%;background:none;border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:9px 12px;cursor:pointer;border-radius:2px;transition:all .15s}
        .toggle-btn:hover{border-color:var(--border-s)}
        .toggle-btn.active{border-color:#c084fc;color:#6b21a8;background:#f3e8ff}
        .bedrijf-header{font-size:10px;color:var(--muted);margin-bottom:4px}
        .bedrijf-naam{font-family:var(--serif);font-style:italic;font-size:14px;color:var(--text)}
      `}</style>

      <div className="app">
        <header className="header">
          <div>
            <div className="eyebrow">ESCO-aligned · Skills Analyse Tool</div>
            <div className="site-title"><span>Functie</span>profiel<br /><em>Decompositor</em></div>
          </div>
          <div className="header-r">
            {result && bedrijfsnaam ? (
              <>
                <div className="bedrijf-header">Analyse voor</div>
                <div className="bedrijf-naam">{bedrijfsnaam}</div>
              </>
            ) : (
              <>Skills · Taken<br />Competenties</>
            )}
          </div>
        </header>

        <div className="main">
          <aside className="sidebar">

            {/* Eigen competentietaal */}
            <div>
              <button
                className={`toggle-btn ${eigenTaalOpen ? "active" : ""}`}
                onClick={() => setEigenTaalOpen(o => !o)}
              >
                <span>Eigen competentietaal</span>
                <span>{eigenTaalOpen ? "▲" : "▼"}{heeftEigenTaal && <span className="eigen-badge-sm" style={{marginLeft:6}}>Actief</span>}</span>
              </button>
              {eigenTaalOpen && (
                <div style={{border:"1px solid #c084fc",borderTop:"none",borderRadius:"0 0 2px 2px",padding:12,background:"#fdf9ff",display:"flex",flexDirection:"column",gap:10}}>
                  <div>
                    <label className="slabel" style={{color:"#6b21a8"}}>Bedrijfsnaam</label>
                    <input
                      className="field"
                      value={bedrijfsnaam}
                      onChange={e => setBedrijfsnaam(e.target.value)}
                      placeholder="bijv. Acme B.V."
                    />
                  </div>
                  <div>
                    <label className="slabel" style={{color:"#6b21a8"}}>Eigen termen & competenties</label>
                    <textarea
                      rows={4}
                      value={eigenTaal}
                      onChange={e => setEigenTaal(e.target.value)}
                      placeholder={"bijv. Continu verbeteren,\nVeilig werken,\nKlantpartnerschap,\nEigenaarschap"}
                      style={{minHeight:"auto",fontSize:11}}
                    />
                    <div style={{fontSize:9,color:"#6b21a8",marginTop:4,lineHeight:1.5}}>
                      Komma- of regelgescheiden. Deze termen worden meegenomen in de analyse en apart gemarkeerd met <span style={{background:"#f3e8ff",border:"1px solid #c084fc",padding:"0 4px",borderRadius:2}}>Eigen</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Functieprofiel */}
            <div>
              <label className="slabel">Functieprofiel invoer</label>
              <textarea
                rows={8}
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={"Plak hier een functieprofiel,\nvacaturetekst of\ntaakomschrijving..."}
              />
            </div>

            <button className="btn-a" onClick={analyse} disabled={loading || !input.trim()}>
              {loading ? <><span className="spin" />Analyseren...</> : "Analyseer Functie →"}
            </button>

            {result && <>
              <button className="btn-ghost" onClick={() => { setResult(null); setInput(""); setExpandedTask(null); setNiveauOverrides({}); }}>↺ Nieuw profiel</button>
              {changedCount > 0 && (
                <button className="btn-ghost" onClick={() => setNiveauOverrides({})}>↺ Niveaus resetten ({changedCount})</button>
              )}
              <div style={{background:"#fef3d0",border:"1px solid #e8c96a",borderRadius:2,padding:"10px 12px",fontSize:10,color:"#7a5c00",lineHeight:1.7}}>
                <div style={{fontWeight:600,marginBottom:4}}>💡 Zo werkt de tool</div>
                <div>1. Ga naar <strong>Taken & Skills</strong></div>
                <div>2. Klik op een taak om hem open te klappen</div>
                <div>3. Sleep de slider per skill naar het gewenste niveau</div>
                <div>4. Wijzigingen zijn direct zichtbaar in <strong>Skills Overzicht</strong></div>
              </div>
            </>}

            {error && <div className="err">⚠ {error}</div>}

            <div className="legend">
              <label className="slabel">Niveaulegenda</label>
              {Object.entries(NIVEAU).map(([label, d]) => (
                <div key={label} className="li">
                  <div className="ld" style={{background: d.dot}} />
                  <div>
                    <div style={{color: d.tekst, fontWeight: 500}}>{label}</div>
                    <div style={{fontSize: 9, color: "var(--muted)", marginTop: 1}}>{d.desc}</div>
                  </div>
                </div>
              ))}
              {heeftEigenTaal && (
                <div className="li" style={{marginTop:4}}>
                  <div className="ld" style={{background:"#c084fc"}} />
                  <div>
                    <div style={{color:"#6b21a8",fontWeight:500}}>Eigen</div>
                    <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>Uit eigen competentietaal</div>
                  </div>
                </div>
              )}
            </div>
          </aside>

          <main className="content">
            {loading && <div className="ls"><div className="ls-t">Profiel wordt geanalyseerd…</div><div className="lb" /><div style={{fontSize:10,color:"var(--muted)",letterSpacing:"0.12em",textTransform:"uppercase"}}>Even geduld</div></div>}
            {!loading && !result && (
              <div className="empty">
                <div className="empty-g">Σ</div>
                <div className="empty-t">Plak een functieprofiel om te beginnen</div>
                {heeftEigenTaal && (
                  <div style={{fontSize:10,color:"#6b21a8",background:"#f3e8ff",border:"1px solid #c084fc",padding:"6px 12px",borderRadius:2,marginTop:4}}>
                    Eigen competentietaal van <strong>{bedrijfsnaam || "dit bedrijf"}</strong> is actief
                  </div>
                )}
              </div>
            )}

            {!loading && result && (
              <div className="fi" style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
                <div className="rh">
                  <div className="rt">{result.functietitel}</div>
                  <div className="rs">{result.samenvatting}</div>
                  <div className="rm">
                    <span><strong>{result.taken.length}</strong>&nbsp;taken</span>
                    <span><strong>{allSkills.length}</strong>&nbsp;skills</span>
                    <span><strong>{result.kerncompetenties.length}</strong>&nbsp;kerncompetenties</span>
                    {changedCount > 0 && <span className="changed-badge">✎ {changedCount} aangepast</span>}
                    {heeftEigenTaal && <span className="eigen-badge-sm">Eigen taal actief</span>}
                  </div>
                </div>
                <div className="tabs">
                  {[["taken","Taken & Skills"],["skills","Skills Overzicht"],["kern","Kerncompetenties"],["definitief","Definitieve Skillset"]].map(([k,l]) => (
                    <button key={k} className={`tab ${activeTab===k?"active":""}`} onClick={() => setActiveTab(k)}>{l}</button>
                  ))}
                </div>

                <div className="tc">
                  {activeTab === "taken" && <div className="fi">
                    {result.taken.map((t, i) => (
                      <div key={t.id} className={`tk ${expandedTask===i?"open":""}`}>
                        <div className="tkh" onClick={() => setExpandedTask(expandedTask===i?null:i)}>
                          <div className="tnum">{String(t.id).padStart(2,"0")}</div>
                          <div className="tbody">
                            <div className="tname">{t.taak}</div>
                            {expandedTask!==i && <div className="pills">
                              {t.taak_skills.slice(0,3).map(s => {
                                const n = getSkillNiveau(t.id, s.skill, s.niveau);
                                const d = NIVEAU[n];
                                return <span key={s.skill} className="pill" style={{background: s.eigen ? "#f3e8ff" : d.kleur, color: s.eigen ? "#6b21a8" : d.tekst, borderColor: s.eigen ? "#c084fc" : d.border}}>
                                  <span className="pd" style={{background: s.eigen ? "#c084fc" : d.dot}}/>{s.skill}
                                </span>;
                              })}
                              {t.taak_skills.length>3 && <span className="pill" style={{borderColor:"var(--border)",color:"var(--muted)"}}>+{t.taak_skills.length-3}</span>}
                            </div>}
                          </div>
                          <div className="tchev">{expandedTask===i?"▲":"▼"}</div>
                        </div>
                        {expandedTask===i && <div className="tex">
                          <div>
                            <div className="secl">Taak-specifieke skills</div>
                            <div style={{fontSize:10,color:"var(--muted)",marginBottom:10,lineHeight:1.5}}>Sleep de slider om het niveau aan te passen. Bij wijziging zie je het origineel tussen haakjes.</div>
                            <div style={{display:"flex",flexDirection:"column",gap:10}}>
                              {t.taak_skills.map(s => {
                                const currentNiveau = getSkillNiveau(t.id, s.skill, s.niveau);
                                const d = NIVEAU[currentNiveau];
                                const sliderVal = NIVEAUS.indexOf(currentNiveau);
                                const isChanged = currentNiveau !== s.niveau;
                                return (
                                  <div key={s.skill} className="skill-editor" style={{borderColor: s.eigen ? "#c084fc" : "var(--border)"}}>
                                    <div className="skill-editor-top">
                                      <span className="pd" style={{background: s.eigen ? "#c084fc" : d.dot, width:7, height:7}}/>
                                      <div className="skill-editor-name">
                                        {s.skill}
                                        {s.eigen && <EigenBadge />}
                                        {!s.eigen && s.esco_label && <span className="eb">ESCO: {s.esco_label}</span>}
                                        {isChanged && <span className="was-changed">(was: {s.niveau})</span>}
                                      </div>
                                      <span className="skill-editor-badge" style={{background:d.kleur,color:d.tekst,borderColor:d.border}}>
                                        {currentNiveau}
                                      </span>
                                    </div>
                                    <div>
                                      <input
                                        type="range"
                                        min={0} max={2} step={1}
                                        value={sliderVal}
                                        style={{background: `linear-gradient(to right, ${s.eigen ? "#c084fc" : d.dot} 0%, ${s.eigen ? "#c084fc" : d.dot} ${sliderVal*50}%, var(--border) ${sliderVal*50}%, var(--border) 100%)`}}
                                        onChange={e => setSkillNiveau(t.id, s.skill, NIVEAUS[parseInt(e.target.value)])}
                                      />
                                      <div className="slider-labels">
                                        <span>Basis</span><span>Gevorderd</span><span>Expert</span>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <div className="secl">Generieke competenties</div>
                            {t.generieke_competenties.map(c => (
                              <div key={c.competentie} className="ci">
                                <span className="cb">◆</span>
                                <div>
                                  <div className="cn">{c.competentie}{c.eigen && <EigenBadge />}</div>
                                  <div className="cd">{c.toelichting}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>}
                      </div>
                    ))}
                  </div>}

                  {activeTab === "skills" && <div className="fi">
                    {heeftEigenTaal && (() => {
                      const eigenSkills = allSkills.filter(s => s.eigen);
                      const escoSkills = allSkills.filter(s => !s.eigen).sort((a,b)=>niveauOrder[a.niveau]-niveauOrder[b.niveau]);
                      return <>
                        {eigenSkills.length > 0 && <div style={{marginBottom:20}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                            <span className="eigen-badge-sm" style={{marginLeft:0}}>Eigen</span>
                            <span style={{fontSize:10,color:"var(--muted)"}}>Competentietaal van <strong style={{color:"var(--text)"}}>{bedrijfsnaam || "dit bedrijf"}</strong></span>
                          </div>
                          <div className="sg">{eigenSkills.map(s => {
                            const d = NIVEAU[s.niveau];
                            return <div key={s.skill} className="sb" style={{background:"#f3e8ff",color:"#6b21a8",borderColor:"#c084fc"}}>
                              <span className="pd" style={{background:"#c084fc"}}/>
                              <div className="sn">{s.skill}</div>
                              <span className="snv">{s.niveau}</span>
                            </div>;
                          })}</div>
                        </div>}
                        <div style={{marginBottom:10}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                            <span className="eb" style={{marginLeft:0}}>ESCO</span>
                            <span style={{fontSize:10,color:"var(--muted)"}}>Gestandaardiseerde ESCO-skills</span>
                            {changedCount>0 && <span className="changed-badge">✎ {changedCount} aangepast</span>}
                          </div>
                          <div className="sg">{escoSkills.map(s => {
                            const d = NIVEAU[s.niveau];
                            return <div key={s.skill} className="sb" style={{background:d.kleur,color:d.tekst,borderColor:d.border}}>
                              <span className="pd" style={{background:d.dot}}/>
                              <div className="sn">{s.skill}{s.esco_label && <div className="se">{s.esco_label}</div>}</div>
                              <span className="snv">{s.niveau}</span>
                            </div>;
                          })}</div>
                        </div>
                      </>;
                    })()}
                    {!heeftEigenTaal && <>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,fontSize:10,color:"var(--muted)"}}>
                        <span className="eb" style={{marginLeft:0}}>ESCO</span> ESCO-label
                        {changedCount>0 && <span className="changed-badge">✎ {changedCount} aangepast</span>}
                      </div>
                      <div className="sg">{allSkills.sort((a,b)=>niveauOrder[a.niveau]-niveauOrder[b.niveau]).map(s => {
                        const d = NIVEAU[s.niveau];
                        return <div key={s.skill} className="sb" style={{background:d.kleur,color:d.tekst,borderColor:d.border}}>
                          <span className="pd" style={{background:d.dot}}/>
                          <div className="sn">{s.skill}{s.esco_label && <div className="se">{s.esco_label}</div>}</div>
                          <span className="snv">{s.niveau}</span>
                        </div>;
                      })}</div>
                    </>}
                  </div>}

                  {activeTab === "kern" && <div className="fi">
                    {result.kerncompetenties.map((k,i) => (
                      <div key={k.competentie} className="kc" style={{borderColor: k.eigen ? "#c084fc" : "var(--border)"}}>
                        <div className="kn">{String(i+1).padStart(2,"0")}</div>
                        <div>
                          <div className="km">{k.competentie}{k.eigen && <EigenBadge />}</div>
                          <div className="kd">{k.definitie}</div>
                        </div>
                      </div>
                    ))}
                  </div>}

                  {activeTab === "definitief" && <div className="fi">
                    {/* Header met tellers */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
                      <div style={{display:"flex",gap:12,fontSize:11}}>
                        <span style={{background: selectedHard.length > 10 ? "#fce4e4" : selectedHard.length >= 8 ? "#d8f3dc" : "var(--bg)", border:"1px solid var(--border)",padding:"4px 12px",borderRadius:2,color: selectedHard.length > 10 ? "#9b2226" : selectedHard.length >= 8 ? "#2d6a4f" : "var(--muted)"}}>
                          Hardskills: <strong>{selectedHard.length}</strong> / 8–10
                        </span>
                        <span style={{background: selectedSoft.length > 6 ? "#fce4e4" : selectedSoft.length >= 5 ? "#d8f3dc" : "var(--bg)", border:"1px solid var(--border)",padding:"4px 12px",borderRadius:2,color: selectedSoft.length > 6 ? "#9b2226" : selectedSoft.length >= 5 ? "#2d6a4f" : "var(--muted)"}}>
                          Softskills: <strong>{selectedSoft.length}</strong> / 5–6
                        </span>
                        <span style={{background: totalSelected === 15 ? "#d8f3dc" : totalSelected > 15 ? "#fce4e4" : "var(--bg)", border:"1px solid var(--border)",padding:"4px 12px",borderRadius:2,fontWeight:600,color: totalSelected === 15 ? "#2d6a4f" : totalSelected > 15 ? "#9b2226" : "var(--muted)"}}>
                          Totaal: {totalSelected} / 15
                        </span>
                      </div>
                      {totalSelected > 0 && (
                        <button onClick={exportPDF} style={{padding:"8px 16px",background:"var(--text)",color:"var(--bg)",border:"none",fontFamily:"var(--mono)",fontSize:10,letterSpacing:".12em",textTransform:"uppercase",cursor:"pointer",borderRadius:2,display:"flex",alignItems:"center",gap:6}}>
                          ↓ Exporteer als PDF
                        </button>
                      )}
                    </div>

                    {totalSelected > 15 && (
                      <div style={{background:"#fce4e4",border:"1px solid #e07070",color:"#9b2226",padding:"8px 12px",borderRadius:2,fontSize:11,marginBottom:12}}>
                        Je hebt meer dan 15 skills geselecteerd. Verwijder er een paar om op de definitieve set van 15 te komen.
                      </div>
                    )}

                    {/* Hardskills */}
                    <div style={{marginBottom:20}}>
                      <div className="secl" style={{marginBottom:10}}>Hardskills — selecteer 8 tot 10</div>
                      <div style={{display:"flex",flexDirection:"column",gap:6}}>
                        {allHardSkills.map(s => {
                          const key = `hard-${s.skill}`;
                          const selected = !!selectedSkills[key];
                          const d = NIVEAU[s.niveau];
                          return (
                            <div key={key} onClick={() => toggleSkill(key)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",border:`1px solid ${selected ? "var(--text)" : "var(--border)"}`,borderRadius:2,background: selected ? "var(--surface)" : "var(--bg)",cursor:"pointer",transition:"all .15s"}}>
                              <div style={{width:16,height:16,borderRadius:2,border:`1.5px solid ${selected ? "var(--text)" : "var(--border)"}`,background: selected ? "var(--text)" : "transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                {selected && <span style={{color:"var(--bg)",fontSize:10,lineHeight:1}}>✓</span>}
                              </div>
                              <span className="pd" style={{background: s.eigen ? "#c084fc" : d.dot}}/>
                              <div style={{flex:1,fontSize:12}}>{s.skill}{s.eigen && <EigenBadge />}</div>
                              <span style={{fontSize:10,padding:"2px 8px",borderRadius:2,border:"1px solid",background:d.kleur,color:d.tekst,borderColor:d.border}}>{s.niveau}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Softskills */}
                    <div>
                      <div className="secl" style={{marginBottom:10}}>Softskills / Competenties — selecteer 5 tot 6</div>
                      <div style={{display:"flex",flexDirection:"column",gap:6}}>
                        {allSoftSkills.map(s => {
                          const key = `soft-${s.skill}`;
                          const selected = !!selectedSkills[key];
                          return (
                            <div key={key} onClick={() => toggleSkill(key)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",border:`1px solid ${selected ? "var(--text)" : "var(--border)"}`,borderRadius:2,background: selected ? "var(--surface)" : "var(--bg)",cursor:"pointer",transition:"all .15s"}}>
                              <div style={{width:16,height:16,borderRadius:2,border:`1.5px solid ${selected ? "var(--text)" : "var(--border)"}`,background: selected ? "var(--text)" : "transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                {selected && <span style={{color:"var(--bg)",fontSize:10,lineHeight:1}}>✓</span>}
                              </div>
                              <span style={{width:5,height:5,borderRadius:"50%",background: s.eigen ? "#c084fc" : "#c4860a",flexShrink:0}}/>
                              <div style={{flex:1,fontSize:12}}>{s.skill}{s.eigen && <EigenBadge />}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>}
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  );
}
