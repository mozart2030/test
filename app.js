// app.js (es module) – نسخة الدُفَع الآمنة مع حساب التمدد العربي
import { saveState, loadState, clearAllState, saveChunk, loadChunk, saveZip, loadZip } from './storage.js';

const qs = id => document.getElementById(id);
const logBox = qs('logBox');
const startBtn = qs('startButton');
const clearBtn = qs('clearButton');
const progressBar = qs('progressBar');
const progressText = qs('progressText');
const downloadLink = qs('downloadLink');

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
let API_MODEL = "gemini-2.5-flash-lite";

// معاملات أمان الحجم
const AR_EXPANSION = 1.35;
const TOKEN_PER_EN_CHAR = 0.25;
const MAX_TOKEN = 1_000_000;
const SAFE_TOKEN = Math.floor(MAX_TOKEN * 0.9);

const MAX_CONCURRENCY = 3;
const CHUNK_SIZE = 10_000;
const MAX_RETRIES = 5;

let epubFile = null;
let fewShot = [];
let zipInMemory = null;

function writeLog(msg, type='info') {
  const d = document.createElement('div');
  d.textContent = `[${new Date().toLocaleTimeString('ar-EG')}] ${msg}`;
  if(type === 'error') d.style.color = '#dc3545';
  if(type === 'ok') d.style.color = '#28a745';
  logBox.prepend(d);
  while (logBox.children.length > 300) logBox.removeChild(logBox.lastChild);
}
function setProgress(pct, text) {
  progressBar.style.width = pct + '%';
  progressBar.textContent = Math.round(pct) + '%';
  progressText.textContent = text;
}
const sleep = ms => new Promise(r=>setTimeout(r, ms));

/* -------------- دمج الدفعات مع حساب الحجم -------------- */
function buildBatches(chapters) {
  const batches = [];
  let cur = { parts: [], idxMap: [], estTokens: 0 };

  chapters.forEach((ch, idx) => {
    const bodyMatch = ch.rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const inner = bodyMatch ? bodyMatch[1] : ch.rawHtml;
    const enTokens = Math.ceil(inner.length * TOKEN_PER_EN_CHAR);
    const arTokens = Math.ceil(enTokens * AR_EXPANSION);
    const total = enTokens + arTokens;

    if (cur.estTokens + total > SAFE_TOKEN && cur.parts.length > 0) {
      batches.push(cur);
      cur = { parts: [], idxMap: [], estTokens: 0 };
    }
    cur.parts.push(inner);
    cur.idxMap.push(idx);
    cur.estTokens += total;
  });
  if (cur.parts.length) batches.push(cur);
  return batches;
}

/* -------------- ترجمة دفعة واحدة -------------- */
async function translateBatch(apiKey, model, parts) {
  const prompt = "أنت مترجم روايات احترافي. ترجم التالي إلى العربية الفصحى، واحفظ HTML كما هو. أعد النصوص بنفس الترتيب مفصولاً بعلامة ### الفصل رقم\n\n"
    + parts.map((p, i) => `### الفصل ${i}\n${p}`).join('\n\n');

  const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(()=>({}));
      if (res.ok) {
        const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return txt.split(/### الفصل \d+\s*/g)
                  .map(s=>s.trim())
                  .filter(Boolean);
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = (2 ** attempt) * 1000 + Math.floor(Math.random()*400);
        writeLog(`⚠️ ${j?.error?.message||res.status} – إعادة محاولة بعد ${wait/1000}ث`,"error");
        await sleep(wait);
        continue;
      }
      throw new Error(j?.error?.message||`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err.message;
      const wait = (2 ** attempt) * 600 + Math.floor(Math.random()*300);
      writeLog(`⚠️ خطأ اتصال: ${lastErr} – إعادة محاولة بعد ${wait/1000}ث`,"error");
      await sleep(wait);
    }
  }
  throw new Error("تجاوزنا محاولات الاتصال: " + lastErr);
}

/* -------------- استخراج الفصول -------------- */
async function extractChaptersFromEpub(fileBlob) {
  setProgress(2, 'يفك ضغط EPUB وتحديد OPF...');
  if (typeof JSZip === 'undefined') throw new Error('مكتبة JSZip غير مُحملة');
  const zip = await JSZip.loadAsync(fileBlob);
  zipInMemory = zip;

  let opfPath = null;
  const containerPath = 'META-INF/container.xml';
  if (zip.file(containerPath)) {
    const contTxt = await zip.file(containerPath).async('text');
    const contDoc = new DOMParser().parseFromString(contTxt, 'application/xml');
    let rf = contDoc.getElementsByTagName('rootfile');
    if (!rf || rf.length === 0) rf = contDoc.getElementsByTagNameNS('*','rootfile');
    if (rf && rf[0]) opfPath = rf[0].getAttribute('full-path');
  } else {
    opfPath = Object.keys(zip.files).find(p=>p.toLowerCase().endsWith('.opf'));
  }
  if (!opfPath) throw new Error('لم يتم العثور على ملف OPF');

  const opfTxt = await zip.file(opfPath).async('text');
  const opfDoc = new DOMParser().parseFromString(opfTxt, 'application/xml');

  const manifest = {};
  [...opfDoc.getElementsByTagName('item')].forEach(it=>{
    const id = it.getAttribute('id'), href = it.getAttribute('href');
    if(id && href) manifest[id] = href;
  });
  const spine = [...opfDoc.getElementsByTagName('itemref')]
                 .map(ir=>ir.getAttribute('idref'))
                 .filter(Boolean);

  const baseDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/')+1) : '';
  const chapters = [];
  for (const idref of spine) {
    const href = manifest[idref];
    if (!href) continue;
    const full = baseDir + href;
    const entry = zip.file(full) || zip.file(href);
    if (!entry) continue;
    const rawHtml = await entry.async('text');
    chapters.push({ href: full, rawHtml, translatedBody: null });
  }
  if (chapters.length === 0) throw new Error('لم يتم إيجاد فصول');
  writeLog(`✅ استخرجنا ${chapters.length} فصل/عنصر من EPUB`, 'ok');
  return { zip, opfPath, chapters };
}

/* -------------- بناء EPUB النهائي -------------- */
async function buildTranslatedEpub(zip, title) {
  setProgress(95, 'يبني EPUB المترجم ...');
  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
  for (const path of Object.keys(zip.files)) {
    const f = zip.file(path);
    if (!f) continue;
    const content = await f.async('uint8array');
    out.file(path, content);
  }
  return out.generateAsync({type:'blob', mimeType:'application/epub+zip'});
}

/* -------------- منطق الاستئناف الكامل -------------- */
qs('epubFile').addEventListener('change', e => { epubFile = e.target.files[0]; writeLog('📥 اخترت: ' + (epubFile ? epubFile.name : 'لا شيء')); });
qs('fewFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if(!f) { fewShot = []; return; }
  try {
    const txt = await f.text();
    const parsed = JSON.parse(txt);
    if(!Array.isArray(parsed)) { writeLog('❌ ملف few-shot يجب أن يكون مصفوفة', 'error'); return; }
    fewShot = parsed.filter(p=>p && typeof p.en === 'string' && typeof p.ar === 'string');
    writeLog('✅ حملت ' + fewShot.length + ' نموذج ترجمة (few-shot)');
  } catch (err) {
    writeLog('❌ خطأ قراءة few-shot: ' + err.message, 'error');
    fewShot = [];
  }
});

clearBtn.addEventListener('click', async ()=> {
  if (!confirm('هل تريد فعلاً مسح حالة الاستئناف بالكامل؟')) return;
  await clearAllState();
  downloadLink.style.display = 'none';
  setProgress(0,'تم المسح');
  writeLog('🗑️ تم مسح حالة التخزين (IndexedDB).', 'info');
});

startBtn.addEventListener('click', startWorkflow);

async function startWorkflow() {
  try {
    if (!epubFile) { writeLog('❌ لم تختر ملف EPUB', 'error'); return; }
    const apiKey = qs('apiKey').value.trim();
    if (!apiKey) { writeLog('❌ ألصق مفتاح API أولًا', 'error'); return; }
    API_MODEL = qs('modelSelect').value.trim() || API_MODEL;
    startBtn.disabled = true;
    setProgress(1, 'يجهز العمل...');

    let extracted;
    if (!zipInMemory) {
      extracted = await extractChaptersFromEpub(epubFile);
    } else {
      extracted = { zip: zipInMemory, opfPath: state?.opfPath || 'OEBPS/content.opf', chapters: [] };
    }
    const zip = extracted.zip;
    const opfPath = extracted.opfPath;
    const chapters = extracted.chapters;
    const filename = epubFile.name;

    /* ------------ الدفعات الآمنة ------------ */
    const batches = buildBatches(chapters);
    writeLog(`✅ تم تجميع ${chapters.length} فصل في ${batches.length} دفعة`);
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      setProgress(30 + (b / batches.length) * 60, `ترجمة الدفعة ${b + 1}/${batches.length}`);
      let arParts;
      try {
        arParts = await translateBatch(apiKey, API_MODEL, batch.parts);
      } catch (err) {
        writeLog(`❌ فشلت الدفعة ${b + 1}: ${err.message}، أُحفظ نصوصًا أصلية`, "error");
        arParts = batch.parts; // fallback
      }
      /* حقن النتائج */
      batch.idxMap.forEach((chIdx, partIdx) => {
        const ch = chapters[chIdx];
        const bodyMatch = ch.rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        if (bodyMatch) {
          const arBody = arParts[partIdx] || bodyMatch[1];
          const newHtml = ch.rawHtml.replace(bodyMatch[1], arBody)
                                    .replace(/<html/i, '<html dir="rtl" lang="ar"');
          zip.file(ch.href, newHtml);
          ch.translatedBody = "DONE";
        }
      });
    }

    const title = filename.replace(/\.[^/.]+$/, '') + '_AR_Pro';
    const outBlob = await buildTranslatedEpub(zip, title);
    try { await saveZip(filename + '::translated', outBlob); } catch(e) {}
    const url = URL.createObjectURL(outBlob);
    downloadLink.href = url;
    downloadLink.download = title + '.epub';
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '⬇️ تنزيل EPUB المترجم: ' + downloadLink.download;
    setProgress(100, 'اكتمال — يمكنك التنزيل الآن');
    writeLog(`🎉 اكتمال الترجمة – ${chapters.length} فصل بـ${batches.length} دفعة.`, 'ok');
    await clearAllState();
  } catch (err) {
    writeLog('❌ فشلت العملية: ' + (err.message || err), 'error');
    setProgress(0, 'فشل');
  } finally {
    startBtn.disabled = false;
  }
}
