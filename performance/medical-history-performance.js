/* ============================================================
   MEDICAL HISTORY FEATURE — medical-history.js
   ============================================================
   Everything related to uploading and analyzing medical records:
   pattern-matching scan, AI analysis via Gemini, review-before-save UI,
   and the scoring functions that feed medical history into the
   biological age composite.

   DEPENDENCIES — this file assumes the following already exist from
   index.html's main <script> block, loaded BEFORE this file:
     - sb (Supabase client), currentUser, currentProfile (globals)
     - showToast(), todayStr()
     - extractTextFromPdf(), extractTextFromImage() (shared OCR/PDF reading)
     - parseLabText(), LAB_PARSE_PATTERNS, CORE_BIOMARKER_IDS (shared lab parsing)
     - renderCardList()
     - SUPABASE_URL, SUPABASE_KEY
     - The HTML elements: #medhistory-upload-btn, #medhistory-upload-input,
       #medhistory-use-ai, #medhistory-upload-status, #medhistory-saved-list,
       #medhistory-saved-empty

   Load this AFTER the main script's <script> tag closes, e.g.:
     <script src="medical-history.js"></script>
   ============================================================ */

/* Medical history keyword scan — deliberately narrow, literal keyword
   matching against known condition names and common medication names.
   This never attempts to interpret or diagnose anything from the document;
   it just flags mentions for the person to review and confirm themselves.
   Category keys map to the same categories used in Disease risk context. */
const MEDICAL_HISTORY_PATTERNS = [
  { key:'diabetes', label:'Type 2 diabetes', category:'cardiometabolic', patterns:[/type\s*2\s*diabetes/i, /\bt2dm\b/i, /diabetes mellitus/i, /\bmetformin\b/i] },
  { key:'prediabetes', label:'Prediabetes', category:'cardiometabolic', patterns:[/pre-?diabetes/i, /impaired glucose/i] },
  { key:'hypertension', label:'Hypertension (high blood pressure)', category:'cardiovascular', patterns:[/\bhypertension\b/i, /high blood pressure/i, /\blisinopril\b/i, /\bamlodipine\b/i, /\blosartan\b/i] },
  { key:'hyperlipidemia', label:'High cholesterol', category:'cardiovascular', patterns:[/hyperlipidemia/i, /high cholesterol/i, /\batorvastatin\b/i, /\brosuvastatin\b/i, /\bstatin\b/i] },
  { key:'heart_disease', label:'Heart disease', category:'cardiovascular', patterns:[/coronary artery disease/i, /\bcad\b/i, /myocardial infarction/i, /heart attack/i, /atrial fibrillation/i, /\bafib\b/i, /congestive heart failure/i, /\bchf\b/i] },
  { key:'thyroid', label:'Thyroid disorder', category:'other', patterns:[/hypothyroidism/i, /hyperthyroidism/i, /\blevothyroxine\b/i, /\bsynthroid\b/i] },
  { key:'cancer', label:'Cancer history', category:'cancer', patterns:[/\bcarcinoma\b/i, /\boncology\b/i, /\bchemotherapy\b/i, /\bmalignant\b/i, /\btumor\b/i] },
  { key:'depression_anxiety', label:'Depression or anxiety', category:'mental_health', patterns:[/\bdepression\b/i, /\banxiety\b/i, /\bsertraline\b/i, /\bfluoxetine\b/i, /\bescitalopram\b/i] },
  { key:'sleep_apnea', label:'Sleep apnea', category:'sleep', patterns:[/sleep apnea/i, /\bcpap\b/i] },
  { key:'kidney_disease', label:'Kidney disease', category:'other', patterns:[/chronic kidney disease/i, /\bckd\b/i, /renal insufficiency/i] },
  { key:'liver_disease', label:'Liver disease', category:'other', patterns:[/fatty liver/i, /\bnafld\b/i, /\bcirrhosis\b/i, /\bhepatitis\b/i] },
  { key:'autoimmune', label:'Autoimmune condition', category:'other', patterns:[/rheumatoid arthritis/i, /\blupus\b/i, /\bautoimmune\b/i] },
  { key:'asthma_copd', label:'Asthma or COPD', category:'other', patterns:[/\basthma\b/i, /\bcopd\b/i] },
];

const MEDICAL_HISTORY_SEVERITY = {
  diabetes: 20, prediabetes: 55, hypertension: 40, hyperlipidemia: 50,
  heart_disease: 15, thyroid: 75, cancer: 20, depression_anxiety: 55,
  sleep_apnea: 40, kidney_disease: 15, liver_disease: 20, autoimmune: 50,
  asthma_copd: 55,
};

/* Test-name matching used for de-duplication. Normalizes away punctuation,
   spacing, and case so "Glucose", "Glucose:", and "Glucose  " all count as
   the same test (that formatting noise was the actual cause of duplicate
   entries in practice). Deliberately NOT fuzzy/edit-distance matching —
   that was tried and reverted, because it silently merged clinically
   distinct tests that happen to differ by one character, e.g. "Cortisol
   AM" vs "Cortisol PM", or "Vitamin B12" vs "Vitamin B6": a false merge
   there means a real abnormal reading quietly disappears, which is worse
   than an occasional un-deduped near-duplicate surviving review. */
function normalizeTestName(name){
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}
function testNamesMatch(a, b){
  const na = normalizeTestName(a), nb = normalizeTestName(b);
  if(!na || !nb) return false;
  return na === nb;
}

function parseMedicalHistoryText(text){
  const found = [];
  MEDICAL_HISTORY_PATTERNS.forEach(item=>{
    if(item.patterns.some(re => re.test(text))){
      found.push(item);
    }
  });
  return found;
}

/* Scans for the two most common ways lab reports mark a result as abnormal:
   (1) a value followed by an explicit reference range, where the value
       falls outside it, and (2) an explicit flag word/letter (H, L, HIGH,
       LOW, ABNORMAL, CRITICAL) sitting next to a result.
   This is pattern-matching against common report formatting conventions,
   not real document comprehension — it will miss unusually formatted
   reports and can misfire on stray letters, which is exactly why every
   result goes through the same review-before-save step as everything else. */
function findOutOfRangeValues(text){
  const found = [];
  const rangePattern = /([A-Za-z][A-Za-z0-9 \-\/]{2,40}?)[\s:]+([\d.]+)\s*[A-Za-z\/%]*\s*[\(\[]?\s*(?:ref(?:erence)?[\s:]*)?([\d.]+)\s*(?:-|–|to)\s*([\d.]+)/gi;
  let m;
  let count = 0;
  while((m = rangePattern.exec(text)) !== null && count < 20){
    const name = m[1].trim().replace(/\s+/g,' ');
    const value = parseFloat(m[2]);
    const lo = parseFloat(m[3]);
    const hi = parseFloat(m[4]);
    if(isNaN(value) || isNaN(lo) || isNaN(hi) || lo >= hi) continue;
    if(name.length < 3 || /^\d+$/.test(name)) continue;
    if(value < lo || value > hi){
      if(found.some(f => testNamesMatch(f.name, name))) continue;
      found.push({ name, value, low: lo, high: hi, direction: value < lo ? 'low' : 'high' });
      count++;
    }
  }
  return found;
}

function findAbnormalFlags(text){
  const found = [];
  const lines = text.split('\n');
  // Anchored to "name  number  [unit]  flag" — the standard lab-report row
  // format (e.g. "Glucose  110  H" or "WBC  11.2  HIGH"). Requiring an
  // actual numeric result attached to the flag, rather than just matching
  // the flag word/letter anywhere on the line, is what stops this from
  // flagging ordinary prose like "high stress" or "low back pain" or a
  // line that happens to start with "A ..." as an abnormal lab value.
  // The unit group is lazy (*?) on purpose: greedy would happily eat into
  // "HIGH" itself (backtracking down to "HIG" + flag "H"), silently
  // truncating the flag word — lazy tries consuming nothing first, so it
  // only eats real unit text like "mg/dL" sitting before the flag.
  const rowPattern = /^([A-Za-z][A-Za-z0-9 \-\/,\.]{2,40}?)[\s:]+(\d+\.?\d*)\s*[A-Za-z\/%µ]*?\s*[\(\[]?\s*(HIGH|LOW|ABNORMAL|CRITICAL|H|L|A)\)?\]?\s*$/i;
  lines.forEach(line=>{
    const trimmed = line.trim();
    if(trimmed.length < 4 || trimmed.length > 140) return;
    const m = trimmed.match(rowPattern);
    if(!m) return;
    const rawFlag = m[3];
    // Word flags (HIGH/LOW/ABNORMAL/CRITICAL) are fine case-insensitively —
    // anchored to a name+number they're specific enough. Single-letter
    // flags (H/L/A) stay uppercase-only, same as the original intent:
    // lowercase single letters are too common to trust even when a number
    // happens to precede them.
    if(rawFlag.length === 1 && rawFlag !== rawFlag.toUpperCase()) return;
    const name = m[1].trim().replace(/\s+/g,' ');
    if(name.length < 3 || /^\d+$/.test(name)) return;
    if(found.some(f => testNamesMatch(f.name, name))) return;
    found.push({ name, value: m[2], flag: rawFlag.toUpperCase() });
  });
  return found.slice(0, 20);
}

// Calls a Supabase Edge Function that securely holds the Gemini API key and
// does the actual document analysis server-side.
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/analyze-medical-record`;
async function analyzeWithAI(text){
  const res = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify({ text }),
  });
  if(!res.ok){
    const errBody = await res.text();
    throw new Error(`AI analysis isn't set up yet, or the request failed (${res.status}). ${errBody.slice(0,150)}`);
  }
  return res.json();
}

function renderSavedMedicalHistory(){
  const listEl = document.getElementById('medhistory-saved-list');
  const emptyEl = document.getElementById('medhistory-saved-empty');
  if(!listEl) return;

  let conditions = [];
  let findings = [];
  try{ if(currentProfile && currentProfile.medical_history) conditions = JSON.parse(currentProfile.medical_history); } catch(e){}
  try{ if(currentProfile && currentProfile.medical_history_findings) findings = JSON.parse(currentProfile.medical_history_findings); } catch(e){}

  if(conditions.length === 0 && findings.length === 0){
    emptyEl.classList.remove('hidden');
    listEl.innerHTML = '';
    return;
  }
  emptyEl.classList.add('hidden');

  const rows = [];
  conditions.forEach((c,i) => rows.push({ html: `${c.label}`, removeType: 'condition', removeIdx: i }));
  findings.forEach((f,i) => {
    let html;
    if(f.type === 'range') html = `${f.name}: ${f.value} (outside ${f.low}-${f.high})`;
    else if(f.type === 'flag') html = `${f.name} — flagged ${f.flag}`;
    else html = `${f.label}${f.bodyArea ? ` (${f.bodyArea})` : ''} — <span style="text-transform:capitalize;">${f.severity||'moderate'}</span>`;
    rows.push({ html, removeType: 'finding', removeIdx: i });
  });

  listEl.innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px;">
      <span>${r.html}</span>
      <button type="button" class="food-entry-del" data-remove-type="${r.removeType}" data-remove-idx="${r.removeIdx}" title="Remove">×</button>
    </div>
  `).join('');
}

document.addEventListener('click', async (e)=>{
  if(e.target && e.target.dataset && e.target.dataset.removeType){
    const type = e.target.dataset.removeType;
    const idx = parseInt(e.target.dataset.removeIdx);
    let conditions = [];
    let findings = [];
    try{ if(currentProfile && currentProfile.medical_history) conditions = JSON.parse(currentProfile.medical_history); } catch(err){}
    try{ if(currentProfile && currentProfile.medical_history_findings) findings = JSON.parse(currentProfile.medical_history_findings); } catch(err){}

    if(type === 'condition') conditions.splice(idx, 1);
    else findings.splice(idx, 1);

    const { error } = await sb.from('profiles').upsert({
      user_id: currentUser.id,
      medical_history: JSON.stringify(conditions),
      medical_history_findings: JSON.stringify(findings),
    });
    if(error){ showToast('Error: ' + error.message); return; }
    currentProfile.medical_history = JSON.stringify(conditions);
    currentProfile.medical_history_findings = JSON.stringify(findings);
    renderSavedMedicalHistory();
    showToast('Removed.');
  }
});

function renderMedHistoryReview({ conditions = [], outOfRange = [], flagged = [], summary = null, medications = [], filledLabs = [], stillMissing = [], openFindings = [] }, statusEl){
  const openFindingsHtml = openFindings.length ? `
    <div class="field-note" style="margin:12px 0 6px;font-weight:600;">Other findings across the document (imaging, scans, notes)</div>
    <div id="medhistory-review-open" style="display:flex;flex-direction:column;gap:8px;font-size:13px;margin-bottom:12px;">
      ${openFindings.map((f,i) => `<label style="display:flex;align-items:flex-start;gap:8px;"><input type="checkbox" checked style="margin-top:3px;" data-idx="${i}" data-label="${f.label}" data-bodyarea="${f.bodyArea||''}" data-severity="${f.severity||'moderate'}" data-note="${f.note||''}"> <span><strong>${f.label}</strong>${f.bodyArea ? ` (${f.bodyArea})` : ''} — <span style="text-transform:capitalize;">${f.severity||'moderate'}</span>${f.note ? `. ${f.note}` : ''}</span></label>`).join('')}
    </div>
  ` : '';

  const conditionsHtml = conditions.length ? `
    <div class="field-note" style="margin:12px 0 6px;font-weight:600;">Conditions &amp; medications mentioned</div>
    <div id="medhistory-review-conditions" style="display:flex;flex-direction:column;gap:8px;font-size:13px;margin-bottom:12px;">
      ${conditions.map(item => `<label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" checked data-key="${item.key}" data-label="${item.label}" data-category="${item.category}"> ${item.label}</label>`).join('')}
    </div>
  ` : '';

  const rangeHtml = outOfRange.length ? `
    <div class="field-note" style="margin:12px 0 6px;font-weight:600;">Values outside their stated reference range</div>
    <div id="medhistory-review-range" style="display:flex;flex-direction:column;gap:8px;font-size:13px;margin-bottom:12px;">
      ${outOfRange.map(v => `<label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" checked data-name="${v.name}" data-value="${v.value}" data-low="${v.low}" data-high="${v.high}" data-direction="${v.direction}"> ${v.name}: ${v.value}${v.high ? ` (reference ${v.low || '?'}-${v.high})` : ''}${v.direction ? ` — ${v.direction}` : ''}</label>`).join('')}
    </div>
  ` : '';

  const flaggedHtml = flagged.length ? `
    <div class="field-note" style="margin:12px 0 6px;font-weight:600;">Results marked with a flag (H/L/High/Low/Abnormal)</div>
    <div id="medhistory-review-flagged" style="display:flex;flex-direction:column;gap:8px;font-size:13px;margin-bottom:12px;">
      ${flagged.map(f => `<label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" checked data-name="${f.name}" data-flag="${f.flag}" data-value="${f.value||''}"> ${f.name}${f.value ? `: ${f.value}` : ''} — flagged ${f.flag}</label>`).join('')}
    </div>
  ` : '';

  const filledLabsHtml = filledLabs.length ? `
    <div class="field-note" style="margin:12px 0 6px;font-weight:600;color:var(--good);">Filled in on the biomarkers form above</div>
    <div class="field-note" style="margin-bottom:12px;">${filledLabs.join(', ')} — scroll up to double-check these against your actual document before moving on.</div>
  ` : '';

  const missingHtml = stillMissing.length ? `
    <div class="field-note" style="margin:12px 0 6px;font-weight:600;color:var(--danger);">Still missing for your biological age estimate</div>
    <div class="field-note" style="margin-bottom:12px;">${stillMissing.join(', ')} — these weren't found in this document. If you have them from somewhere else, add them on the biomarkers form above; otherwise your age estimate will just use whatever you do have.</div>
  ` : (filledLabs.length ? `<div class="field-note" style="margin-bottom:12px;color:var(--good);">Nothing else needed — every biomarker used in your biological age estimate was found in this document.</div>` : '');

  const medsHtml = medications.length ? `<div class="field-note" style="margin:0 0 12px;">Medications mentioned: ${medications.join(', ')}</div>` : '';
  const summaryHtml = summary ? `<div class="field-note" style="margin-bottom:12px;font-style:italic;">"${summary}"</div>` : '';

  if(!conditions.length && !outOfRange.length && !flagged.length && !openFindings.length){
    statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;">Didn't find any conditions or flagged results to review. ${summaryHtml}${filledLabsHtml}${missingHtml}You can still add anything relevant manually below.</div>`;
    return;
  }

  statusEl.innerHTML = `
    <div class="field-note" style="margin-top:12px;">Review carefully and uncheck anything wrong, false, or irrelevant before saving.</div>
    ${summaryHtml}${medsHtml}${filledLabsHtml}${missingHtml}${conditionsHtml}${rangeHtml}${flaggedHtml}${openFindingsHtml}
    <button type="button" class="btn btn-primary btn-sm" id="medhistory-save-btn">Save to my profile</button>
  `;
}

document.getElementById('medhistory-upload-input').addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files);
  if(files.length === 0) return;
  const statusEl = document.getElementById('medhistory-upload-status');

  try{
    let combinedText = '';
    const skipped = [];

    for(let i = 0; i < files.length; i++){
      const file = files[i];
      const fileLabel = files.length > 1 ? `File ${i+1} of ${files.length} (${file.name})` : file.name;
      statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;">Reading ${fileLabel}…</div>`;

      let text = '';
      if(file.type === 'application/pdf'){
        text = await extractTextFromPdf(file);
        if(text.trim().length < 20){
          statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;">${fileLabel}: no selectable text found — running OCR instead, this can take a moment…</div>`;
          text = await extractTextFromImage(file, pct => {
            statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;">${fileLabel}: running OCR… ${pct}%</div>`;
          });
        }
      } else if(file.type.startsWith('image/')){
        text = await extractTextFromImage(file, pct => {
          statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;">${fileLabel}: running OCR… ${pct}%</div>`;
        });
      } else {
        skipped.push(file.name);
        continue;
      }

      combinedText += `\n\n--- Document ${i+1}: ${file.name} ---\n\n${text}`;
    }

    if(combinedText.trim().length === 0){
      statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;color:var(--danger);">Couldn't read any of those files${skipped.length ? ` (unsupported type: ${skipped.join(', ')})` : ''}. Please upload PDFs or photos (JPG/PNG).</div>`;
      return;
    }
    const skippedNote = skipped.length ? ` (skipped unsupported file${skipped.length>1?'s':''}: ${skipped.join(', ')})` : '';
    const text = combinedText;

    if(document.getElementById('medhistory-use-ai').checked){
      statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;">Sending ${files.length > 1 ? `${files.length} documents` : 'document'} to AI for analysis${skippedNote}…</div>`;
      let aiResult;
      try{
        aiResult = await analyzeWithAI(text);
      } catch(aiErr){
        statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;color:var(--danger);">${aiErr.message} Falling back to the pattern-match scan instead.</div>`;
        aiResult = null;
      }
      if(aiResult){
        const filledLabs = parseLabText(text);
        const stillMissing = LAB_PARSE_PATTERNS
          .filter(p => CORE_BIOMARKER_IDS.includes(p.id))
          .filter(p => { const el = document.getElementById(p.id); return el && el.value === ''; })
          .map(p => p.label);
        renderMedHistoryReview({
          conditions: (aiResult.conditions || []).map(c => ({ key: c.label.toLowerCase().replace(/[^a-z0-9]+/g,'_'), label: c.label, category: c.category || 'other' })),
          outOfRange: (aiResult.abnormalValues || []).map(v => ({ name: v.name, value: v.value, low: '', high: v.range || '', direction: v.note || '' })),
          flagged: [],
          openFindings: aiResult.findings || [],
          summary: aiResult.summary,
          medications: aiResult.medications || [],
          filledLabs,
          stillMissing,
        }, statusEl);
        return;
      }
    }

    // Fill in the actual biomarker fields directly from the document,
    // same as the "Upload labs" button does — no reason to make someone
    // retype values that are already sitting in the file they just uploaded.
    const filledLabs = parseLabText(text);

    const conditions = parseMedicalHistoryText(text);
    const outOfRange = findOutOfRangeValues(text);
    // A single abnormal result often gets caught by both scans (e.g. "LDL
    // 8 (ref 10-30) L" has both a reference range and a flag letter on the
    // same line) — keep the range version since it carries the actual
    // bounds, and drop the flag version for any test already captured there.
    const flagged = findAbnormalFlags(text).filter(f => !outOfRange.some(r => testNamesMatch(r.name, f.name)));

    // Only the core biomarkers that actually drive the biological age
    // calculation — check what's still blank after the autofill above, so
    // we ask for exactly what's missing rather than everything by default.
    const stillMissing = LAB_PARSE_PATTERNS
      .filter(p => CORE_BIOMARKER_IDS.includes(p.id))
      .filter(p => { const el = document.getElementById(p.id); return el && el.value === ''; })
      .map(p => p.label);

    if(conditions.length === 0 && outOfRange.length === 0 && flagged.length === 0 && filledLabs.length === 0){
      statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;">Didn't find any recognized conditions, medications, lab values, or flagged results in ${files.length > 1 ? 'those files' : 'that file'}${skippedNote}. This is a pattern-match scan, not a full read of the document — worth adding anything relevant manually below if you know it's in there.</div>`;
      return;
    }

    renderMedHistoryReview({ conditions, outOfRange, flagged, filledLabs, stillMissing }, statusEl);
  } catch(err){
    statusEl.innerHTML = `<div class="field-note" style="margin-top:12px;color:var(--danger);">Couldn't finish reading those files (${err.message}). Try clearer photos or different PDFs.</div>`;
  } finally {
    e.target.value = '';
  }
});

document.addEventListener('click', async (e)=>{
  if(e.target && e.target.id === 'medhistory-save-btn'){
    const conditionChecks = Array.from(document.querySelectorAll('#medhistory-review-conditions input[type=checkbox]:checked'));
    const conditionEntries = conditionChecks.map(cb => ({ key: cb.dataset.key, label: cb.dataset.label, category: cb.dataset.category }));

    const rangeChecks = Array.from(document.querySelectorAll('#medhistory-review-range input[type=checkbox]:checked'));
    const rangeEntries = rangeChecks.map(cb => ({ name: cb.dataset.name, value: cb.dataset.value, low: cb.dataset.low, high: cb.dataset.high, direction: cb.dataset.direction }));

    const flaggedChecks = Array.from(document.querySelectorAll('#medhistory-review-flagged input[type=checkbox]:checked'));
    const flaggedEntries = flaggedChecks.map(cb => ({ name: cb.dataset.name, flag: cb.dataset.flag, value: cb.dataset.value || null }));

    const openChecks = Array.from(document.querySelectorAll('#medhistory-review-open input[type=checkbox]:checked'));
    const openEntries = openChecks.map(cb => ({ label: cb.dataset.label, bodyArea: cb.dataset.bodyarea, severity: cb.dataset.severity, note: cb.dataset.note }));

    const existingConditions = (currentProfile && currentProfile.medical_history) ? JSON.parse(currentProfile.medical_history) : [];
    const mergedConditions = [...existingConditions];
    conditionEntries.forEach(entry => { if(!mergedConditions.some(m => m.key === entry.key)) mergedConditions.push(entry); });

    // Same test can easily show up again across re-uploads or overlapping
    // documents — dedupe by the actual test identity, not exact string
    // match, since OCR/extraction reproduces the same test name slightly
    // differently between uploads (a dropped letter, an extra space, a
    // trailing colon).
    const findingIdentity = f => f.type === 'open' ? (f.label || '') : (f.name || '');
    const findingsMatch = (a, b) => {
      // "open" findings (imaging/narrative, from the AI path) are a
      // different kind of thing from a lab value and are only compared
      // against other "open" findings on the same body area.
      if(a.type === 'open' || b.type === 'open'){
        return a.type === 'open' && b.type === 'open'
          && testNamesMatch(findingIdentity(a), findingIdentity(b))
          && (a.bodyArea||'').toLowerCase().trim() === (b.bodyArea||'').toLowerCase().trim();
      }
      // "range" and "flag" both describe the same kind of thing — a single
      // abnormal lab value — just caught by different patterns, so the
      // same test counts as a duplicate across those two types too.
      return testNamesMatch(findingIdentity(a), findingIdentity(b));
    };
    const existingFindings = (currentProfile && currentProfile.medical_history_findings) ? JSON.parse(currentProfile.medical_history_findings) : [];
    const newFindings = [
      ...rangeEntries.map(r=>({type:'range', ...r})),
      ...flaggedEntries.map(f=>({type:'flag', ...f})),
      ...openEntries.map(f=>({type:'open', ...f})),
    ];
    const mergedFindings = [...existingFindings];
    newFindings.forEach(f => {
      if(mergedFindings.some(existing => findingsMatch(existing, f))) return;
      mergedFindings.push(f);
    });

    const { error } = await sb.from('profiles').upsert({
      user_id: currentUser.id,
      medical_history: JSON.stringify(mergedConditions),
      medical_history_findings: JSON.stringify(mergedFindings),
    });
    if(error){ showToast('Error: ' + error.message); return; }
    if(currentProfile){
      currentProfile.medical_history = JSON.stringify(mergedConditions);
      currentProfile.medical_history_findings = JSON.stringify(mergedFindings);
    } else {
      currentProfile = { medical_history: JSON.stringify(mergedConditions), medical_history_findings: JSON.stringify(mergedFindings) };
    }
    const totalChecked = conditionEntries.length + newFindings.length;
    const totalSaved = (mergedConditions.length - existingConditions.length) + (mergedFindings.length - existingFindings.length);
    const skippedNote = totalSaved > 0 && totalSaved < totalChecked ? ' (some were already on file and skipped as duplicates)' : '';
    let statusMsg;
    if(totalSaved > 0){
      statusMsg = `<div class="field-note" style="margin-top:12px;color:var(--good);">Saved ${totalSaved} item${totalSaved>1?'s':''} to your profile${skippedNote}. This now feeds into your Disease risk context and Next steps on the results page.</div>`;
    } else if(totalChecked === 0){
      statusMsg = `<div class="field-note" style="margin-top:12px;">Nothing was checked, so nothing was saved.</div>`;
    } else {
      statusMsg = `<div class="field-note" style="margin-top:12px;">Everything you checked was already on file — nothing new to save.</div>`;
    }
    document.getElementById('medhistory-upload-status').innerHTML = statusMsg;
    renderSavedMedicalHistory();
    showToast('Medical history saved.');
  }
});

function getMedicalHistoryByCategory(category){
  if(!currentProfile || !currentProfile.medical_history) return [];
  try{
    const items = JSON.parse(currentProfile.medical_history);
    return items.filter(i => i.category === category).map(i => i.label);
  } catch(e){ return []; }
}

function computeMedicalHistoryScore(){
  if(!currentProfile || !currentProfile.medical_history) return null;
  let items;
  try{ items = JSON.parse(currentProfile.medical_history); } catch(e){ return null; }
  if(!items || items.length === 0) return null;
  const scores = items.map(i => MEDICAL_HISTORY_SEVERITY[i.key] ?? 60);
  return scores.reduce((a,b)=>a+b,0) / scores.length;
}

// Scores the raw out-of-range/flagged/open findings pulled from uploaded
// records. "open" findings come from the AI path with a real severity
// rating; "range"/"flag" findings come from the regex path with no
// severity info, so those use a flat penalty per item instead.
function computeRawFindingsScore(){
  if(!currentProfile || !currentProfile.medical_history_findings) return null;
  let findings;
  try{ findings = JSON.parse(currentProfile.medical_history_findings); } catch(e){ return null; }
  if(!findings || findings.length === 0) return null;

  const OPEN_SEVERITY_SCORE = { mild: 88, moderate: 60, significant: 25 };
  const flatCount = findings.filter(f => f.type !== 'open').length;
  const openScores = findings.filter(f => f.type === 'open').map(f => OPEN_SEVERITY_SCORE[f.severity] ?? 60);

  const flatScore = flatCount > 0 ? Math.max(40, 100 - flatCount * 9) : null;
  const openAvg = openScores.length > 0 ? openScores.reduce((a,b)=>a+b,0) / openScores.length : null;

  if(flatScore !== null && openAvg !== null) return (flatScore + openAvg) / 2;
  return flatScore !== null ? flatScore : openAvg;
}
