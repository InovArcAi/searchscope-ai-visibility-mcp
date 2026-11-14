/**
 * Shared stylesheet for the Worker's HTML pages (the landing page and the API
 * docs), so both carry the same Search Scope palette and type.
 */
export const PAGE_CSS = `:root{--navy:#293057;--navy-deep:#1d2342;--teal:#2BD4C2;--teal-ink:#0C7268;--muted:#666C9E;--line:#E5E7EB;--paper:#F8F8FB;--ink:#1d2342;--card:#FFFFFF}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 "Outfit",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--teal-ink);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{color:var(--navy)}
.wrap{max-width:820px;margin:0 auto;padding:0 20px}
header{background:var(--navy);color:#fff;padding-block:28px}
header img{height:34px;width:auto;display:block}
header .wrap{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header .badge{margin-left:auto;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);border:1px solid rgba(43,212,194,.45);border-radius:999px;padding:5px 12px;white-space:nowrap}
h1{font-size:clamp(1.6rem,4.2vw,2.3rem);line-height:1.2;margin:36px 0 10px;color:var(--navy)}
.lede{font-size:1.08rem;color:#444a70;margin:0 0 28px}
h2{font-size:1.15rem;margin:34px 0 12px;color:var(--navy)}
h3{font-size:.97rem;margin:0 0 6px;color:var(--navy);font-family:ui-monospace,Menlo,Consolas,monospace}
.endpoint{background:var(--navy-deep);color:#fff;border-radius:12px;padding:18px 20px;margin:0 0 6px}
.endpoint span{display:block;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;color:var(--teal);margin-bottom:8px}
.endpoint code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:clamp(.82rem,2.6vw,1rem);word-break:break-all;color:#fff}
.note{font-size:.88rem;color:var(--muted);margin:0 0 24px}
ul.tools{list-style:none;padding:0;margin:0;display:grid;gap:12px}
ul.tools li{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--teal);border-radius:10px;padding:14px 16px}
ul.tools p{margin:0;font-size:.93rem;color:#4a5070}
.cta{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin:30px 0}
.cta p{margin:0 0 14px}
.btn{display:inline-block;background:var(--navy);color:#fff;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:8px}
.btn:hover{background:var(--navy-deep);color:#fff}
.btn.ghost{background:transparent;color:var(--navy);border:1px solid var(--navy);margin-left:8px}
.btn.ghost:hover{background:var(--navy);color:#fff}
footer{border-top:1px solid var(--line);margin-top:40px;padding-block:26px 40px;font-size:.88rem;color:var(--muted)}
footer a{color:var(--muted)}
@media (max-width:430px){.btn.ghost{margin:10px 0 0;display:block;text-align:center}}
@media (prefers-color-scheme:dark){
:root{--paper:#14172b;--ink:#e8e9f3;--card:#1c2038;--line:#2b3052;--muted:#9aa0c8}
h1,h2,h3{color:#fff}.lede{color:#b9bede}ul.tools p{color:#b9bede}
a{color:var(--teal)}a:hover{color:#fff}
.btn{background:var(--teal);color:#10233f}.btn:hover{background:#4fe0d1;color:#10233f}
.btn.ghost{color:#fff;border-color:#4b5280}
}
`;
