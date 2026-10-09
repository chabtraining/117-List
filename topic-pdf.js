// Builds a printable A4 handout for one topic. It opens in print.html and uses the
// browser's own "Save as PDF", which is the only renderer that keeps Thai vowels and
// tone marks in place (canvas-based PDF libraries drop or misplace them).
(function() {
  const STYLE = `
    .pdf-doc { max-width: 718px; margin: 0 auto; padding: 0; color: #1D1D1B; background: #FFFFFF;
      font-family: 'IBM Plex Sans Thai', 'IBM Plex Sans', sans-serif; font-size: 13px; line-height: 1.6;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .pdf-doc * { box-sizing: border-box; }
    .pdf-head { display: flex; align-items: center; gap: 14px; padding-bottom: 12px; border-bottom: 3px solid #C8102E; }
    .pdf-head img { width: 120px; height: auto; }
    .pdf-head-org { font-size: 11px; color: #111110; line-height: 1.4; }
    .pdf-head-org b { display: block; color: #980C22; font-size: 12px; }
    .pdf-title { margin: 16px 0 6px; font-size: 22px; font-weight: 800; line-height: 1.35; }
    .pdf-cat { display: inline-block; padding: 2px 10px; border: 1px solid #E7C5CB; border-radius: 999px;
      color: #980C22; font-size: 11px; font-weight: 700; }
    .pdf-section { margin-top: 20px; }
    .pdf-bar { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-radius: 6px 6px 0 0;
      color: #FFFFFF; font-size: 15px; font-weight: 800; background: #B20E29; }
    .pdf-bar.tech { background: #3C3C38; }
    .pdf-bar-mark { padding: 1px 8px; border-radius: 4px; background: #FFFFFF; color: #980C22; font-size: 12px; }
    .pdf-bar.tech .pdf-bar-mark { color: #111110; }
    .pdf-item { padding: 12px 14px; border: 1px solid #E3E3DF; border-top: 0; }
    .pdf-item-head { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; font-weight: 800; }
    .pdf-num { flex: 0 0 22px; height: 22px; border-radius: 4px; background: #C8102E; color: #FFFFFF;
      font-size: 11px; font-weight: 800; text-align: center; line-height: 22px; }
    .pdf-body { padding-left: 32px; }
    .pdf-label { margin: 8px 0 3px; color: #980C22; font-size: 11.5px; font-weight: 800; }
    .pdf-points { margin: 0; padding-left: 18px; }
    .pdf-points li { margin: 2px 0; }
    .pdf-grid { display: flex; gap: 10px; margin-top: 8px; }
    .pdf-box { flex: 1; padding: 8px 10px; border-radius: 5px; background: #F7F7F5; }
    .pdf-box.impact { background: #FFF4F5; }
    .pdf-box .pdf-label { margin-top: 0; }
    .pdf-box p, .pdf-text { margin: 0; }
    .pdf-imgs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .pdf-imgs figure { width: calc(50% - 4px); margin: 0; }
    .pdf-imgs img { display: block; width: 100%; max-height: 210px; object-fit: contain;
      border: 1px solid #E3E3DF; border-radius: 5px; background: #F4F4F2; }
    .pdf-imgs figcaption { margin-top: 3px; color: #111110; font-size: 10.5px; line-height: 1.4; }
    .pdf-foot { margin-top: 20px; padding-top: 10px; border-top: 1px solid #E3E3DF; color: #111110;
      font-size: 10.5px; line-height: 1.6; word-break: break-all; }
    .pdf-avoid { page-break-inside: avoid; break-inside: avoid; }
    .pdf-script { margin-top: 8px; padding: 8px 10px; border: 1px dashed #D9C6CA; border-radius: 5px; }
    .pdf-script-head { margin: 6px 0 2px; font-size: 11px; font-weight: 800; color: #111110; }
    .pdf-script-head.sa { color: #980C22; }
    .pdf-script p { margin: 2px 0; font-size: 12px; }
    .pdf-script .pdf-who { display: inline-block; min-width: 42px; font-weight: 800; }
    .pdf-script .script-blank { display: inline-block; min-width: 56px; border-bottom: 1px dashed #999994; color: transparent; }
    .pdf-script .script-act { color: #111110; }
  `;

  function esc(v) {
    return String(v || '').replace(/[&<>"']/g, function(ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // Same lines as renderDialogueScript() in index.html (both come from dialogue.js).
  function scriptHtml(s) {
    if (!s || !window.Dialogue) return '';
    const d = Dialogue.parts(s);
    const v = 'm';
    const line = function(who, text) {
      return '<p><span class="pdf-who">' + who + '</span> ' + Dialogue.toHtml(text, v) + '</p>';
    };
    return '<div class="pdf-script">' +
      '<div class="pdf-label" style="margin-top:0">บทสนทนามาตรฐาน' +
        '</div>' +
      '<div class="pdf-script-head sa">SA คุยกับลูกค้า (ใช้คลิปของช่าง)</div>' +
      d.main.map(function(t) { return line('SA', t); }).join('') +
      (d.replies.length
        ? '<div class="pdf-script-head sa">ถ้าลูกค้าตอบว่า…</div>' +
          d.replies.map(function(r) { return line('ลูกค้า', r[0]) + line('SA', r[1]); }).join('')
        : '') +
    '</div>';
  }

  function observationImages(item) {
    if (Array.isArray(item.images) && item.images.length) return item.images;
    return item.src ? [{ src: item.src, caption: item.caption || '' }] : [];
  }

  function buildDoc(t) {
    const issues = Array.isArray(t.issuesList) ? t.issuesList : [];
    const obs = Array.isArray(t.quickObservations) && t.quickObservations.length
      ? t.quickObservations : (t.observationPoints || []);
    const rawVideo = ((window.trainingData.videoUrls || {})[t.id] || '').trim();
    const videoLink = rawVideo.replace(/\?embed$/, '');
    const pageLink = new URL('./?topic=' + t.id, location.href).toString();

    const saHtml = issues.map(function(iss, i) {
      const pts = Array.isArray(iss.talkingPoints) && iss.talkingPoints.length
        ? '<div class="pdf-label">ประเด็นคุยกับลูกค้า</div><ul class="pdf-points">' +
          iss.talkingPoints.map(function(p) { return '<li>' + p + '</li>'; }).join('') + '</ul>'
        : '';
      return '<div class="pdf-item pdf-avoid">' +
        '<div class="pdf-item-head"><span class="pdf-num">' + (i + 1) + '</span><span>' + iss.issue + '</span></div>' +
        '<div class="pdf-body">' + pts +
          '<div class="pdf-label">บทสนทนามาตรฐาน</div>' +
          '<div class="pdf-grid">' +
            '<div class="pdf-box"><div class="pdf-label">1. แนะนำตัว (ถ่ายทะเบียนรถ)</div>' +
              '<p>สวัสดีครับ ผมช่างจาก HINO ชัยรัชการ ได้ตรวจเช็กรถ หมายเลขทะเบียน ________ ครับ โดยเช็ก 117 รายการ</p></div>' +
            '<div class="pdf-box"><div class="pdf-label">2. ปัญหาที่พบ (ค่อยๆ ถ่ายไปยังบริเวณที่พบปัญหา)</div>' +
              '<p>ปัญหาที่พบนะครับ ได้แก่ ' + esc(iss.issue) + ' ครับ</p></div>' +
          '</div>' +
          '<div class="pdf-grid">' +
            '<div class="pdf-box"><div class="pdf-label">3. วิธีการแก้ไข (ถ่ายบริเวณที่พบปัญหา)</div><p>' + (iss.solution || '-') + '</p></div>' +
            '<div class="pdf-box impact"><div class="pdf-label">4. ผลกระทบหากไม่แก้ไข (ถ่ายบริเวณที่พบปัญหา)</div><p>' + (iss.fix || '-') + '</p></div>' +
          '</div>' +
          scriptHtml(iss.script) +
        '</div>' +
      '</div>';
    }).join('');

    // Like the page: no technician section until the topic has photographed points.
    const techHtml = obs.map(function(item, i) {
          const imgs = observationImages(item);
          return '<div class="pdf-item pdf-avoid">' +
            '<div class="pdf-item-head"><span class="pdf-num">' + (i + 1) + '</span><span>' + item.title + '</span></div>' +
            '<div class="pdf-body">' +
              '<p class="pdf-text" style="margin-top:4px">' + (item.text || '') + '</p>' +
              (imgs.length ? '<div class="pdf-imgs">' + imgs.map(function(img) {
                return '<figure><img src="' + img.src + '" alt="">' +
                  (img.caption ? '<figcaption>' + img.caption + '</figcaption>' : '') + '</figure>';
              }).join('') + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('');

    const el = document.createElement('div');
    el.innerHTML = '<style>' + STYLE + '</style>' +
      '<div class="pdf-doc">' +
        '<div class="pdf-head">' +
          '<img src="chairatchakarn-group-logo.png" alt="">' +
          '<div class="pdf-head-org"><b>ชัยรัชการ (กรุงเทพ) จำกัด</b>การฝึกอบรม · ตรวจเช็ก 117 รายการ</div>' +
        '</div>' +
        '<div class="pdf-title">' + esc(t.title) + '</div>' +
        '<span class="pdf-cat">' + esc(t.category) + '</span>' +
        (saHtml ? '<div class="pdf-section"><div class="pdf-bar"><span class="pdf-bar-mark">SA</span>ข้อมูลสำหรับแนะนำลูกค้า</div>' + saHtml + '</div>' : '') +
        (techHtml ? '<div class="pdf-section"><div class="pdf-bar tech"><span class="pdf-bar-mark">ช่าง</span>' +
          'จุดสังเกตในการตรวจ' +
          (t.techDraft ? (t.sources ? ' (อ้างอิงเอกสาร รอคลิปยืนยัน)' : ' (ข้อมูลเบื้องต้น รอคลิปยืนยัน)') : '') + '</div>' + techHtml + '</div>' : '') +
        (Array.isArray(t.sources) && t.sources.length
          ? '<div class="pdf-foot pdf-avoid"><b>แหล่งอ้างอิง:</b> ' + t.sources.map(function(k) {
              return esc({ DLT: 'คู่มือการตรวจสภาพรถ กรมการขนส่งทางบก (ม.ค. 2566)', FMCSA: 'FMCSA 49 CFR 396 Appendix A',
                EXCEL: 'บทสนทนามาตรฐาน 117 รายการ ชัยรัชการ',
                CUMMINS: 'คู่มือ Operation & Maintenance เครื่องยนต์ Cummins',
                USMW: 'Technical Bulletin การรั่วของปั๊มน้ำ US Motor Works',
                GARRETT: 'คู่มือช่างเทอร์โบ Garrett Motion',
                PETERBILT: 'คู่มือบำรุงรักษารถบรรทุก Peterbilt (Conventional Models)',
                HINO_SB: 'Service Bulletin HINO SB-19-013 (เครื่องยนต์ J05E)',
                SPICER: 'แนวทางการหล่อลื่นข้อต่อ Spicer (Dana)',
                FREIGHTLINER: 'คู่มือบำรุงรักษารถบรรทุก Freightliner (Heavy-Duty Trucks)',
                REDDOT: 'คู่มือบริการระบบปรับอากาศรถบรรทุก Red Dot',
                MONROE: 'เกณฑ์ตรวจโช้คอัพ Monroe (Tenneco)',
                HENDRICKSON: 'คู่มือช่วงล่างถุงลมและเพลายก Hendrickson',
                DELCOREMY: 'คู่มือวิเคราะห์ระบบชาร์จไฟ Delco Remy',
              }[k] || k);
            }).join(' · ') + '</div>'
          : '') +
        '<div class="pdf-foot pdf-avoid">' +
          'หน้าหัวข้อออนไลน์: ' + esc(pageLink) +
          (videoLink ? '<br>วิดีโอการตรวจ: ' + esc(videoLink) : '') +
        '</div>' +
      '</div>';
    return el;
  }

  // Called from print.html: renders the handout for ?topic= and opens the print dialog.
  window.renderTopicHandout = function(mount) {
    const id = Number(new URLSearchParams(location.search).get('topic'));
    const t = (window.trainingData.topics || []).find(function(x) { return x.id === id && x.ready !== false; });
    if (!t) { mount.textContent = 'ไม่พบหัวข้อนี้'; return null; }
    document.title = 'ตรวจเช็ก-' + t.id + '-' + t.title.replace(/[\/:*?"<>|]/g, '').slice(0, 60);
    mount.appendChild(buildDoc(t));
    return t;
  };

  // Opened synchronously from the click so popup blockers allow it.
  window.downloadTopicPdf = function(topicId) {
    const win = window.open('print.html?topic=' + topicId, '_blank');
    if (!win) location.href = 'print.html?topic=' + topicId;
  };
})();
