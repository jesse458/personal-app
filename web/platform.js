/* Platform layer for the standalone app.
   The app was written against claude.ai's `claude.use(name)` capabilities.
   This file provides the same interface backed by your own Supabase project,
   so the app code stays (almost) unchanged. */
(function () {
  const C = window.PA_CONFIG || {};
  window.PA_STANDALONE = true;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  let session = null;
  let resolveReady;
  const ready = new Promise(r => (resolveReady = r));

  /* ---------- sign-in gate ---------- */
  const css = `#pa-login{position:fixed;inset:0;z-index:50;background:#101010;color:#f2f2f2;display:grid;place-items:center;padding:24px;font:16px/1.5 "Space Grotesk",system-ui,sans-serif}
  #pa-login form{width:min(380px,100%);display:grid;gap:12px}#pa-login h1{font:800 34px/1.05 "Syne",system-ui,sans-serif;margin:0 0 6px;letter-spacing:-.02em}
  #pa-login input{padding:12px 14px;border-radius:12px;border:1px solid #333;background:#1b1b1b;color:#fff;font-size:16px;min-height:46px}
  #pa-login button{min-height:46px;border:0;border-radius:12px;font-weight:600;font-size:16px;cursor:pointer}
  #pa-login .p{background:#fff;color:#111}#pa-login .s{background:transparent;color:#bbb;border:1px solid #333}#pa-login .e{color:#ff8a80;min-height:22px;font-size:14px}`;
  function showLogin() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const d = document.createElement('div'); d.id = 'pa-login';
    d.innerHTML = '<form><h1>Personal App</h1><input name="email" type="email" placeholder="Email" autocomplete="username" required><input name="pw" type="password" placeholder="Password" autocomplete="current-password" minlength="8" required><button class="p">Sign in</button><button class="s" type="button" data-up>Create account (first time)</button><div class="e"></div></form>';
    document.body.appendChild(d);
    const f = d.querySelector('form'), err = d.querySelector('.e');
    const go = async (up) => {
      err.textContent = '';
      const email = f.email.value.trim(), password = f.pw.value;
      if (!email || password.length < 8) { err.textContent = 'Enter your email and a password of 8+ characters.'; return; }
      const r = up ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
      if (r.error) { err.textContent = r.error.message; return; }
      if (!r.data.session) { err.textContent = 'Check your email to confirm, then sign in.'; return; }
      session = r.data.session; d.remove(); resolveReady(session);
    };
    f.addEventListener('submit', e => { e.preventDefault(); go(false); });
    d.querySelector('[data-up]').addEventListener('click', () => go(true));
  }
  sb.auth.getSession().then(({ data }) => {
    if (data.session) { session = data.session; resolveReady(session); }
    else if (document.body) showLogin(); else addEventListener('DOMContentLoaded', showLogin);
  });
  sb.auth.onAuthStateChange((_e, s) => { if (s) session = s; });

  async function fn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let detail = null;
      try { detail = await error.context.json(); } catch (_) {}
      throw { code: (detail && detail.code) || 'upstream_error', message: (detail && detail.message) || error.message, connect: detail && detail.connect };
    }
    if (data && data.error) throw { code: data.code || 'tool_error', message: data.error, connect: data.connect };
    return data;
  }
  const uid = () => session && session.user.id;

  /* ---------- db: documents keyed by path, one row each ---------- */
  function db() {
    return {
      doc(path) {
        return {
          async get() {
            const { data, error } = await sb.from('app_docs').select('data').eq('user_id', uid()).eq('path', path).maybeSingle();
            if (error) throw error;
            return { exists: !!data, data: () => (data ? data.data : undefined) };
          },
          async set(value) {
            const { error } = await sb.from('app_docs').upsert({ user_id: uid(), path, data: value, updated_at: new Date().toISOString() });
            if (error) throw error;
          },
          onSnapshot(cb) {
            const ch = sb.channel('doc:' + path).on('postgres_changes',
              { event: '*', schema: 'public', table: 'app_docs', filter: 'user_id=eq.' + uid() },
              p => { if (p.new && p.new.path === path) cb({ exists: true, data: () => p.new.data }); }).subscribe();
            return () => sb.removeChannel(ch);
          }
        };
      }
    };
  }

  /* ---------- AI: Claude via your `ai` function, with page tools ---------- */
  async function sample(input, opts = {}) {
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input.slice();
    const tools = opts.tools || [];
    const defs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } }));
    let text = '';
    for (let i = 0; i < 8; i++) {
      const r = await fn('ai', { messages, tools: defs });
      text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (r.stop_reason !== 'tool_use') { opts.onText && opts.onText({ text }); return { text, truncated: r.stop_reason === 'max_tokens' }; }
      messages.push({ role: 'assistant', content: r.content });
      const results = [];
      for (const b of r.content.filter(b => b.type === 'tool_use')) {
        const t = tools.find(x => x.name === b.name);
        let out;
        try { out = t ? await t.execute(b.input || {}) : 'unknown tool'; out = typeof out === 'string' ? out : JSON.stringify(out); }
        catch (e) { out = 'error: ' + (e && e.message || e); }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: String(out) });
      }
      messages.push({ role: 'user', content: results });
      if (text && opts.onText) opts.onText({ text: text + '…' });
    }
    return { text, truncated: true };
  }
  sample.limits = async () => ({ images: false });

  /* ---------- connectors: weather, Google Calendar, Strava ---------- */
  const route = s => (/^AccuWeather/.test(s) ? 'weather' : s === 'Google Calendar' ? 'gcal' : s === 'Strava' ? 'strava' : null);
  function here() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(p => res(p.coords), rej, { maximumAge: 600000, timeout: 10000 });
    });
  }
  async function callTool(server, tool, input) {
    const f = route(server);
    if (!f) throw { code: 'server_not_connected', server };
    let inp = input;
    if (f === 'weather' && tool === 'widgets-search-claude' && /^(current|my) location$/i.test(String(input && input.queryParams && input.queryParams.query))) {
      try { const c = await here(); return { payload: { results: [{ locationKey: c.latitude.toFixed(3) + ',' + c.longitude.toFixed(3), name: 'Current location' }] } }; }
      catch (e) { throw { code: 'tool_error', message: 'Location permission is off for this app.' }; }
    }
    const payload = await fn(f, { tool, input: inp });
    return { payload, content: [] };
  }
  function watchTool(server, tool, input, handler, opts = {}) {
    let stop = false;
    const run = () => callTool(server, tool, input).then(r => { if (!stop) handler({ type: 'data', result: r }); }, e => { if (!stop) handler({ type: 'error', error: e }); });
    setTimeout(run, 0);
    const ms = Math.max(60000, opts.refetchInterval || 0);
    const t = opts.refetchInterval ? setInterval(() => { if (!document.hidden) run(); }, ms) : null;
    const vis = () => { if (!document.hidden && opts.refetchInterval) run(); };
    document.addEventListener('visibilitychange', vis);
    return () => { stop = true; if (t) clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }
  const mcp = {
    callTool, watchTool,
    listTools: async () => ({ servers: [{ server: 'AccuWeather' }, { server: 'Google Calendar' }, { server: 'Strava' }] }),
    describeTool: async () => { throw { code: 'bad_request' }; }
  };

  /* ---------- voice: Web Speech API ---------- */
  function dictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    let rec = null, P = () => {}, F = () => {}, ST = () => {};
    return {
      start() {
        return new Promise((res, rej) => {
          rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
          rec.onstart = () => { ST({ state: 'listening' }); res(); };
          rec.onerror = e => { ST({ state: 'idle', reason: e.error }); if (e.error === 'not-allowed') rej({ code: 'not_granted' }); };
          rec.onend = () => ST({ state: 'idle', reason: 'stopped' });
          rec.onresult = e => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const r = e.results[i];
              if (r.isFinal) F({ text: r[0].transcript.trim() }); else interim += r[0].transcript;
            }
            P({ text: interim.trim() });
          };
          try { rec.start(); } catch (err) { rej(err); }
        });
      },
      stop() { return new Promise(r => { if (!rec) return r(); rec.onend = () => { ST({ state: 'idle', reason: 'stopped' }); r(); }; rec.stop(); setTimeout(r, 1500); }); },
      onPartial: f => (P = f), onFinal: f => (F = f), onState: f => (ST = f)
    };
  }

  /* ---------- push notifications ---------- */
  const b64u = s => { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const push = {
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    status() {
      if (!push.supported()) return /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone ? 'install-first' : 'unsupported';
      return Notification.permission;
    },
    async enable() {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return perm;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) { const k = C.VAPID_PUBLIC_KEY || (await fn('notify', { vapid: true })).key; sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(k) }); }
      const j = sub.toJSON();
      const { error } = await sb.from('push_subs').upsert({ user_id: uid(), endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 200), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (error) throw error;
      return 'granted';
    },
    test: () => fn('notify', { test: true })
  };

  /* ---------- account connections (Google Calendar, Strava) ---------- */
  const PA = {
    async connect(which) { // 'gcal' | 'strava'
      const s = (await sb.auth.getSession()).data.session;
      location.href = C.SUPABASE_URL + '/functions/v1/' + which + '?action=connect&token=' + encodeURIComponent(s.access_token) + '&back=' + encodeURIComponent(location.origin + location.pathname);
    },
    async status() { try { return await fn('notify', { status: true }); } catch (e) { return {}; } },
    push, signOut: () => sb.auth.signOut().then(() => location.reload()), sb
  };
  window.PA = PA;

  /* ---------- the claude.use() interface the app expects ---------- */
  const caps = { db: db(), user: { id: async () => uid() }, sample, mcp, dictation: dictation() };
  window.claude = { use: async name => { await ready; return caps[name] ?? null; } };

  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
