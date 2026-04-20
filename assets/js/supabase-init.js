(function () {
  var c = window.SNH_CONFIG;
  if (!c || !c.supabaseUrl || !c.supabaseAnonKey) {
    window.snhSupabaseError = 'missing_config';
    console.error(
      '[SNH] Missing Supabase config. Run: node scripts/write-config.mjs (see README).'
    );
    return;
  }
  var sup = window.supabase;
  if (!sup || typeof sup.createClient !== 'function') {
    window.snhSupabaseError = 'missing_client';
    console.error(
      '[SNH] @supabase/supabase-js did not load. Check script order and the CDN script tag.'
    );
    return;
  }
  window.snhSupabase = sup.createClient(c.supabaseUrl, c.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  window.snhSupabaseError = null;
})();
