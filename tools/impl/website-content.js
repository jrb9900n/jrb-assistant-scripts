// tools/impl/website-content.js
// Placeholder for reading jrboehlke.com's current live page content (e.g. an
// existing SEO title/meta description/structured data) so the seo-advisor
// persona can check the actual current state of a page before drafting a
// propose_website_change call, rather than guessing.
//
// NOT IMPLEMENTED -- deliberately, not silently. A real implementation needs
// live browser automation against jrboehlke.com's proprietary "iNET Genesis"
// CMS admin (Credential Manager: JRBAgent:WEBSITE_URL/WEBSITE_USERNAME/
// WEBSITE_PASSWORD) to load a page's edit form and read its underlying field
// values (the CMS's own UI hides SEO-title/meta-description fields behind a
// "no permission" message that's a client-side restriction only). Building
// and verifying that automation was out of scope for the session that added
// this stub: no ability to log into jrboehlke.com or exercise a real browser
// session against it from this environment. Throws rather than returning
// empty/fabricated data specifically so neither a human nor the LLM calling
// this can mistake "not implemented" for "the page has no content."
//
// Note for whoever builds the real version: this codebase's existing
// browser-automation tools (tools/impl/serviceautopilot.js,
// tools/impl/fleetsharp.js) all use puppeteer-core with a persistent
// browser+page session and page.evaluate(fetch(...)) for the actual API
// calls -- there is no Playwright dependency anywhere in package.json or
// node_modules, despite an earlier assumption that there was. Follow the
// puppeteer-core session pattern those two files already establish unless
// there's a concrete, specific reason this CMS's forms need Playwright's
// API instead.

export async function getWebsitePageContent({ pageUrl } = {}) {
  throw new Error(
    `getWebsitePageContent is not implemented. Reading the live content of "${pageUrl ?? '(no pageUrl given)'}" ` +
    'requires real browser automation against jrboehlke.com\'s CMS admin (Credential Manager: ' +
    'JRBAgent:WEBSITE_URL/WEBSITE_USERNAME/WEBSITE_PASSWORD), which has not been built yet. ' +
    'Draft the proposal from whatever information Michael or another source has already given you ' +
    'about the current page (leave old_value blank if genuinely unknown), and say plainly that you ' +
    'could not independently verify the live page content.'
  );
}
