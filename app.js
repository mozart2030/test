// app.js – المعالجة الكاملة مع تدوير مفاتيح API داخلي
import { saveState, loadState, clearAllState, saveChunk, loadChunk, saveZip, loadZip,
         getApiKeyUsage, incrementApiKeyUsage, resetAllApiKeyUsage, openDB } from './storage.js';

// ================== إعدادات المفاتيح (اخفِها جيداً) ==================
const API_KEYS = [
  "AIzaSyCL95FTlGgQQdEFtKfv8kJ5_hH9Ki0O4P0",   // عدّل إلى مفاتيحك الحقيقية
  "AIzaSyA0d_CJEa-HWu4L9Vbj7M7xEIZ2voqACjk"
];
const MAX_REQUESTS_PER_KEY = 20;

// ================== مؤثرات DOM ==================
const qs = id => document.getElementById(id);
const logBox = qs('logBox');
const startBtn = qs('startButton');
const clearBtn = qs('clearButton');
const progressBar = qs('progressBar');
const progressText = qs('progressText');
const downloadLink = qs('downloadLink');
const apiKeyStatus = qs('apiKeyStatus');

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
let API_MODEL = "gemini-2.5-flash-lite";

const MAX_CONCURRENCY = 3;
const CHUNK_SIZE = 10000;
const MAX_RETRIES = 5;

let epubFile = null;
let fewShot = [];
let zipInMemory = null;

// ================== أدوات مساعدة ==================
function writeLog(msg, type = 'info') {
  const d = document.createElement('div');
  d.textContent = `[${new Date().toLocaleTimeString('ar-EG')}] ${msg}`;
  if (type === 'error') d.style.color = '#dc3545';
  if (type === 'ok') d.style.color = '#28a745';
  logBox.prepend(d);
  while (logBox.children.length > 300) logBox.removeChild(logBox.lastChild);
}
function setProgress(pct, txt) {
  progressBar.style.width = pct + '%';
  progressBar.textContent = Math.round(pct) + '%';
  progressText.textContent = txt;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================== دعوة Gemini مع إعادة المحاولة ==================
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
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        const cand = j?.candidates?.[0] || j?.output?.[0] || null;
        if (!cand) throw new Error('استجابة النموذج غير متوقعة');
        const txt = cand?.content?.parts?.[0]?.text || cand?.content?.text || cand?.text || '';
        return String(txt);
      } else {
        lastErr = j?.error?.message || `HTTP ${res.status}`;
        if (res.status === 429 || res.status >= 500) {
          const wait = (2 ** attempt) * 1000 + Math.floor(Math.random() * 400);
          writeLog(`⚠️ ${lastErr} – إعادة محاولة #${attempt + 1} بعد ${Math.round(wait / 1000)} ث`, 'error');
          await sleep(wait);
          continue;
        } else {
          throw new Error(lastErr);
        }
      }
    } catch (err) {
      lastErr = err.message || String(err);
      const wait = (2 ** attempt) * 600 + Math.floor(Math.random() * 300);
      writeLog(`⚠️ خطأ اتصال: ${lastErr} – إعادة محاولة #${attempt + 1} بعد ${Math.round(wait / 1000)} ث`, 'error');
      await sleep(wait);
    }
  }
  throw new Error('تجاوزنا محاولات الاتصال: ' + (lastErr || 'unknown'));
}

// ================== استخراج فصول EPUB ==================
async function extractChaptersFromEpub(fileBlob) {
  setProgress(2, 'يفك ضغط EPUB ويحدد OPF...');
  if (typeof JSZip === 'undefined') throw new Error('مكتبة JSZip غير مُحملة');

  const zip = await JSZip.loadAsync(fileBlob);
  zipInMemory = zip;

  let opfPath = null;
  const containerPath = 'META-INF/container.xml';
  if (zip.file(containerPath)) {
    const contTxt = await zip.file(containerPath).async('text');
    const contDoc = new DOMParser().parseFromString(contTxt, 'application/xml');
    let rf = contDoc.getElementsByTagName('rootfile');
    if (!rf || rf.length === 0) rf = contDoc.getElementsByTagNameNS('*', 'rootfile');
    if (rf && rf[0]) opfPath = rf[0].getAttribute('full-path');
  } else {
    opfPath = Object.keys(zip.files).find(p => p.toLowerCase().endsWith('.opf'));
  }
  if (!opfPath) throw new Error('لم يتم العثور على ملف OPF');

  const opfTxt = await zip.file(opfPath).async('text');
  const opfDoc = new DOMParser().parseFromString(opfTxt, 'application/xml');

  const manifest = {};
  Array.from(opfDoc.getElementsByTagName('item')).forEach(it => {
    const id = it.getAttribute('id'), href = it.getAttribute('href');
    if (id && href) manifest[id] = href;
  });
  const spine = [];
  Array.from(opfDoc.getElementsByTagName('itemref')).forEach(ir => {
    const idref = ir.getAttribute('idref');
    if (idref) spine.push(idref);
  });

  const baseDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
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
  writeLog(`✅ استُخرج ${chapters.length} فصل/عنصر من EPUB`, 'ok');
  return { zip, opfPath, chapters };
}

// ================== تقسيم HTML إلى شظايا ==================
function splitHtmlToChunks(htmlBody, chunkSize = CHUNK_SIZE) {
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

// ================== اختيار مفتاح API (قراءة فقط) ==================
async function getNextAvailableApiKey() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['api_counters'], 'readonly');
    const store = tx.objectStore('api_counters');
    const req = store.getAll();
    req.onsuccess = () => {
      const saved = req.result || [];
      const merged = API_KEYS.map(k => saved.find(s => s.key === k) || { key: k, count: 0, lastUsed: null });
      merged.sort((a, b) => a.count - b.count || (a.lastUsed - b.lastUsed));
      const avail = merged.find(m => m.count < MAX_REQUESTS_PER_KEY);
      if (avail) resolve(avail.key);
      else reject(new Error(`🚫 جميع المفاتيح استُخدمت ${MAX_REQUESTS_PER_KEY} مرة.`));
    };
    req.onerror = () => reject(req.error);
  });
}

// ================== ترجمة شظية واحدة (مع عدّاد واحد فقط) ==================
async function translateChunk(model, fewShotText, filename, chapterHref, chunkIndex, chunkHtml) {
  let apiKey = null;
  try {
    apiKey = await getNextAvailableApiKey();
    const prefix = [
      "أنت مترجم محترف للروايات. ترجم النص داخل وسوم HTML إلى العربية الفصحى.",
      "احفظ جميع وسوم HTML كما هي ولا تضف تفسيرات أو وسوم إضافية.",
      "لا تترجم المصطلحات الخاصة أو الأسماء إن كانت واضحة.",
      "الإخراج يجب أن يكون HTML فقط."
    ].join('\n');
    const prompt = `${fewShotText ? fewShotText + '\n---\n' : ''}${prefix}\n\n${chunkHtml}`;
    const rawOut = await callGeminiSimple(apiKey, model, prompt);
    const cleaned = rawOut.replace(/^```(?:html|xml)?\n/i, '').replace(/\n```$/, '').trim();
    const key = `${filename}::${chapterHref}::${chunkIndex}`;
    await saveChunk(key, cleaned);
    writeLog(`✅ حُفظت شظية #${chunkIndex + 1} للفصل ${chapterHref} (مفتاح: ${apiKey.substr(0, 10)}...)`, 'ok');
    return cleaned;
  } catch (err) {
    if (err.message && err.message.includes('جميع المفاتيح')) throw err; // أوقف العملية
    throw err; // خطأ عادي يُعالج في العامل
  } finally {
    if (apiKey) {
      await incrementApiKeyUsage(apiKey); // عدّاد واحد فقط
      await displayApiKeyStatus();
    }
  }
}

// ================== ترجمة فصل (توازي محدود) ==================
async function translateChapter(model, fewShotText, filename, zip, chapter, chapterIndex, totalChapters, stateMeta) {
  const rawHtml = chapter.rawHtml || '';
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyInner = bodyMatch ? bodyMatch[1] : rawHtml;
  const chunks = splitHtmlToChunks(bodyInner, CHUNK_SIZE);
  chapter.chunks = chunks.map((c, idx) => ({ index: idx, length: c.length }));
  writeLog(`🔁 فصل ${chapterIndex + 1}/${totalChapters}: ${chunks.length} شظية`);

  let idx = 0;
  if (stateMeta?.chapters?.[chapterIndex]) {
    for (let k = 0; k < chunks.length; k++) {
      const key = `${filename}::${chapter.href}::${k}`;
      const saved = await loadChunk(key);
      if (!saved) { idx = k; break; }
      if (k === chunks.length - 1) idx = chunks.length;
    }
  }
  if (idx >= chunks.length) {
    chapter.translatedBody = 'ALREADY_TRANSLATED';
    writeLog(`✅ فصل ${chapterIndex + 1} مُكتمل سابقاً – تجاوز`, 'ok');
    return;
  }

  let active = 0, current = idx;
  const results = new Array(chunks.length);

  async function worker() {
    while (current < chunks.length) {
      const i = current++;
      active++;
      try {
        const key = `${filename}::${chapter.href}::${i}`;
        const existed = await loadChunk(key);
        if (existed) { results[i] = existed; writeLog(`ℹ️ شظية ${i + 1} محفوظة سابقاً – فصل ${chapterIndex + 1}`); active--; continue; }
        const out = await translateChunk(model, fewShotText, filename, chapter.href, i, chunks[i]);
        results[i] = out;
      } catch (err) {
        if (err.message && err.message.includes('جميع المفاتيح')) throw err; // أوقف العملية
        writeLog(`❌ فشل شظية ${i + 1} في فصل ${chapterIndex + 1}: ${err.message}`, 'error');
        results[i] = chunks[i]; // احفظ الأصل
      } finally {
        await persistStatePartial(filename, chapterIndex, Math.max(0, current - 1));
        active--;
      }
    }
  }
  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, () => worker()));

  const joined = results.join('\n');
  const newHtml = bodyMatch ? rawHtml.replace(bodyMatch[1], joined) : joined;
  const finalHtml = newHtml.match(/<html[^>]*dir=/i) ? newHtml : newHtml.replace(/<html/i, '<html dir="rtl" lang="ar"');
  zip.file(chapter.href, finalHtml);
  chapter.translatedBody = 'ALREADY_TRANSLATED';
  writeLog(`✅ انتهى فصل ${chapterIndex + 1}/${totalChapters}`, 'ok');
}

// ================== حفظ/تحميل الحالة ==================
async function persistStateFull(filename, opfPath, chaptersMeta, currentChapter, currentChunk) {
  const stateObj = { filename, opfPath, chapters: chaptersMeta, currentChapter, currentChunk };
  try { await saveState(stateObj); } catch (e) { writeLog('⚠️ خطأ حفظ الحالة: ' + e.message, 'error'); }
}
async function persistStatePartial(filename, chapterIndex, chunkIndex) {
  try {
    const s = await loadStateSafe();
    if (!s) return;
    s.currentChapter = chapterIndex;
    s.currentChunk = chunkIndex;
    await saveState(s);
  } catch (e) { writeLog('⚠️ فشل تحديث الحالة الجزئية: ' + e.message, 'error'); }
}
async function loadStateSafe() { try { return await loadState(); } catch (e) { writeLog('⚠️ فشل تحميل الحالة: ' + e.message, 'error'); return null; } }

// ================== بناء EPUB مترجم ==================
async function buildTranslatedEpub(zip, title) {
  setProgress(95, 'يبني EPUB المترجم...');
  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); // أولاً وبدون ضغط
  for (const path of Object.keys(zip.files)) {
    const f = zip.file(path);
    if (!f) continue;
    const content = await f.async('uint8array');
    out.file(path, content);
  }
  return out.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

// ================== عرض حالة المفاتيح ==================
async function displayApiKeyStatus() {
  try {
    const counters = await getApiKeyUsage();
    const merged = API_KEYS.map(k => counters.find(c => c.key === k) || { key: k, count: 0, lastUsed: null });
    let html = '<div class="small"><strong>حالة المفاتيح:</strong><br>';
    merged.forEach(c => {
      const rem = MAX_REQUESTS_PER_KEY - c.count;
      const color = rem > 10 ? '#28a745' : rem > 0 ? '#ffc107' : '#dc3545';
      html += `<span style="color:${color}">• ${c.key.substr(0, 25)}...: ${c.count}/${MAX_REQUESTS_PER_KEY} مستخدم</span><br>`;
    });
    html += '</div>';
    apiKeyStatus.innerHTML = html;
  } catch (e) { writeLog('⚠️ فشل تحميل حالة المفاتيح: ' + e.message, 'error'); }
}

// ================== المجرى الرئيسي ==================
async function startWorkflow() {
  try {
    if (!epubFile) { writeLog('❌ لم تختر ملف EPUB', 'error'); return; }
    if (!API_KEYS.length) { writeLog('❌ لم تُضف أي مفاتيح API في مصفوفة API_KEYS', 'error'); return; }

    API_MODEL = qs('modelSelect').value.trim() || API_MODEL;
    startBtn.disabled = true;
    setProgress(1, 'يُجهّز...');
    await displayApiKeyStatus();

    let state = await loadStateSafe();
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

    let startChapter = 0;
    if (state && state.filename === filename) {
      writeLog('🔁 تم العثور على حالة سابقة – يُستأنف', 'info');
      startChapter = typeof state.currentChapter === 'number' ? state.currentChapter : 0;
    } else {
      const chaptersMeta = chapters.map(ch => ({ href: ch.href, translated: false, chunks: [] }));
      state = { filename, opfPath, chapters: chaptersMeta, currentChapter: 0, currentChunk: 0 };
      await persistStateFull(filename, opfPath, chaptersMeta, 0, 0);
      writeLog('✅ بدأنا جلسة جديدة', 'ok');
    }

    const fewShotText = fewShot.length ? fewShot.map(s => `[EN]: ${s.en}\n[AR]: ${s.ar}`).join('\n---\n') : '';

    const totalChapters = chapters.length;
    for (let ci = startChapter; ci < totalChapters; ci++) {
      const percent = 10 + Math.round((ci / totalChapters) * 80);
      setProgress(percent, `ترجمة فصل ${ci + 1}/${totalChapters}`);
      await translateChapter(API_MODEL, fewShotText, filename, zip, chapters[ci], ci, totalChapters, state);
      state.currentChapter = ci + 1;
      await persistStateFull(filename, opfPath, state.chapters, state.currentChapter, 0);
      await displayApiKeyStatus();
    }

    const title = filename.replace(/\.[^/.]+$/, '') + '_AR_Pro';
    const outBlob = await buildTranslatedEpub(zip, title);
    try { await saveZip(filename + '::translated', outBlob); } catch (e) {
      writeLog('⚠️ فشل حفظ النسخة النهائية في IndexedDB: ' + e.message, 'error');
    }

    const url = URL.createObjectURL(outBlob);
    downloadLink.href = url;
    downloadLink.download = title + '.epub';
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '⬇️ تنزيل EPUB المترجم: ' + downloadLink.download;

    setProgress(100, 'اكتمل – يمكنك التنزيل الآن');
    writeLog(`🎉 اكتمال الترجمة – ${totalChapters} فصل.`, 'ok');
    await clearAllState();
  } catch (err) {
    writeLog('❌ فشل العملية: ' + (err.message || err), 'error');
    if (err.message && err.message.includes('جميع المفاتيح')) {
      writeLog('💡 أضف مفاتيح جديدة إلى مصفوفة API_KEYS أو أعد تعيين العدادات.', 'info');
    }
    setProgress(0, 'فشل');
  } finally {
    startBtn.disabled = false;
    await displayApiKeyStatus();
  }
}

// ================== أحداث واجهة المستخدم ==================
qs('epubFile').addEventListener('change', e => {
  epubFile = e.target.files[0];
  writeLog('📥 اخترت: ' + (epubFile ? epubFile.name : 'لا شيء'));
});
qs('fewFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) { fewShot = []; return; }
  try {
    const txt = await f.text();
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed)) { writeLog('❌ ملف few-shot يجب أن يكون مصفوفة', 'error'); return; }
    fewShot = parsed.filter(p => p && typeof p.en === 'string' && typeof p.ar === 'string');
    writeLog('✅ حُمِّلت ' + fewShot.length + ' عينة ترجمة (few-shot)');
  } catch (err) {
    writeLog('❌ خطأ قراءة few-shot: ' + err.message, 'error');
    fewShot = [];
  }
});
clearBtn.addEventListener('click', async () => {
  if (!confirm('هل تريد فعلاً مسح حالة الاستئناف بالكامل؟')) return;
  await clearAllState();
  downloadLink.style.display = 'none';
  setProgress(0, 'تم المسح');
  writeLog('🗑️ مُسحت حالة التخزين (IndexedDB).', 'info');
});
qs('resetApiKeys').addEventListener('click', async () => {
  if (!confirm('إعادة تعيين عدادات جميع المفاتيح إلى 0؟')) return;
  await resetAllApiKeyUsage();
  await displayApiKeyStatus();
  writeLog('🔄 أُعيدت عدادات المفاتيح.', 'ok');
});
startBtn.addEventListener('click', startWorkflow);

// ================== بدء التشغيل ==================
document.addEventListener('DOMContentLoaded', displayApiKeyStatus);
'DOMContentLoaded', displayApiKeyStatus);
