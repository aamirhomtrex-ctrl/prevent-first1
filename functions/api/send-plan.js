// Cloudflare Pages Function: /api/send-plan
// Sends the approved Prevent First reminder plan via Brevo (email) and Telegram.

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const hits = new Map();

const esc = s => String(s == null ? '' : s).replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function toObject(v) {
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch (e) { return {}; }
  }
  return (v && typeof v === 'object') ? v : {};
}

function fmtDate(iso, ar) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso || ''));
  if (!m) return ar ? 'يُحدَّد الموعد لاحقاً' : 'date to be confirmed';
  const day = ar ? `${+m[3]} ${AR_MONTHS[+m[2] - 1]} ${m[1]}` : `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  if (m[4] === undefined) return day;
  const h = +m[4];
  return ar ? `${day}، ${h % 12 || 12}:${m[5]} ${h >= 12 ? 'م' : 'ص'}` : `${day}, ${h % 12 || 12}:${m[5]} ${h >= 12 ? 'PM' : 'AM'}`;
}

const FALLBACK_AR = {
  why: 'تشير إجاباتك إلى أن هذا هو المجال الذي ينبغي البدء به. هذا دليل للفحص مبني على ما ذكرته وليس تشخيصاً.',
  protocol: [
    'الأيام 1-7: احجز الفحوصات المذكورة أعلاه مع طبيبك وأجرِها، وسجّل قراءتين لضغط الدم في الصباح وأنت جالس.',
    'الأيام 8-20: استبدل الوجبات الخفيفة المقلية والدهون المهدرجة بالمكسرات وزيت الزيتون والأطعمة الغنية بالألياف كالبقوليات، وقلّل السكر المضاف والملح.',
    'الأيام 21-30: ارفع نشاطك تدريجياً إلى 150 دقيقة أسبوعياً من النشاط المعتدل (مشي سريع)، وراجع نتائجك مع طبيبك.'
  ]
};

const FALLBACK = {
  why: 'Your answers point to this as the area to look at first. This is a screening guide based on what you told us, not a diagnosis.',
  protocol: [
    'Days 1-7: Book and complete the tests listed above with your doctor; record two seated morning blood pressure readings.',
    'Days 8-20: Swap deep-fried snacks and hydrogenated fats for nuts, olive oil and high-fibre foods such as legumes; cut added sugar and salt.',
    'Days 21-30: Build up to 150 minutes a week of moderate activity (brisk walking) and review your results and risk score with your doctor.'
  ]
};

async function extras(env, focus, higher, tests, ar) {
  const FB = ar ? FALLBACK_AR : FALLBACK;
  if (!env.GEMINI_API_KEY) return FB;
  try {
    const prompt = 'You write a short, careful prevention note for a patient. Condition focus: ' + focus + '. Also higher risk for: ' + (higher.join(', ') || 'none') + '. Tests planned: ' + (tests.join(', ') || 'none') + '. Return ONLY JSON: {"why": "2 plain sentences on why this matters and that this is screening, not diagnosis", "protocol": ["Days 1-7: ...", "Days 8-20: ...", "Days 21-30: ..."]}. Rules: no drug names or doses, no diagnosis, each protocol item under 35 words, tell them to follow their doctor.' + (ar ? ' Write every string value in clear Modern Standard Arabic (keep the "Days 1-7" style as "الأيام 1-7").' : '');
    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
      })
    });
    clearTimeout(timer);
    if (!r.ok) return FB;
    const j = await r.json();
    const t = j.candidates && j.candidates[0] && j.candidates[0].content.parts[0].text;
    const o = JSON.parse(t);
    const proto = (Array.isArray(o.protocol) ? o.protocol : []).slice(0, 4).map(x => clip(x, 300)).filter(Boolean);
    const why = clip(o.why, 400);
    return (proto.length >= 2 && why) ? { why, protocol: proto } : FB;
  } catch (e) {
    return FB;
  }
}

function buildAr(focus, tests, higher, events, ex) {
  const disclaimer = 'معلومات ذاتية وليست تشخيصاً. يرجى استشارة الطبيب بشأن أي أمر يقلقك.';
  const text = [
    'الوقاية أولاً - خطة التذكير الخاصة بك',
    'المحور: ' + focus,
    higher.length ? 'خطر أعلى أيضاً في: ' + higher.join('، ') : '',
    tests.length ? 'فحوصات اسأل عنها: ' + tests.join('، ') : '',
    '',
    ...events.map(e => `- ${e.when}: ${e.title}`),
    '',
    'لماذا هذا مهم: ' + ex.why,
    '',
    'برنامجك الوقائي لمدة 30 يوماً:',
    ...ex.protocol.map(x => '- ' + x),
    '',
    disclaimer
  ].join('\n');
  const rows = events.map(e => `<tr><td style="padding:10px 12px;border-bottom:1px solid #e3e8e6;font-weight:600;white-space:nowrap">${esc(e.when)}</td><td style="padding:10px 12px;border-bottom:1px solid #e3e8e6">${esc(e.title)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="ar" dir="rtl"><body dir="rtl" style="margin:0;background:#f4f7f6;font-family:Tahoma,Arial,sans-serif;color:#14211e;text-align:right"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;border:1px solid #dbe3e0"><tr><td style="padding:22px 24px;background:#0f5c4d;color:#fff;border-radius:10px 10px 0 0"><div style="font-size:20px;font-weight:700">الوقاية أولاً</div><div style="font-size:14px">خطة التذكير المعتمدة الخاصة بك</div></td></tr><tr><td style="padding:22px 24px"><p style="margin:0 0 12px;font-size:16px">المحور: <strong>${esc(focus)}</strong></p>${higher.length ? `<p style="margin:0 0 12px;font-size:15px">خطر أعلى أيضاً في: <strong>${esc(higher.join('، '))}</strong></p>` : ''}${tests.length ? `<p style="margin:0 0 16px;font-size:15px">فحوصات اسأل طبيبك عنها: ${esc(tests.join('، '))}</p>` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e8e6;font-size:15px">${rows}</table><p style="margin:16px 0 0;font-size:15px"><strong>لماذا هذا مهم.</strong> ${esc(ex.why)}</p><h3 style="margin:16px 0 6px;font-size:16px;color:#0f5c4d">برنامجك الوقائي لمدة 30 يوماً</h3><ul style="margin:0;padding-right:20px;font-size:15px;line-height:1.7">${ex.protocol.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p style="margin:18px 0 0;font-size:13px;color:#5b6b66">${esc(disclaimer)} إذا شعرت بألم في الصدر أو صعوبة في التنفس أو تدلٍّ في الوجه أو ضعف مفاجئ، فاتصل بالطوارئ فوراً.</p></td></tr></table></td></tr></table></body></html>`;
  return { focus, text, html, subject: 'تذكيرات الوقاية أولاً: ' + focus };
}

function build(data, ex) {
  const AR = data.lang === 'ar' && data.ar && typeof data.ar === 'object';
  ex = ex || (AR ? FALLBACK_AR : FALLBACK);
  const A = AR ? data.ar : {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const focus = clip((AR && A.focus) || data.focus_condition || 'your health check', 120);
  const tests = (AR && arr(A.tests).length ? arr(A.tests) : arr(data.tests)).slice(0, 12).map(t => clip(t, 120));
  const higher = (AR && arr(A.higher).length ? arr(A.higher) : arr(data.conditions_higher_risk)).slice(0, 12).map(t => clip(t, 100));
  const events = (Array.isArray(data.events) ? data.events : []).slice(0, 6).map((e, i) => ({
    title: clip((AR && arr(A.titles)[i]) || e.title || 'Reminder', 200),
    when: fmtDate(e.start, AR)
  }));
  if (AR) return buildAr(focus, tests, higher, events, ex);
  const disclaimer = 'Self-reported information. Not a diagnosis. Please talk to a doctor about anything that worries you.';
  const text = [
    'Prevent First - your reminder plan',
    'Focus: ' + focus,
    higher.length ? 'Also higher risk for: ' + higher.join(', ') : '',
    tests.length ? 'Tests to ask about: ' + tests.join(', ') : '',
    '',
    ...events.map(e => `- ${e.when}: ${e.title}`),
    '',
    'Why this matters: ' + ex.why,
    '',
    'Your 30-Day Preventative Protocol:',
    ...ex.protocol.map(x => '- ' + x),
    '',
    disclaimer
  ].join('\n');
  const rows = events.map(e => `<tr><td style="padding:10px 12px;border-bottom:1px solid #e3e8e6;font-weight:600;white-space:nowrap">${esc(e.when)}</td><td style="padding:10px 12px;border-bottom:1px solid #e3e8e6">${esc(e.title)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#14211e"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;border:1px solid #dbe3e0"><tr><td style="padding:22px 24px;background:#0f5c4d;color:#fff;border-radius:10px 10px 0 0"><div style="font-size:20px;font-weight:700">Prevent First</div><div style="font-size:14px">Your approved reminder plan</div></td></tr><tr><td style="padding:22px 24px"><p style="margin:0 0 12px;font-size:16px">Focus: <strong>${esc(focus)}</strong></p>${higher.length ? `<p style="margin:0 0 12px;font-size:15px">Also higher risk for: <strong>${esc(higher.join(', '))}</strong></p>` : ''}${tests.length ? `<p style="margin:0 0 16px;font-size:15px">Tests to ask your doctor about: ${esc(tests.join(', '))}</p>` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e8e6;font-size:15px">${rows}</table><p style="margin:16px 0 0;font-size:15px"><strong>Why this matters.</strong> ${esc(ex.why)}</p><h3 style="margin:16px 0 6px;font-size:16px;color:#0f5c4d">Your 30-Day Preventative Protocol</h3><ul style="margin:0;padding-left:20px;font-size:15px;line-height:1.5">${ex.protocol.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p style="margin:18px 0 0;font-size:13px;color:#5b6b66">${esc(disclaimer)} If you have chest pain, trouble breathing, face drooping or sudden weakness, call emergency services now.</p></td></tr></table></td></tr></table></body></html>`;
  return { focus, text, html, subject: 'Your Prevent First reminders: ' + focus };
}

async function sendTelegram(env, username, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { status: 'unavailable', note: 'Telegram is not set up on this site' };
  const bot = env.TELEGRAM_BOT_USERNAME || '';
  try {
    const u = await fetch('https://api.telegram.org/bot' + token + '/getUpdates?limit=100&timeout=0');
    const j = await u.json();
    if (!j.ok) return { status: 'error', note: 'Telegram says: ' + clip(j.description, 80) };
    let chat = null;
    for (const up of (j.result || []).slice().reverse()) {
      const m = up.message || up.edited_message;
      const f = m && m.from;
      if (f && f.username && f.username.toLowerCase() === username.toLowerCase() && m.chat && m.chat.type === 'private') {
        chat = m.chat.id;
        break;
      }
    }
    if (!chat) return { status: 'not_started', bot };
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: clip(text, 3800) })
    });
    return r.ok ? { status: 'sent' } : { status: 'error', note: 'Telegram replied ' + r.status };
  } catch (e) {
    return { status: 'error', note: 'could not reach Telegram' };
  }
}

const reply = (code, obj, origin) => new Response(code === 204 ? null : JSON.stringify(obj), {
  status: code,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  }
});

export async function onRequest(context) {
  const { request, env } = context;
  const origin = env.ALLOWED_ORIGIN || '*';

  if (request.method === 'OPTIONS') return reply(204, {}, origin);
  if (request.method !== 'POST') return reply(405, { ok: false, error: 'Use POST' }, origin);

  const reqOrigin = request.headers.get('origin') || '';
  if (env.ALLOWED_ORIGIN && reqOrigin && reqOrigin !== env.ALLOWED_ORIGIN) {
    return reply(403, { ok: false, error: 'Origin not allowed' }, origin);
  }

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (arr.length >= 15) return reply(429, { ok: false, error: 'Too many requests. Try again later.' }, origin);
  arr.push(now); hits.set(ip, arr);

  const raw = await request.text();
  if (raw.length > 20000) return reply(413, { ok: false, error: 'Too large' }, origin);
  const data = toObject(raw);
  if (data.source !== 'prevent-first') return reply(400, { ok: false, error: 'Unexpected payload' }, origin);

  const email = clip(data.recipient && data.recipient.email, 200).trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const tgName = clip(data.recipient && data.recipient.telegram, 40).trim().replace(/^@/, '');
  const tgOk = /^[A-Za-z0-9_]{5,32}$/.test(tgName);

  const _h = (Array.isArray(data.conditions_higher_risk) ? data.conditions_higher_risk : []).slice(0, 12).map(t => clip(t, 80));
  const _t = (Array.isArray(data.tests) ? data.tests : []).slice(0, 12).map(t => clip(t, 80));
  const plan = build(data, (emailOk || tgOk) ? await extras(env, clip(data.focus_condition || 'your health check', 120), _h, _t, data.lang === 'ar') : null);
  const result = { ok: true, email: 'skipped' };

  if (emailOk) {
    if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) return reply(500, { ok: false, error: 'Email service is not configured' }, origin);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: env.SENDER_NAME || 'Prevent First', email: env.SENDER_EMAIL },
        to: [{ email }],
        subject: plan.subject,
        htmlContent: plan.html,
        textContent: plan.text
      })
    });
    if (!r.ok) return reply(502, { ok: false, error: 'Email provider replied ' + r.status }, origin);
    result.email = 'sent';
  }

  if (tgOk) {
    const t = await sendTelegram(env, tgName, plan.text);
    result.telegram = t.status;
    if (t.bot) result.bot = t.bot;
    if (t.note) result.telegram_note = t.note;
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `Prevent First: a reminder plan was approved (email ${result.email}).`
        })
      });
    } catch (e) {}
  }

  return reply(200, result, origin);
}
