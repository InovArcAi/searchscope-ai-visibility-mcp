/**
 * Privacy policy (/privacy) and terms of use (/terms) for the service as a
 * whole: the MCP server, the REST API and the apps built on them (ChatGPT
 * plugin, Make, RapidAPI, the EmDash plugin). App directories require both
 * URLs. They describe what this Worker actually does: keep them in step with
 * src/api/keys.ts (keys hold no record), the rate limits and the crawler.
 * The browser extension keeps its own page at /extension/privacy.
 */

import { page } from "../api/docs";
import { LIMITS, PUBLISHER, PUBLISHER_CONTACT_URL, PUBLISHER_LOCATION, PUBLISHER_URL, SERVICE_NAME } from "../config";

export const PRIVACY_PATH = "/privacy";
export const TERMS_PATH = "/terms";
const UPDATED = "16 November 2026";

export function privacyHtml(): string {
  return page({
    title: `Privacy: ${SERVICE_NAME}`,
    description: `What the ${SERVICE_NAME} by ${PUBLISHER} receives, what it does with it and what is kept.`,
    robots: "index, follow",
    badge: "Privacy",
    body: `<h1>Privacy: ${SERVICE_NAME}</h1>
<p class="lede">This page covers the ${SERVICE_NAME} at <code>mcp.searchscope.com.au</code>: its MCP server, its REST API, and the apps that call them, such as the ChatGPT plugin. It is free, has no user accounts and collects as little as it can. Last updated ${UPDATED}.</p>
<h2>What the service receives</h2>
<p>Each request carries the website address to audit and the optional settings for that tool (number of pages, a service, a location, a prompt count). When you use it through an AI assistant such as ChatGPT, the assistant sends only those tool inputs: the service does not receive your conversation, your name or your account details. As with any web request, standard connection details such as your IP address are also received.</p>
<h2>What it does with them</h2>
<p>The service fetches a small sample of that website's public pages (at most ${LIMITS.hardMaxPages}), analyses them in memory and returns the result. It has no user accounts and does not save audit requests or results. It sets no cookies, except the one described under Saving to Notion. Your IP address, and an API key if you send one, are used as short-lived counters to enforce the free usage limits.</p>
<p>Optional API keys are generated without a database: the service keeps no record of who asked for a key.</p>
<p>The service runs on Cloudflare, whose platform keeps operational logs for a sample of requests (such as the time, the endpoint called, the response status and network details) for a limited period. ${PUBLISHER} uses them only to keep the service running and to stop abuse, and does not sell them or use them for marketing.</p>
<h2>Saving to Notion</h2>
<p>If you use <a href="/notion">Save to Notion</a>, Notion asks you to allow the connection and choose which pages it may use. Notion then sends back a one-time code, which the service exchanges for an access token. That token is used only to find the page you chose and add the report under it, within the same request, and is then discarded: it is never stored, so the service cannot read or change anything in your Notion afterwards. The service does not read the content of your pages: it sees only the titles of the pages you shared, to pick where to save. You can remove the connection at any time in Notion, under Settings, then Connections.</p>
<p>While you are being sent to Notion and back, the service sets one cookie holding a random value, for at most 10 minutes, so that only the browser that started the request can complete it. It is removed when you return. Cloudflare's sampled request logs may record the web address Notion returns you to, which contains the one-time code; that code expires quickly and cannot be used again.</p>
<h2>The websites being audited</h2>
<p>The crawler reads only public pages, identifies itself in its user agent, stays on the one site it was asked about and stops after ${LIMITS.crawlBudgetMs / 1000} seconds. Reports can quote text from those pages, which is already public.</p>
<h2>Questions</h2>
<p>${PUBLISHER}'s general privacy policy is at <a href="${PUBLISHER_URL}privacy-policy/">${PUBLISHER_URL}privacy-policy/</a>. For anything about this service, contact us at <a href="${PUBLISHER_CONTACT_URL}">${PUBLISHER_CONTACT_URL}</a>.</p>`,
  });
}

export function termsHtml(): string {
  return page({
    title: `Terms of use: ${SERVICE_NAME}`,
    description: `The terms for using the free ${SERVICE_NAME} by ${PUBLISHER}.`,
    robots: "index, follow",
    badge: "Terms",
    body: `<h1>Terms of use: ${SERVICE_NAME}</h1>
<p class="lede">These terms cover the ${SERVICE_NAME} at <code>mcp.searchscope.com.au</code>, provided by ${PUBLISHER}, an SEO consultancy in ${PUBLISHER_LOCATION}: its MCP server, its REST API and the apps that call them, such as the ChatGPT plugin. By using it you agree to them. Last updated ${UPDATED}.</p>
<h2>The service</h2>
<p>The service is free. It reads a small sample of a public website's pages and reports how ready the site is for AI search, with suggested fixes. ${PUBLISHER} can change, limit or stop the service at any time, including the free usage limits.</p>
<h2>Fair use</h2>
<p>Audit websites you own, manage or have a legitimate reason to review. Do not use the service to load-test or attack a website, to get around its rate limits (for example by spreading requests across many keys or addresses), or to reach private, internal or IP-address hosts. Requests that break these rules may be refused.</p>
<h2>The results</h2>
<p>Reports are produced automatically from the pages the crawler could read at that moment. They are general guidance, not a guarantee of how any AI assistant or search engine will treat a site: the service does not measure real citations or rankings inside AI assistants. Check any change before you make it. Text quoted in a report comes from the audited website and belongs to its owner.</p>
<h2>No warranty</h2>
<p>The service is provided as is, without any warranty that it will be available, error free or fit for a particular purpose. To the extent the law allows, ${PUBLISHER} is not liable for any loss arising from its use. Nothing in these terms excludes rights you have under the Australian Consumer Law that cannot be excluded.</p>
<h2>Privacy</h2>
<p>What the service receives and keeps is described at <a href="${PRIVACY_PATH}">${PRIVACY_PATH}</a>.</p>
<h2>Contact</h2>
<p>Questions about these terms: <a href="${PUBLISHER_CONTACT_URL}">${PUBLISHER_CONTACT_URL}</a>. These terms are governed by the laws of Western Australia.</p>`,
  });
}
