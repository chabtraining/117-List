// Standard SA dialogue, shared by the topic page (index.html) and the PDF (topic-pdf.js).
// Lines are written in the male voice; voiceText() switches them to the female voice.
// Markers: ___ = blank to fill in, *text* = bold, [text] = stage direction.
(function() {
  const URGENCY = {};

  function parts(s) {
    const main = [
      'คุณลูกค้าครับ ขออนุญาตแจ้งผลการตรวจเช็กรถนะครับ ช่างถ่ายคลิปไว้ให้ดูด้วยครับ [เปิดคลิปให้ดู]',
      s.explain,
      s.risk,
      s.noQuote
        ? 'ทางศูนย์ของเรา' + s.recommend + 'ทุกครั้งครับ'
        : 'ผมเลยขอแนะนำให้' + s.recommend + 'นะครับ ใช้เวลาประมาณ ___ ค่าใช้จ่ายประมาณ ___ ครับ',
      s.close || 'ไม่ทราบว่าคุณลูกค้าสะดวกให้ช่างดำเนินการเลยไหมครับ'
    ].filter(Boolean);

    const replies = [];
    if (Array.isArray(s.objection) && s.objection[0] && s.objection[1]) replies.push(s.objection);
    if (!s.noQuote) {
      replies.push(
        ['ต้องถามเจ้าของรถก่อน',
         'ได้เลยครับ เดี๋ยวผมส่งคลิปนี้ให้เจ้าของรถทาง LINE นะครับ จะได้เห็นเหมือนที่เราดูกันอยู่ครับ ขอเบอร์โทรหรือ LINE ของเจ้าของรถได้ไหมครับ'],
        ['แพงไป / ร้านข้างนอกถูกกว่า',
         'เข้าใจครับ เดี๋ยวผมแยกราคาให้ดูทีละรายการนะครับ คุณลูกค้าจะได้พิจารณาได้ว่ารายการไหนทำวันนี้ รายการไหนรอรอบหน้าได้ครับ'],
        ['รถต้องออกวิ่งงาน รอไม่ได้',
         'เข้าใจครับ งานนี้ใช้เวลาประมาณ ___ ครับ ถ้าวันนี้ไม่สะดวก ผมนัดวันที่ ___ ให้ได้เลยครับ' +
         (s.urgency === 'now' ? ' แต่ข้อนี้ผมไม่แนะนำให้ใช้รถต่อทั้งที่ยังไม่ได้ซ่อมนะครับ' : '')],
        ['ยังไม่ซ่อม',
         'ได้ครับ ไม่เป็นไรครับ รบกวนคุณลูกค้าเซ็นรับทราบในใบสั่งงานไว้นะครับ ว่าทางเราได้แจ้งเรื่องนี้แล้ว แล้วผมขอนัดตรวจอีกครั้งวันที่ ___ นะครับ']
      );
    }
    return { urgency: null, main: main, replies: replies };
  }

  function voiceText(text, voice) {
    if (voice !== 'f') return text;
    return text
      .replace(/^คุณลูกค้าครับ/, 'คุณลูกค้าคะ')
      .replace(/นะครับ/g, 'นะคะ')
      .replace(/(ไหม|หรือเปล่า|หรือยัง|อะไร|ไหน|ยังไง|เท่าไหร่)ครับ/g, '$1คะ')
      .replace(/ครับ/g, 'ค่ะ')
      .replace(/ผม/g, 'ดิฉัน');
  }

  function toHtml(text, voice) {
    return String(voiceText(text || '', voice))
      .replace(/[&<>"']/g, function(ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      })
      .replace(/___/g, '<span class="script-blank">______</span>')
      .replace(/\*([^*]+)\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]/g, '<span class="script-act">($1)</span>');
  }

  // Remember the SA's choice on this device only.
  function getVoice() {
    try { return localStorage.getItem('charb-voice') === 'f' ? 'f' : 'm'; } catch (e) { return 'm'; }
  }
  function setVoice(v) {
    try { localStorage.setItem('charb-voice', v); } catch (e) {}
  }

  window.Dialogue = { URGENCY: URGENCY, parts: parts, toHtml: toHtml, getVoice: getVoice, setVoice: setVoice };
})();
