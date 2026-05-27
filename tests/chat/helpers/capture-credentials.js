// Credential capture for Tier 2 tests — paste body into chrome-devtools-mcp
// `evaluate_script` against the Pinako extension SW (DebugProfile).
//
// Returns the three secrets needed for a Tier 2 EF round:
//   - jwt:          Supabase access token (1-hour lifetime — re-capture if stale)
//   - apikey:       Supabase anon key (long-lived; static for the project)
//   - anthropicToken: BYO Anthropic token (sk-ant-oat01-... OAuth OR sk-ant-api... key)
//
// Storage keys (verified against Pinako/background.js:1887-1889):
//   - 'sb-skhzrroqdoekyzgmcdhz-auth-token' (raw JSON or string; access_token inside)
//   - 'chat_byo_anthropic_token' (plain string)
//
// The anon key is hard-coded in background.js (it's the project's public
// anon key — same as in any deployed Supabase frontend, no secret). We
// fetch it from chrome.storage too in case future versions move it, with
// a fallback to the known value.
//
// SECURITY: these secrets stay in this transcript and any test artifacts
// (e.g. .env.test). The Supabase JWT and Anthropic token are credentials
// to your accounts — handle accordingly. The anon key is public.
//
// Usage (manual orchestration via chrome-devtools-mcp):
//   await mcp__chrome-devtools__evaluate_script({
//     serviceWorkerId: '<sw-id>',
//     function: `async () => { ${captureCredentialsBody} }`,
//   });

async function captureCredentials() {
    const SESSION_KEY = 'sb-skhzrroqdoekyzgmcdhz-auth-token';
    const ANON_FALLBACK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNraHpycm9xZG9la3l6Z21jZGh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0OTQyMTAsImV4cCI6MjA4NjA3MDIxMH0.LOguPXnXZZJE-q7e7rKgsLW9UF0a8dg6JG-NXCHqTKg';

    const stored = await chrome.storage.local.get([
        SESSION_KEY,
        'chat_byo_anthropic_token',
        'chat_byo_gemini_token',
    ]);

    let jwt = null;
    let userId = null;
    let expiresAt = null;
    const rawSession = stored[SESSION_KEY];
    if (rawSession) {
        try {
            const session = typeof rawSession === 'string' ? JSON.parse(rawSession) : rawSession;
            jwt = session?.access_token || null;
            userId = session?.user?.id || null;
            expiresAt = session?.expires_at || null;
        } catch (_) {}
    }

    const anthropicToken = stored.chat_byo_anthropic_token || null;
    const geminiToken = stored.chat_byo_gemini_token || null;

    // Tier check via Supabase (so the test can fail fast if the signed-in
    // account is on a tier that the EF will reject anyway).
    let tier = null;
    if (jwt && userId) {
        try {
            const url = `https://skhzrroqdoekyzgmcdhz.supabase.co/rest/v1/subscriptions?user_id=eq.${userId}&select=tier`;
            const res = await fetch(url, {
                headers: { apikey: ANON_FALLBACK, Authorization: `Bearer ${jwt}` },
            });
            if (res.ok) {
                const rows = await res.json();
                tier = rows?.[0]?.tier ?? 0;
            }
        } catch (_) {}
    }

    const now = Math.floor(Date.now() / 1000);
    const tokenStillFresh = expiresAt && expiresAt > now + 60;

    return {
        ok: !!(jwt && anthropicToken),
        jwt,
        apikey: ANON_FALLBACK,
        anthropicToken,
        geminiToken,
        userId,
        tier,
        expiresAt,
        secondsUntilExpiry: expiresAt ? expiresAt - now : null,
        tokenStillFresh,
        // Diagnostic flags so the orchestrator can give clean error messages
        // if something is missing instead of failing at the EF.
        missing: {
            session: !jwt,
            anthropicToken: !anthropicToken,
            tierTooLow: tier != null && tier < 1,
        },
    };
}

// When this file is pasted into evaluate_script directly, the IIFE form
// is the right shape. The `captureCredentials` reference above is for
// programmatic import; chrome-devtools-mcp's evaluate_script takes a
// function literal so the orchestrator wraps the body.
captureCredentials;
