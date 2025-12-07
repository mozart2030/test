// app.js (es module) – نسخة الدفعات (Batching) النهائية والآمنة
import { saveState, loadState, clearAllState, saveZip } from './storage.js';

const qs = id => document.getElementById(id);
const logBox = qs('logBox');
const startBtn = qs('startButton');
const clearBtn = qs('clearButton');
const progressBar = qs('progressBar');
const progressText = qs('progressText');
const downloadLink = qs('downloadLink');

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
let API_MODEL = "gemini-2.5-flash-lite";

// معاملات أمان الحجم (لتقدير التوكنات)
const AR_EXPANSION = 1.4;         // تقدير تمدد حجم النص عند الترجمة للعربية
const TOKEN_PER_EN_CHAR = 0.28;    // تقدير توكن لكل حرف إنجليزي
const MAX_TOKEN = 1_000_000;       // الحد الأقصى التقديري للتوكنات في الطلب
const SAFE_TOKEN = Math.floor(MAX_TOKEN * 0.85); // هامش أمان 15%

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
  const roundedPct = Math.min(100, Math.max(0, Math.round(pct)));
  progressBar.style.width = roundedPct + '%';
  progressBar.textContent = roundedPct + '%';
  progressText.textContent = text;
}
const sleep = ms => new Promise(r=>setTimeout(r, ms));

/* ------------------- دمج الفصول في دفعات آمنة ------------------- */
function buildBatches(chapters, fewShotText) {
  const batches = [];
  const fewShotSection = fewShotText ? fewShotText + '\n---\n' : '';
  const HEADER_TEXT = "أنت مترجم روايات محترف. ترجم التالي إلى العربية الفصحى، واحفظ HTML كما هو. أعد النصوص بنفس الترتيب مفصولاً بعلامة ### الفصل رقم. لا تضيف أي تفسيرات أو مقدمات.\n\n";
  const overheadTokens = Math.ceil((fewShotSection + HEADER_TEXT).length * TOKEN_PER_EN_CHAR);

  let cur = { parts: [], idxMap: [], estTokens: overheadTokens };

  chapters.forEach((ch, idx) => {
    if (ch.translatedBody === 'DONE') return;

    const bodyMatch = ch.rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const inner = bodyMatch ? bodyMatch[1] : ch.rawHtml;

    const enTokens = Math.ceil(inner.length * TOKEN_PER_EN_CHAR);
    const arTokens = Math.ceil(enTokens * AR_EXPANSION);
    const total = enTokens + arTokens;

    if (cur.estTokens + total > SAFE_TOKEN && cur.parts.length > 0) {
      batches.push(cur);
      cur = { parts: [], idxMap: [], estTokens: overheadTokens };
    }
    cur.parts.push(inner);
    cur.idxMap.push(idx);
    cur.estTokens += total;
  });
  if (cur.parts.length) batches.push(cur);
  return batches;
}

/* ------------------- ترجمة دفعة واحدة مع إعادة محاولة ------------------- */
async function translateBatch(apiKey, model, parts, fewShotText) {
  const fewShotSection = fewShotText ? fewShotText + '\n---\n' : '';
  const prompt = fewShotSection +
    "أنت مترجم روايات محترف. ترجم التالي إلى العربية الفصحى، واحفظ HTML كما هو. أعد النصوص بنفس الترتيب مفصولاً بعلامة ### الفصل رقم. لا تضيف أي تفسيرات أو مقدمات.\n\n" +
    parts.map((p, i) => `### الفصل ${i}\n${p}`).join('\n\n');

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
                  .filter(Boolean)
                  .map(p => p.replace(/^```(?:html|xml)?\n/i, '').replace(/\n```$/, '').trim());
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = (2 ** attempt) * 1000 + Math.floor(Math.random()*400);
        writeLog(`⚠️ ${j?.error?.message||res.status} – إعادة محاولة بعد ${wait/1000}ث`,"error");
        await sleep(wait);
        continue;
      }
      throw new Error(j?.error?.message||`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err.message || String(err);
      const wait = (2 ** attempt) * 600 + Math.floor(Math.random()*300);
      writeLog(`⚠️ خطأ اتصال: ${lastErr} – إعادة محاولة بعد ${wait/1000}ث`,"error");
      await sleep(wait);
    }
  }
  throw new Error("تجاوزنا محاولات الاتصال: " + lastErr);
}

/* ------------------- استخراج الفصول من EPUB ------------------- */
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
  if (chapters.length === 0) throw new Error('لم يتم إيجاد فصول قابلة للترجمة');
  writeLog(`✅ استخرجنا ${chapters.length} فصل/عنصر من EPUB`, 'ok');
  return { zip, opfPath, chapters };
}

/* ------------------- بناء EPUB النهائي ------------------- */
async function buildTranslatedEpub(zip) {
  setProgress(95, 'يبني EPUB المترجم ...');
  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
  for (const path of Object.keys(zip.files)) {
    if (path === 'mimetype') continue;
    const f = zip.file(path);
    if (!f) continue;
    const content = await f.async('uint8array');
    out.file(path, content);
  }
  return out.generateAsync({type:'blob', mimeType:'application/epub+zip'});
}

/* ------------------- منطق التفعيل ------------------- */
qs('epubFile').addEventListener('change', e => { epubFile = e.target.files[0]; writeLog('📥 اخترت: ' + (epubFile ? epubFile.name : 'لا شيء')); });
qs('fewFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if(!f) { fewShot = []; writeLog('ℹ️ تم إلغاء Few-Shot'); return; }
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
  zipInMemory = null;
  downloadLink.style.display = 'none';
  setProgress(0,'تم المسح');
  writeLog('🗑️ تم مسح حالة التخزين (IndexedDB).', 'info');
});

startBtn.addEventListener('click', startWorkflow);

async function startWorkflow() {
  // تأكيد تفعيل الزرار قبل أي عملية
  document.getElementById('startButton').disabled = false;

  try {
    if (!epubFile) { writeLog('❌ لم تختر ملف EPUB', 'error'); return; }
    const apiKey = qs('apiKey').value.trim();
    if (!apiKey) { writeLog('❌ ألصق مفتاح API أولًا', 'error'); return; }
    API_MODEL = qs('modelSelect').value.trim() || API_MODEL;
    startBtn.disabled = true;
    setProgress(1, 'يجهز العمل...');

    // استخراج الفصول من EPUB
    const extracted = await extractChaptersFromEpub(epubFile);
    const zip = extracted.zip;
    const chapters = extracted.chapters;
    const filename = epubFile.name;

    // إعداد fewShotText
    const fewShotText = fewShot.length ? fewShot.map(s => `[EN]: ${s.en}\n[AR]: ${s.ar}`).join('\n---\n') : '';

    /* ------------ إنشاء الدفعات الآمنة ------------ */
    const batches = buildBatches(chapters, fewShotText);
    writeLog(`✅ تم تجميع ${chapters.length} فصل في ${batches.length} دفعة`);
    
    // استخدام IndexedDB لحفظ حالة الاستئناف على مستوى الدفعة
    let state = await loadState();
    let startBatch = 0;
    if (state && state.filename === filename && typeof state.currentBatch === 'number') {
        startBatch = state.currentBatch;
        writeLog(`🔁 تم العثور على حالة سابقة — استئناف من الدفعة ${startBatch+1}`, 'ok');
    } else {
        await saveState({ filename, currentBatch: 0 });
        writeLog('✅ بدأنا جلسة جديدة', 'ok');
    }

    /* ------------ تنفيذ الترجمة دفعة بدفعة ------------ */
    for (let b = startBatch; b < batches.length; b++) {
      const batch = batches[b];
      const percent = 5 + Math.round((b / batches.length) * 90);
      setProgress(percent, `ترجمة الدفعة ${b + 1}/${batches.length}`);
      
      let arParts;
      try {
        arParts = await translateBatch(apiKey, API_MODEL, batch.parts, fewShotText);
        writeLog(`✅ ترجمة ناجحة للدفعة ${b+1}`);
      } catch (err) {
        writeLog(`❌ فشلت الدفعة ${b + 1}: ${err.message}، أُحفظ نصوصًا أصلية بدلاً من الفشل الكامل.`, "error");
        arParts = batch.parts; // fallback
      }

      /* حقن النتائج وتحديث ملف zip */
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
      // حفظ حالة الاستئناف بعد كل دفعة ناجحة
      await saveState({ filename, currentBatch: b + 1 });
    }

    /* ------------ إنهاء وبناء الملف ------------ */
    const title = filename.replace(/\.[^/.]+$/, '') + '_AR_Pro';
    const outBlob = await buildTranslatedEpub(zip);
    
    // حفظ النسخة النهائية في IndexedDB
    try { await saveZip(filename + '::translated', outBlob); } catch(e) { 
        writeLog('⚠️ فشل حفظ النسخة النهائية في IndexedDB: ' + e.message, 'error'); 
    }
    
    // تفعيل رابط التحميل
    const url = URL.createObjectURL(outBlob);
    downloadLink.href = url;
    downloadLink.download = title + '.epub';
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '⬇️ تنزيل EPUB المترجم: ' + downloadLink.download;
    
    setProgress(100, 'اكتمل — يمكنك التنزيل الآن');
    writeLog(`🎉 اكتمال الترجمة – ${chapters.length} فصل بـ${batches.length} دفعة.`, 'ok');
    
    // مسح حالة الاستئناف بعد الانتهاء بنجاح
    await clearAllState();
  } catch (err) {
    writeLog('❌ فشلت العملية: ' + (err.message || err), 'error');
    setProgress(0, 'فشل');
  } finally {
    startBtn.disabled = false;
  }
}
