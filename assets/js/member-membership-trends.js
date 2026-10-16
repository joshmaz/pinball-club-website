(function () {
  "use strict";
  var metrics = [["account_count", "Registered accounts"], ["basic_count", "Basic Members"],
    ["full_access_count", "Full Access Members"], ["volunteer_count", "Website Volunteers"], ["unverified_count", "Unverified accounts without Full Access"]];
  function add(tag, text, parent) {
    var node = document.createElement(tag); node.textContent = text; parent.appendChild(node); return node;
  }
  async function render(root) {
    root.replaceChildren();
    try {
      var result = await window.snhSupabase.rpc("snh_get_membership_trends");
      if (result.error) throw result.error;
      var rows = result.data;
      if (!rows.length) { add("p", "History will begin with the next daily snapshot at 4 a.m. Eastern. Earlier membership totals are not available.", root); return; }
      add("p", "Daily snapshots at 4 a.m. Eastern, retained indefinitely. Each monthly point uses the last available snapshot; dates appear below. Volunteers overlap membership groups. Unverified accounts here exclude Full Access Members.", root);
      var label = add("label", "Show ", root);
      var select = add("select", "", label);
      metrics.forEach(function (pair) { var option = add("option", pair[1], select); option.value = pair[0]; });
      select.value = metrics[0][0];
      var plot = add("div", "", root);
      var note = add("p", "", root);
      function draw() {
        plot.replaceChildren();
        var metric = metrics.find(function (pair) { return pair[0] === select.value; });
        var title = metric[1] + " by month";
        var ns = "http://www.w3.org/2000/svg";
        function svgEl(tag, attrs, text) {
          var el = document.createElementNS(ns, tag);
          Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
          if (text) el.textContent = text; return el;
        }
        var svg = svgEl("svg", { viewBox: "0 0 720 250", role: "img", "aria-label": title + ". X axis: month. Y axis: number of accounts. Exact counts and dates are in the table below.", width: "100%" });
        svg.appendChild(svgEl("title", {}, title));
        var max = Math.max(1, ...rows.map(function (r) { return Number(r[metric[0]]); }));
        var startMonth = rows[0].snapshot_date.slice(0,7);
        function monthIndex(date) { return Number(date.slice(0,4))*12+Number(date.slice(5,7)); }
        var first = monthIndex(startMonth), last = monthIndex(rows[rows.length-1].snapshot_date);
        function x(r) { return 65 + (monthIndex(r.snapshot_date)-first)/Math.max(1,last-first)*610; }
        function y(r) { return 195-Number(r[metric[0]])/max*155; }
        svg.appendChild(svgEl("path", { d: "M65 35 V195 H685", fill: "none", stroke: "currentColor" }));
        svg.appendChild(svgEl("text", { x: 15, y: 30, fill: "currentColor", "font-size": "12" }, "Accounts"));
        svg.appendChild(svgEl("text", { x: 350, y: 242, fill: "currentColor", "font-size": "12" }, "Month"));
        [0,Math.ceil(max/2),max].forEach(function (v) { svg.appendChild(svgEl("text", { x: 55,y: 199-v/max*155,"text-anchor":"end",fill:"currentColor","font-size":"12" },String(v))); });
        // Separate segments across missing months rather than implying measured history.
        rows.forEach(function (r,i) {
          if (i && monthIndex(r.snapshot_date)-monthIndex(rows[i-1].snapshot_date)===1) svg.appendChild(svgEl("path", { d:"M"+x(rows[i-1])+" "+y(rows[i-1])+" L"+x(r)+" "+y(r),stroke:"currentColor",fill:"none","stroke-width":"2" }));
          var dot = svgEl("circle", { cx:x(r),cy:y(r),r:4,fill:"currentColor" });
          dot.appendChild(svgEl("title", {},r.snapshot_date+": "+r[metric[0]])); svg.appendChild(dot);
          if (rows.length<7 || i%2===0 || i===rows.length-1) svg.appendChild(svgEl("text", { x:x(r),y:218,"text-anchor":"middle",fill:"currentColor","font-size":"11" },r.snapshot_date.slice(0,7)));
        });
        plot.appendChild(svg);
        var current;
        // Compare numeric parts independent of the browser's localized date separator.
        var parts = new Intl.DateTimeFormat("en", { timeZone:"America/New_York",year:"numeric",month:"2-digit" }).formatToParts(new Date());
        current = parts.find(function(p){return p.type==="year";}).value+"-"+parts.find(function(p){return p.type==="month";}).value;
        note.textContent = title + ". Latest snapshot: " + rows[rows.length-1].snapshot_date +
          (rows[rows.length-1].snapshot_date.slice(0,7)===current ? ". Current month is partial." : ".") + " Missing months are not interpolated.";
      }
      select.addEventListener("change", draw); draw();
      var table = add("table", "", root); table.className = "members-admin-table";
      add("caption", "Monthly membership counts, latest available daily snapshot in each month", table);
      var head = add("tr", "", add("thead", "", table));
      ["Snapshot date"].concat(metrics.map(function(p){return p[1];})).forEach(function(t){var th=add("th",t,head);th.scope="col";});
      var body = add("tbody", "", table);
      rows.forEach(function(r){var tr=add("tr","",body);add("td",r.snapshot_date,tr);metrics.forEach(function(p){add("td",String(r[p[0]]),tr);});});
    } catch (_error) { root.replaceChildren(); add("p", "Membership history could not be loaded. Close and reopen this section to retry.", root); }
  }
  window.SNHMembershipTrends = { render: render };
})();
