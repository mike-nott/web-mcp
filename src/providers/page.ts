// Tier 1 of fetch_page: a plain fetch with HTMLRewriter text extraction.
// Free, and succeeds on pages that are open but which the caller's own fetch
// refused or couldn't reach. Anything that smells like a block, a challenge, a
// JS shell, or a non-HTML document escalates to FireCrawl instead of being
// returned — returning challenge HTML as if it were content is precisely the
// failure mode this tool exists to prevent.

import { ProviderError } from './errors';
import type { ScrapedPage } from './firecrawl';

const FETCH_TIMEOUT_MS = 12000;
// Real articles and docs pages essentially always clear this; anything shorter
// is usually navigation chrome around an unrendered body, so it escalates.
const MIN_USEFUL_TEXT = 1000;

// A normal browser UA: many sites serve degraded or blocked responses to
// obviously-automated clients, and tier 1 exists to avoid burning credits.
const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const CHALLENGE_MARKERS = [
	'just a moment',
	'checking your browser',
	'cf-browser-verification',
	'__cf_chl',
	'attention required',
	'enable javascript and cookies to continue',
	'ddos protection by',
	'access denied',
	'are you a robot',
	'verify you are human'
];

/** Rejects non-public targets. Ported from ayima-chat/src/lib/server/tools/params.ts. */
export function assertPublicHttpsUrl(raw: string): URL {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new ProviderError(`'${raw}' is not a valid URL.`);
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') {
		throw new ProviderError('Only http:// and https:// URLs are allowed.');
	}
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost') throw new ProviderError('URL targets a non-public host.');
	if (/^[\d.]+$/.test(host) || host.includes(':')) {
		throw new ProviderError('IP-literal hosts are not allowed.');
	}
	if (!host.includes('.')) throw new ProviderError('URL hostname must include a TLD.');
	return u;
}

class TitleCollector {
	value = '';
	text(chunk: Text) {
		this.value += chunk.text;
	}
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	rsquo: '’',
	lsquo: '‘',
	ldquo: '“',
	rdquo: '”'
};

function decodeEntities(input: string): string {
	return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
		if (body.startsWith('#')) {
			const code =
				body[1]?.toLowerCase() === 'x'
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[body.toLowerCase()] ?? match;
	});
}

/**
 * Extracts readable text using the Workers-native HTMLRewriter — no npm
 * HTML-to-markdown dependency.
 *
 * Boilerplate is removed from the transformed *output*, then tags are stripped
 * from that cleaned HTML. Collecting text through handlers instead leaks script
 * bodies: remove() only affects output, while text handlers still fire for the
 * removed element's contents.
 */
async function extractText(response: Response): Promise<{ title: string; text: string }> {
	const title = new TitleCollector();

	const cleaned = await new HTMLRewriter()
		.on('title', title)
		.on('script, style, noscript, svg, head, nav, header, footer, aside, form, iframe, template', {
			element(el) {
				el.remove();
			}
		})
		.on('p, div, section, article, main, li, tr, h1, h2, h3, h4, h5, h6, br', {
			element(el) {
				el.after('\n', { html: false });
			}
		})
		.transform(response)
		.text();

	const text = decodeEntities(cleaned.replace(/<[^>]*>/g, ' '))
		.replace(/[^\S\n]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return { title: decodeEntities(title.value).trim(), text };
}

/**
 * Attempts the free path. Returns null when the caller should escalate to
 * FireCrawl; throws only for hard input errors.
 */
export async function directFetch(url: URL): Promise<ScrapedPage | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(url.toString(), {
			redirect: 'follow',
			signal: controller.signal,
			headers: {
				'User-Agent': BROWSER_UA,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'Accept-Language': 'en-GB,en;q=0.9'
			}
		});
	} catch {
		return null; // network failure or timeout — let FireCrawl try
	} finally {
		clearTimeout(timer);
	}

	if (res.status >= 400) return null;

	const contentType = res.headers.get('content-type') ?? '';
	// PDFs and other documents need real parsing; FireCrawl handles them.
	if (!contentType.includes('html') && !contentType.includes('text/plain')) return null;

	const { title, text } = await extractText(res);
	if (text.length < MIN_USEFUL_TEXT) return null; // SPA shell or stub

	const haystack = `${title} ${text.slice(0, 1500)}`.toLowerCase();
	if (CHALLENGE_MARKERS.some((marker) => haystack.includes(marker))) return null;

	return { finalUrl: res.url || url.toString(), title, status: res.status, content: text };
}
