// app.js (es module)
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

const MAX_CONCURRENCY = 3; // يمكنك رفعه حسب حدود API لديك
const CHUNK_SIZE = 10000;   // حجم أحرف لكل شظية (قابل للتعديل)
const MAX_RETRIES = 5;

let epubFile = null;
let fewShot = [];
let zipInMemory = null; // كائن JSZip يتحكم به أثناء الجلسة

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

// small sleep
const sleep = ms => new Promise(r=>setTimeout(r, ms));

/* ------------------- Gemini call with retry/backoff ------------------- */
async function callGeminiSimple(apiKey, model, promptText) {
  const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = { contents: [{ parts: [{ text: promptText }] }] };

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(()=>({}));
      if (res.ok) {
        // مرونة في استخراج النص
        const cand = j?.candidates?.[0] || j?.output?.[0] || null;
        if (!cand) throw new Error('استجابة النموذج غير متوقعة');
        const txt = cand?.content?.parts?.[0]?.text || cand?.content?.text || cand?.text || '';
        return String(txt);
      } else {
        lastErr = j?.error?.message || `HTTP ${res.status}`;
        // حالات قابلة لإعادة المحاولة
        if (res.status === 429 || res.status >= 500) {
          const wait = (2 ** attempt) * 1000 + Math.floor(Math.random()*400);
          writeLog(`⚠️ ${lastErr} — إعادة محاولة #${attempt+1} بعد ${Math.round(wait/1000)} ث`, 'error');
          await sleep(wait);
          continue;
        } else {
          throw new Error(lastErr);
        }
      }
    } catch (err) {
      lastErr = err.message || String(err);
      const wait = (2 ** attempt) * 600 + Math.floor(Math.random()*300);
      writeLog(`⚠️ خطأ اتصال: ${lastErr} — إعادة محاولة #${attempt+1} بعد ${Math.round(wait/1000)} ث`, 'error');
      await sleep(wait);
    }
  }
  throw new Error('تجاوزنا محاولات الاتصال: ' + (lastErr || 'unknown'));
}

/* --------------------- EPUB processing --------------------- */
async function extractChaptersFromEpub(fileBlob) {
  setProgress(2, 'يفك ضغط EPUB وتحديد OPF...');
  if (typeof JSZip === 'undefined') throw new Error('مكتبة JSZip غير مُحملة');

  const zip = await JSZip.loadAsync(fileBlob);
  zipInMemory = zip; // حفظ مؤقت
  let opfPath = null;

  // قراءة container.xml بطريقة متينة للتعامل مع namespaces
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

  // قراءة opf
  const opfTxt = await zip.file(opfPath).async('text');
  const opfDoc = new DOMParser().parseFromString(opfTxt, 'application/xml');

  // جمع manifest
  const manifest = {};
  const manifestEls = opfDoc.getElementsByTagName('item');
  for (let i=0;i<manifestEls.length;i++){
    const it = manifestEls[i];
    const id = it.getAttribute('id'), href = it.getAttribute('href');
    if(id && href) manifest[id] = href;
  }
  // spine
  const itemrefs = opfDoc.getElementsByTagName('itemref');
  const spine = [];
  for (let i=0;i<itemrefs.length;i++){
    const idref = itemrefs[i].getAttribute('idref');
    if(idref) spine.push(idref);
  }

  const baseDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/')+1) : '';
  const chapters = [];
  for (const idref of spine) {
    const href = manifest[idref];
    if (!href) continue;
    const full = baseDir + href;
    const entry = zip.file(full) || zip.file(href);
    if (!entry) continue;
    const rawHtml = await entry.async('text');
    chapters.push({ href: full, rawHtml, translatedBody: null, chunks: [] });
  }

  if (chapters.length === 0) throw new Error('لم يتم إيجاد فصول قابلة للاستخراج');

  writeLog(`✅ استخرجنا ${chapters.length} فصل/عنصر من EPUB`, 'ok');
  return { zip, opfPath, chapters };
}

/* --------------------- تقسيم إلى Chunks ذكي --------------------- */
function splitHtmlToChunks(htmlBody, chunkSize = CHUNK_SIZE) {
  // تقسيم على نهايات وسوم شائعة حتى لا نكسر HTML
  const pieces = htmlBody.split(/(?<=<\/p>|<\/div>|<\/h[1-6]>|<\/blockquote>|\n\n)/g);
  const consolidated = [];
  let cur = '';
  for (const p of pieces) {
    if ((cur.length + p.length) > chunkSize && cur.length > 0) {
      consolidated.push(cur);
      cur = '';
    }
    cur += p;
  }
  if (cur.trim()) consolidated.push(cur);
  return consolidated;
}

/* --------------------- ترجمة شظية واحدة مع حفظها --------------------- */
async function translateChunk(apiKey, model, fewShotText, filename, chapterHref, chunkIndex, chunkHtml) {
  // بناء الـ prompt مع قواعد صارمة للحفاظ على HTML
  const prefix = [
    "أنت مترجم محترف للروايات. ترجم النص داخل وسوم HTML إلى العربية الفصحى.",
    "احفظ جميع وسوم HTML كما هي ولا تضف تفسيرات أو وسوم إضافية.",
    "لا تترجم المصطلحات الخاصة أو الأسماء إن كانت واضحة.",
    "الإخراج يجب أن يكون HTML فقط."
  ].join('\n');

  const prompt = `${fewShotText ? fewShotText + '\n---\n' : ''}${prefix}\n\n${chunkHtml}`;

  const rawOut = await callGeminiSimple(apiKey, model, prompt);
  // تنظيف fences إن وُجدت
  const cleaned = rawOut.replace(/^```(?:html|xml)?\n/i, '').replace(/\n```$/, '').trim();
  // حفظ في IndexedDB
  const key = `${filename}::${chapterHref}::${chunkIndex}`;
  await saveChunk(key, cleaned);
  writeLog(`✅ حفظ شظية #${chunkIndex+1} للفصل ${chapterHref}`, 'ok');
  return cleaned;
}

/* --------------------- ترجمة فصل (شظية بشظية مع استئناف) --------------------- */
async function translateChapter(apiKey, model, fewShotText, filename, zip, chapter, chapterIndex, totalChapters, stateMeta) {
  // إذا كان لدينا نص جسد كامل محفوظ مسبقاً (ALREADY_TRANSLATED) نتخطى
  // لكن نحن نعتمد على شظايا مخزنة في IndexedDB
  const rawHtml = chapter.rawHtml || '';
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyInner = bodyMatch ? bodyMatch[1] : rawHtml;
  const chunks = splitHtmlToChunks(bodyInner, CHUNK_SIZE);
  chapter.chunks = chunks.map((c, idx) => ({ index: idx, length: c.length }));
  writeLog(`🔁 فصل ${chapterIndex+1}/${totalChapters}: ${chunks.length} شظية` );

  // حالياً نحاول الترجمة والتخزين على مستوى الشظايا
  let idx = 0;
  // إذا في stateMeta فحاول استئناف آخر شظية
  if (stateMeta && stateMeta.chapters && stateMeta.chapters[chapterIndex]) {
    const saved = stateMeta.chapters[chapterIndex];
    // نبحث أول شظية غير محفوظة
    for (let k = 0; k < chunks.length; k++) {
      const key = `${filename}::${chapter.href}::${k}`;
      const savedChunk = await loadChunk(key);
      if (!savedChunk) { idx = k; break; }
      if (k === chunks.length - 1) idx = chunks.length; // كلها محفوظة
    }
  }

  // حالة: كل الشظايا محفوظة -> نضع translatedBody = 'ALREADY_TRANSLATED' ونعيد
  if (idx >= chunks.length) {
    chapter.translatedBody = 'ALREADY_TRANSLATED';
    writeLog(`✅ فصل ${chapterIndex+1} مُكتمل سابقاً — تجاوز`, 'ok');
    return;
  }

  // تنفيذ ترجمة شظية بشظية مع توازي محدود
  let active = 0;
  let current = idx;
  const results = new Array(chunks.length);

  async function worker() {
    while (current < chunks.length) {
      const i = current++;
      active++;
      try {
        // تحقق إن الشظية محفوظة بالفعل
        const key = `${filename}::${chapter.href}::${i}`;
        const existed = await loadChunk(key);
        if (existed) {
          results[i] = existed;
          writeLog(`ℹ️ شظية ${i+1} محفوظة مسبقاً — فصل ${chapterIndex+1}`);
          active--;
          continue;
        }
        // ترجم الشظية
        const out = await translateChunk(apiKey, model, fewShotText, filename, chapter.href, i, chunks[i]);
        results[i] = out;
      } catch (err) {
        writeLog(`❌ فشل شظية ${i+1} في فصل ${chapterIndex+1}: ${err.message}`, 'error');
        // عند الفشل نحتفظ بالنص الأصلي (تجنب فقدان HTML)
        results[i] = chunks[i];
      } finally {
        // بعد كل شظية مُترجمة أو مُحاولة، حدِّث الحالة العامة على IndexedDB
        await persistStatePartial(filename, chapterIndex, i);
        active--;
      }
    }
  }

  // بدء عدد من العمال حسب MAX_CONCURRENCY
  const workers = Array.from({length: MAX_CONCURRENCY}).map(()=>worker());
  await Promise.all(workers);

  // بعد الانتهاء، نجمع الشظايا ونستبدل داخل rawHtml ونحدث ملف zip
  const joined = results.join('\n');
  const newHtml = bodyMatch ? rawHtml.replace(bodyMatch[1], joined) : joined;

  // ضمان وجود dir/lang
  const finalHtml = newHtml.match(/<html[^>]*dir=/i) ? newHtml : newHtml.replace(/<html/i, '<html dir="rtl" lang="ar"');

  // تحديث الملف داخل zip
  zip.file(chapter.href, finalHtml);

  // علامة مترجم
  chapter.translatedBody = 'ALREADY_TRANSLATED';
  writeLog(`✅ انتهى فصل ${chapterIndex+1}/${totalChapters}`, 'ok');
}

/* --------------------- حالة State جزئية (حفظ متكرر) --------------------- */
async function persistStateFull(filename, opfPath, chaptersMeta, currentChapter, currentChunk) {
  const stateObj = { filename, opfPath, chapters: chaptersMeta, currentChapter, currentChunk };
  try {
    await saveState(stateObj);
  } catch (e) {
    writeLog('⚠️ خطأ حفظ الحالة: ' + e.message, 'error');
  }
}

// عند حفظ كل شظية نحدّث الحالة البسيطة (index) حتى نستأنف بسرعة
async function persistStatePartial(filename, chapterIndex, chunkIndex) {
  try {
    const s = await loadStateSafe();
    if (!s) return;
    s.currentChapter = chapterIndex;
    s.currentChunk = chunkIndex;
    await saveState(s);
  } catch (e) {
    // لا نقطع التنفيذ لكن نسجل
    writeLog('⚠️ فشل تحديث الحالة الجزئية: ' + e.message, 'error');
  }
}

async function loadStateSafe() {
  try {
    const s = await loadState();
    return s;
  } catch (e) {
    writeLog('⚠️ فشل تحميل الحالة من IndexedDB: ' + e.message, 'error');
    return null;
  }
}

/* --------------------- بناء EPUB النهائي --------------------- */
async function buildTranslatedEpub(zip, title) {
  setProgress(95, 'يبني EPUB المترجم ...');
  // نضمن أن mimetype هو أول ملف بدون ضغط
  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', {compression: 'STORE'}); // يجب أن يضاف أولاً

  // ننسخ كل الملفات من zip الأصلي (zip هو كائن JSZip مع ملفاتها)
  for (const path of Object.keys(zip.files)) {
    const f = zip.file(path);
    if (!f) continue;
    const content = await f.async('uint8array');
    out.file(path, content);
  }

  const blob = await out.generateAsync({type:'blob', mimeType:'application/epub+zip'});
  return blob;
}

/* --------------------- منطق المجرى الكامل مع استئناف على مستوى الشظايا --------------------- */
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

    // محاولة استرجاع حالة سابقة
    let state = await loadStateSafe();

    // استخراج الفصول من EPUB
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

    // إذا توجد حالة سابقة ومتطابقة الملف — نحاول الاستئناف
    let startChapter = 0;
    if (state && state.filename === filename) {
      // حافظ على zip الحالي لكن نحتاج لتطبيق أي شظايا محفوظة (loadChunk سيستعملها لاحقاً)
      writeLog('🔁 تم العثور على حالة سابقة — محاولة الاستئناف', 'info');
      startChapter = typeof state.currentChapter === 'number' ? state.currentChapter : 0;
    } else {
      // إنشاء حالة مبدئية في IndexedDB
      const chaptersMeta = chapters.map(ch => ({ href: ch.href, translated: false, chunks: [] }));
      state = { filename, opfPath, chapters: chaptersMeta, currentChapter: 0, currentChunk: 0 };
      await persistStateFull(filename, opfPath, chaptersMeta, 0, 0);
      writeLog('✅ بدأنا جلسة جديدة', 'ok');
    }

    // إعداد fewShotText
    const fewShotText = fewShot.length ? fewShot.map(s => `[EN]: ${s.en}\n[AR]: ${s.ar}`).join('\n---\n') : '';

    // ترجمة فصل تلو الآخر
    const totalChapters = chapters.length;
    for (let ci = startChapter; ci < totalChapters; ci++) {
      const chap = chapters[ci];
      const percent = 10 + Math.round((ci / totalChapters) * 80);
      setProgress(percent, `ترجمة فصل ${ci+1}/${totalChapters}`);
      await translateChapter(apiKey, API_MODEL, fewShotText, filename, zip, chap, ci, totalChapters, state);
      // بعد كل فصل، تحديث الحالة الكاملة
      state.currentChapter = ci + 1;
      await persistStateFull(filename, opfPath, state.chapters, state.currentChapter, 0);
    }

    // بناء EPUB
    const title = filename.replace(/\.[^/.]+$/, '') + '_AR_Pro';
    const outBlob = await buildTranslatedEpub(zip, title);

    // حفظ النسخة النهائية في IndexedDB (اختياري)
    try {
      await saveZip(filename + '::translated', outBlob);
    } catch(e) {
      writeLog('⚠️ فشل حفظ النسخة النهائية في IndexedDB: ' + e.message, 'error');
    }

    // تفعيل رابط التحميل
    const url = URL.createObjectURL(outBlob);
    downloadLink.href = url;
    downloadLink.download = title + '.epub';
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '⬇️ تنزيل EPUB المترجم: ' + downloadLink.download;

    setProgress(100, 'اكتمل — يمكنك تنزيل الملف الآن');
    writeLog(`🎉 اكتمال الترجمة — ${totalChapters} فصل تمّت معالجته.`, 'ok');

    // إزالة الحالة الكاملة (أو إبقاؤها حسب رغبتك)
    await clearAllState();
  } catch (err) {
    writeLog('❌ فشل العملية: ' + (err.message || err), 'error');
    setProgress(0, 'فشل');
  } finally {
    startBtn.disabled = false;
  }
}
