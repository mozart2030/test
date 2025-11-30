// app.js (ES module) - نسخة احترافية مُبسطة: خدمات داخل نفس الملف للتوافق الثلاثي
await window.JSZipPromise;
import * as storage from './storage.js';

const qs = id => document.getElementById(id);
const logBox = qs('logBox'), progressBar = qs('progressBar'), progressText = qs('progressText'),
      selectEpubBtn = qs('selectEpubBtn'), epubInput = qs('epubFile'),
      startBtn = qs('startButton'), clearBtn = qs('clearButton'), downloadLink = qs('downloadLink');

let epubFile = null;
let fewShot = [];
let zipObj = null;   // JSZip object in memory while processing

function writeLog(msg, type='info') {
  const d = document.createElement('div');
  d.textContent = `[${new Date().toLocaleTimeString('ar-EG')}] ${msg}`;
  if(type==='error') d.style.color = '#dc3545';
  if(type==='ok') d.style.color = '#28a745';
  logBox.prepend(d);
  while(logBox.children.length > 300) logBox.removeChild(logBox.lastChild);
}
function setProgress(p, text) {
  progressBar.style.width = p + '%';
  progressBar.textContent = Math.round(p) + '%';
  progressText.textContent = text;
}
const sleep = ms => new Promise(r=>setTimeout(r, ms));

/* ================= EPUB service ================= */
const epubService = {
  resolvePath(opfPath, href) {
    if (!opfPath) return href.replace(/^\//,'');
    const base = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/')) : '';
    if (href.startsWith('/')) href = href.slice(1);
    return base ? `${base}/${href}` : href;
  },

  async extract(fileBlob) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip غير متاح');
    setProgress(2, 'يفك ضغط EPUB ويقرأ OPF...');
    const zip = await JSZip.loadAsync(fileBlob);
    zipObj = zip;
    let opfPath = null;
    const containerPath = 'META-INF/container.xml';
    if (zip.file(containerPath)) {
      const contTxt = await zip.file(containerPath).async('text');
      const contDoc = new DOMParser().parseFromString(contTxt, 'application/xml');
      let rf = contDoc.getElementsByTagName('rootfile');
      if (!rf || rf.length===0) rf = contDoc.getElementsByTagNameNS('*','rootfile');
      if (rf && rf[0]) opfPath = rf[0].getAttribute('full-path');
    } else {
      opfPath = Object.keys(zip.files).find(p=>p.toLowerCase().endsWith('.opf'));
    }
    if (!opfPath) throw new Error('لم يتم العثور على OPF');

    const opfTxt = await zip.file(opfPath).async('text');
    const opfDoc = new DOMParser().parseFromString(opfTxt,'application/xml');

    // manifest mapping
    const manifest = {};
    const items = opfDoc.getElementsByTagName('item');
    for (let i=0;i<items.length;i++) {
      const id = items[i].getAttribute('id'), href = items[i].getAttribute('href');
      if (id && href) manifest[id] = href;
    }
    // spine
    const spineEls = opfDoc.getElementsByTagName('itemref');
    const spine = [];
    for (let i=0;i<spineEls.length;i++){
      const idref = spineEls[i].getAttribute('idref');
      if (idref) spine.push(idref);
    }

    const chapters = [];
    for (const idref of spine) {
      const href = manifest[idref];
      if (!href) continue;
      const resolved = this.resolvePath(opfPath, href);
      const entry = zip.file(resolved) || zip.file(href);
      if (!entry) {
        // attempt alternative: try without base
        continue;
      }
      const raw = await entry.async('text');
      chapters.push({ href: resolved, rawHtml: raw, translated: false, chunksCount: 0 });
    }

    if (chapters.length === 0) throw new Error('لم يتم العثور على فصول قابلة للاستخراج');
    writeLog(`✅ استخرج ${chapters.length} فصل/عنصر من EPUB`, 'ok');
    return { zip, opfPath, chapters };
  },

  async updateChapterHtml(chapterHref, newHtml) {
    if (!zipObj) throw new Error('zip غير محمّل');
    zipObj.file(chapterHref, newHtml);
  },

  async build(zip, outputName) {
    setProgress(95, 'يبني EPUB النهائي...');
    const out = new JSZip();
    out.file('mimetype','application/epub+zip',{compression:'STORE'});
    for (const path of Object.keys(zip.files)) {
      const f = zip.file(path);
      if (!f) continue;
      const data = await f.async('uint8array');
      out.file(path, data);
    }
    const blob = await out.generateAsync({type:'blob', mimeType:'application/epub+zip'});
    return blob;
  }
};

/* ================= Translator service ================= */
const translatorService = {
  API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
  async call(apiKey, model, prompt) {
    const url = `${this.API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const payload = { contents: [{ parts: [{ text: prompt }] }] };
    let last = null;
    const RETRIES = 5;
    for (let attempt=0; attempt<RETRIES; attempt++) {
      try {
        const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const j = await r.json().catch(()=>({}));
        if (r.ok) {
          const cand = j?.candidates?.[0] || j?.output?.[0] || null;
          const finish = cand?.finishReason || null;
          const text = cand?.content?.parts?.[0]?.text || cand?.content?.text || cand?.text || '';
          if (finish && finish !== 'STOP') {
            throw new Error('تم إيقاف النموذج: ' + finish);
          }
          if (!text) throw new Error('إستجابة النموذج فارغة');
          return String(text);
        } else {
          last = j?.error?.message || `HTTP ${r.status}`;
          if (r.status === 429 || r.status >= 500) {
            const wait = (2 ** attempt) * 1000 + Math.floor(Math.random()*400);
            writeLog(`⚠️ ${last} — retry #${attempt+1} after ${Math.round(wait/1000)}s`, 'error');
            await sleep(wait);
            continue;
          } else {
            throw new Error(last);
          }
        }
      } catch (err) {
        last = err.message || String(err);
        const wait = (2 ** attempt) * 600 + Math.floor(Math.random()*300);
        writeLog(`⚠️ خطأ اتصال: ${last} — retry #${attempt+1} after ${Math.round(wait/1000)}s`, 'error');
        await sleep(wait);
      }
    }
    throw new Error('فشل الاتصال بعد المحاولات: ' + (last||'unknown'));
  }
};

/* ================= Helper: split HTML into chunks ================= */
function splitHtml(body, size) {
  const pieces = body.split(/(?<=<\/p>|<\/div>|<\/h[1-6]>|<\/blockquote>|\n\n)/g);
  const arr = [];
  let cur = '';
  for (const p of pieces) {
    if (cur.length + p.length > size && cur.length>0) { arr.push(cur); cur=''; }
    cur += p;
  }
  if (cur.trim()) arr.push(cur);
  return arr;
}

/* ================= Orchestration ================= */
selectEpubBtn.addEventListener('click', ()=> epubInput.click());
epubInput.addEventListener('change', e => {
  epubFile = e.target.files && e.target.files[0] ? e.target.files[0] : null;
  if (epubFile) writeLog('📥 اخترت: ' + epubFile.name, 'info');
});
qs('fewFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) { fewShot = []; return; }
  try {
    const txt = await f.text();
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed)) throw new Error('few-shot يجب أن تكون مصفوفة');
    fewShot = parsed.filter(p=>p && p.en && p.ar);
    writeLog(`✅ حملت ${fewShot.length} أمثلة few-shot`, 'ok');
  } catch (err) {
    fewShot = [];
    writeLog('❌ خطأ قراءة few-shot: ' + err.message, 'error');
  }
});

clearBtn.addEventListener('click', async ()=>{
  if (!confirm('مسح كامل لحالة التخزين؟')) return;
  await storage.clearAll();
  downloadLink.style.display = 'none';
  setProgress(0, 'تم المسح');
  writeLog('🗑️ تم مسح التخزين (IndexedDB)', 'info');
});

startBtn.addEventListener('click', startWorkflow);

async function startWorkflow() {
  try {
    if (!epubFile) { writeLog('❌ لم تختَر ملف EPUB', 'error'); return; }
    const apiKey = qs('apiKey').value.trim();
    if (!apiKey) { writeLog('❌ ألصق مفتاح API أولًا', 'error'); return; }
    const model = qs('modelSelect').value.trim() || 'gemini-2.5-flash-lite';
    const concurrency = Math.max(1, Math.min(8, parseInt(qs('concurrency').value || '3')));

    startBtn.disabled = true;
    setProgress(1, 'جاري التحضير...');

    // استخراج الفصول
    const extracted = await epubService.extract(epubFile);
    const zip = extracted.zip, opfPath = extracted.opfPath, chapters = extracted.chapters;
    const filename = epubFile.name;

    // تحميل حالة سابقة (إن وُجدت)
    let state = await storage.loadState();
    if (!state || state.filename !== filename) {
      state = { filename, opfPath, chapters: chapters.map(ch => ({ href: ch.href, chunks: 0 })), currentChapter: 0, currentChunk: 0 };
      await storage.saveState(state);
      writeLog('✅ حالة جديدة مُنشأة', 'ok');
    } else {
      writeLog('🔁 تم العثور على حالة سابقة — محاولة استئناف', 'info');
    }

    // تهيئة fewShotText
    const fewText = fewShot.length ? fewShot.map(s=>`[EN]: ${s.en}\n[AR]: ${s.ar}`).join('\n---\n') : '';

    // بدء الترجمة فصلًا فصلًا
    const total = chapters.length;
    for (let ci = state.currentChapter || 0; ci < total; ci++) {
      setProgress(10 + Math.round((ci/total)*70), `ترجمة فصل ${ci+1}/${total}`);
      const ch = chapters[ci];
      // تقسيم الـ body
      const bodyMatch = (ch.rawHtml || '').match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const inner = bodyMatch ? bodyMatch[1] : ch.rawHtml || '';
      const chunks = splitHtml(inner, 6000);
      ch.chunksCount = chunks.length;

      writeLog(`🔁 فصل ${ci+1}: ${chunks.length} شظية`);

      // استئناف على مستوى الشظايا
      let startChunk = 0;
      // ابحث أول شظية غير محفوظة
      for (let k=0;k<chunks.length;k++) {
        const key = `${filename}::${ch.href}::${k}`;
        const existing = await storage.loadChunk(key);
        if (!existing) { startChunk = k; break; }
        if (k === chunks.length-1) startChunk = chunks.length; // كلها محفوظة
      }
      if (startChunk >= chunks.length) {
        writeLog(`✅ فصل ${ci+1} مكتمل سابقاً — تخطي`, 'ok');
        state.currentChapter = ci+1;
        await storage.saveState(state);
        continue;
      }

      // ترجمة شظايا بتوازي محدود
      const results = new Array(chunks.length);
      let ptr = startChunk;
      let active = 0;
      const tasks = [];

      async function worker() {
        while (true) {
          const i = ptr++;
          if (i === undefined || i >= chunks.length) break;
          const key = `${filename}::${ch.href}::${i}`;
          const existed = await storage.loadChunk(key);
          if (existed) { results[i] = existed; writeLog(`ℹ️ شظية ${i+1} محفوظة مسبقاً`); continue; }
          active++;
          try {
            const prompt = `${fewText ? fewText + '\n---\n' : ''}أنت مترجم محترف. ترجم النص داخل HTML إلى العربية الفصحى. احفظ وسوم HTML كما هي.\n\n${chunks[i]}`;
            const raw = await translatorService.call(apiKey, model, prompt);
            const cleaned = raw.replace(/^```(?:html|xml)?\n/i,'').replace(/\n```$/i,'').trim();
            await storage.saveChunk(key, cleaned);
            results[i] = cleaned;
            writeLog(`✅ انتهت شظية ${i+1}/${chunks.length} فصل ${ci+1}`);
          } catch (err) {
            writeLog(`❌ شظية ${i+1} فشلت: ${err.message}`, 'error');
            results[i] = chunks[i]; // fallback
          } finally {
            // تحديث الحالة الجزئية
            state.currentChapter = ci;
            state.currentChunk = i;
            await storage.saveState(state);
            active--;
          }
        }
      }

      // إطلاق العمال
      const workers = Array.from({length: concurrency}, ()=>worker());
      await Promise.all(workers);

      // جمع النتيجة
      const joined = results.join('\n');
      const newHtml = bodyMatch ? ch.rawHtml.replace(bodyMatch[1], joined) : joined;
      const finalHtml = /<html[^>]*dir=/i.test(newHtml) ? newHtml : newHtml.replace(/<html/i,'<html dir="rtl" lang="ar"');

      // حفظ ضمن zip
      await epubService.updateChapterHtml(ch.href, finalHtml);

      // بعد الفصل: تنظيف الشظايا المحفوظة (اختياري لحفظ المساحة)
      for (let k=0;k<chunks.length;k++) {
        const key = `${filename}::${ch.href}::${k}`;
        await storage.deleteChunk?.(key).catch(()=>{ /* safe */ });
      }

      state.currentChapter = ci+1;
      state.currentChunk = 0;
      await storage.saveState(state);
      writeLog(`✅ انتهى فصل ${ci+1}`, 'ok');
    }

    // بناء EPUB النهائي
    const outName = filename.replace(/\.[^/.]+$/,'') + '_AR_Pro.epub';
    const outBlob = await epubService.build(zip, outName);

    // حفظ نسخة في IndexedDB (اختياري)
    try { await storage.saveZip(filename + '::translated', outBlob); } catch(e){ writeLog('⚠️ فشل حفظ النسخة النهائية: '+e.message,'error'); }

    // توفير رابط التحميل
    const url = URL.createObjectURL(outBlob);
    downloadLink.href = url; downloadLink.download = outName;
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '⬇️ تنزيل: ' + outName;

    setProgress(100, 'اكتمل — انقر تنزيل');
    writeLog('🎉 اكتملت الترجمة', 'ok');

    // إتمام: مسح الحالة (إن أردت إبقاؤها للتنزيل لاحقًا احذف هذا السطر)
    // await storage.clearAll();

  } catch (err) {
    writeLog('❌ فشل: ' + (err.message || err), 'error');
    setProgress(0, 'فشل');
  } finally {
    startBtn.disabled = false;
  }
}
