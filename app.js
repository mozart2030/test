// عناصر الواجهة
const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const logBox = document.getElementById("log");

function log(message) {
  logBox.textContent += message + "\n";
}

// التأكد من تحميل JSZip
function waitForJSZip() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.JSZip) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

// تنظيف HTML حسب قواعد rules.js
function cleanHTML(html) {
  window.replaceRules.forEach(rule => {
    html = html.replace(rule.find, rule.replace);
  });
  return html;
}

// المعالجة الرئيسية
processBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) {
    log("Please select an EPUB file first.");
    return;
  }

  log("Waiting for JSZip...");
  await waitForJSZip();

  log("Reading EPUB...");
  const content = await file.arrayBuffer();

  const zip = await JSZip.loadAsync(content);
  log("EPUB loaded.");

  const newZip = new JSZip();

  const files = Object.keys(zip.files);

  for (const filename of files) {
    const item = zip.files[filename];

    if (filename.endsWith(".html") || filename.endsWith(".xhtml")) {
      log("Cleaning: " + filename);

      let html = await item.async("string");
      html = cleanHTML(html);

      newZip.file(filename, html);
    } else {
      const data = await item.async("arraybuffer");
      newZip.file(filename, data);
    }
  }

  log("Rebuilding EPUB...");

  const output = await newZip.generateAsync({ type: "blob" });

  // تنزيل الملف
  const a = document.createElement("a");
  a.href = URL.createObjectURL(output);
  a.download = "cleaned.epub";
  a.click();

  log("Done ✓ File saved as cleaned.epub");
});