/**
 * Privacy page for Search Scope's browser extension ("AI Visibility Audit by
 * Search Scope", Microsoft Edge Add-ons), served at /extension/privacy and
 * linked from the store listing and the extension's popup. It describes what
 * the extension in the separate extension repository actually does: keep the
 * two in step when either changes.
 */

import { page } from "../api/docs";
import { PUBLISHER, PUBLISHER_CONTACT_URL, PUBLISHER_URL } from "../config";

export const EXTENSION_PRIVACY_PATH = "/extension/privacy";

export function extensionPrivacyHtml(): string {
  return page({
    title: `Privacy: AI Visibility Audit browser extension by ${PUBLISHER}`,
    description: `What the AI Visibility Audit browser extension by ${PUBLISHER} reads, what it sends, and what is kept.`,
    robots: "index, follow",
    badge: "Browser extension",
    body: `<h1>Privacy: AI Visibility Audit browser extension</h1>
<p class="lede">The extension checks how ready a website is to be found and cited by AI search. It is free, needs no account and collects as little as it can. Last updated 15 November 2026.</p>
<h2>What the extension reads</h2>
<p>When you click its toolbar icon, the extension reads the address of the tab you are on, through the browser's activeTab permission. It reads nothing else: not the page's content, other tabs, your browsing history, cookies, passwords or form entries.</p>
<h2>What it sends, and when</h2>
<p>Nothing is sent until you press <strong>Audit this site</strong>. Then the site's address, reduced to its scheme and domain (for example <code>https://example.com.au/</code>, without the page path or any query string), is sent to the ${PUBLISHER} audit service at <code>mcp.searchscope.com.au</code>. As with any web request, your browser also sends standard connection details such as your IP address.</p>
<h2>What the service does with it</h2>
<p>The service fetches a small sample of that site's public pages, analyses them in memory and returns the result to the extension. It sets no cookies, has no user accounts and does not save the audit results. Your IP address is used as a short-lived counter to enforce the free usage limits.</p>
<p>The service runs on Cloudflare, whose platform keeps operational logs for a sample of requests (such as the time, the endpoint called, the response status and network details) for a limited period. ${PUBLISHER} uses them only to keep the service running and to stop abuse, and does not sell them or use them for marketing.</p>
<h2>What stays on your device</h2>
<p>The extension stores nothing on your device and contains no analytics, advertising or tracking code. The audit result lives only in the open popup and is gone when you close it, unless you copy the report yourself.</p>
<h2>Questions</h2>
<p>${PUBLISHER}'s full privacy policy is at <a href="${PUBLISHER_URL}privacy-policy/">${PUBLISHER_URL}privacy-policy/</a>. For anything about this extension, contact us at <a href="${PUBLISHER_CONTACT_URL}">${PUBLISHER_CONTACT_URL}</a>.</p>`,
  });
}
