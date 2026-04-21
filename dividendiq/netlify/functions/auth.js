/**
 * DividendIQ — Netlify Function: Supabase Auth + Portfolio
 * 
 * Actions:
 *   register   → E-Mail/Passwort Registrierung
 *   login      → E-Mail/Passwort Login
 *   logout     → Session beenden
 *   save       → Portfolio in DB speichern
 *   load       → Portfolio aus DB laden
 *   profile    → User-Plan updaten (free/pro)
 *   delete     → Account löschen
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Supabase REST API helper
async function supabase(path, options = {}, useServiceKey = false) {
  const key = useServiceKey ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${options.token || key}`,
      ...options.headers,
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// Supabase Auth API helper
async function supabaseAuth(path, body, token = null) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  const { action } = body;
  const authHeader = event.headers?.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  try {

    // ── REGISTER ─────────────────────────────────────────
    if (action === 'register') {
      const { email, password, name } = body;
      if (!email || !password || !name) {
        return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'Name, E-Mail und Passwort erforderlich' }) };
      }
      if (password.length < 8) {
        return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'Passwort muss mindestens 8 Zeichen haben' }) };
      }

      const res = await supabaseAuth('/signup', {
        email,
        password,
        data: { name, plan: 'free' },
      });

      if (!res.ok) {
        const msg = res.data?.msg || res.data?.message || 'Registrierung fehlgeschlagen';
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg }) };
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        user: {
          id:    res.data.user?.id,
          email: res.data.user?.email,
          name:  res.data.user?.user_metadata?.name || name,
          plan:  res.data.user?.user_metadata?.plan || 'free',
        },
        token: res.data.access_token,
        refresh_token: res.data.refresh_token,
      })};
    }

    // ── LOGIN ─────────────────────────────────────────────
    if (action === 'login') {
      const { email, password } = body;
      const res = await supabaseAuth('/token?grant_type=password', { email, password });

      if (!res.ok) {
        const msg = res.data?.error_description || res.data?.message || 'E-Mail oder Passwort falsch';
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: msg }) };
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        user: {
          id:    res.data.user?.id,
          email: res.data.user?.email,
          name:  res.data.user?.user_metadata?.name || email.split('@')[0],
          plan:  res.data.user?.user_metadata?.plan || 'free',
        },
        token: res.data.access_token,
        refresh_token: res.data.refresh_token,
      })};
    }

    // ── FORGOT PASSWORD ───────────────────────────────────
    if (action === 'forgot_password') {
      const { email } = body;
      const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json();
        return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: data.message || 'Fehler beim Senden' }) };
      }
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ success: true }) };
    }
    if (action === 'refresh') {
      const { refresh_token } = body;
      const res = await supabaseAuth('/token?grant_type=refresh_token', { refresh_token });
      if (!res.ok) {
        return { statusCode: 401, headers: CORS,
          body: JSON.stringify({ error: 'Session abgelaufen, bitte neu anmelden' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        token: res.data.access_token,
        refresh_token: res.data.refresh_token,
      })};
    }

    // ── SAVE PORTFOLIO ────────────────────────────────────
    if (action === 'save') {
      if (!token) return { statusCode: 401, headers: CORS,
        body: JSON.stringify({ error: 'Nicht eingeloggt' }) };

      const { holdings, user_id } = body;

      // Upsert — insert or update based on user_id
      const res = await supabase('/rest/v1/portfolios', {
        method: 'POST',
        token,
        headers: {
          'Prefer': 'resolution=merge-duplicates',
          'on_conflict': 'user_id',
        },
        body: JSON.stringify({
          user_id,
          holdings: JSON.stringify(holdings),
        }),
      });

      if (!res.ok) {
        // Try update instead
        const upd = await supabase(
          `/rest/v1/portfolios?user_id=eq.${user_id}`,
          {
            method: 'PATCH',
            token,
            body: JSON.stringify({ holdings: JSON.stringify(holdings) }),
          }
        );
        if (!upd.ok) {
          return { statusCode: 500, headers: CORS,
            body: JSON.stringify({ error: 'Portfolio konnte nicht gespeichert werden' }) };
        }
      }

      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ success: true }) };
    }

    // ── LOAD PORTFOLIO ────────────────────────────────────
    if (action === 'load') {
      if (!token) return { statusCode: 401, headers: CORS,
        body: JSON.stringify({ error: 'Nicht eingeloggt' }) };

      const { user_id } = body;
      const res = await supabase(
        `/rest/v1/portfolios?user_id=eq.${user_id}&select=holdings`,
        { method: 'GET', token }
      );

      if (!res.ok || !res.data?.length) {
        return { statusCode: 200, headers: CORS,
          body: JSON.stringify({ holdings: [] }) };
      }

      let holdings = [];
      try { holdings = JSON.parse(res.data[0].holdings || '[]'); } catch {}
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ holdings }) };
    }

    // ── UPDATE PROFILE (name, plan) ───────────────────────
    if (action === 'update_profile') {
      if (!token) return { statusCode: 401, headers: CORS,
        body: JSON.stringify({ error: 'Nicht eingeloggt' }) };

      const { name, plan } = body;
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ data: { name, plan } }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: data.message || 'Update fehlgeschlagen' }) };
      }
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ success: true }) };
    }

    // ── DELETE ACCOUNT ────────────────────────────────────
    if (action === 'delete_account') {
      if (!token) return { statusCode: 401, headers: CORS,
        body: JSON.stringify({ error: 'Nicht eingeloggt' }) };

      const { user_id } = body;

      // Delete portfolio first
      await supabase(`/rest/v1/portfolios?user_id=eq.${user_id}`,
        { method: 'DELETE', token });

      // Delete user (requires service key)
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      });

      if (!res.ok) {
        return { statusCode: 500, headers: CORS,
          body: JSON.stringify({ error: 'Account konnte nicht gelöscht werden' }) };
      }
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch(err) {
    console.error('Auth error:', err.message);
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message }) };
  }
};
