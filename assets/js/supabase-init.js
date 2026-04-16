(function () {
  var c = window.SNH_CONFIG;
  if (!c || !c.supabaseUrl || !c.supabaseAnonKey) {
    console.error(
      '[SNH] Missing Supabase config. Run: node scripts/write-config.mjs (see README).'
    );
    return;
  }
  window.snhSupabase = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
})();
