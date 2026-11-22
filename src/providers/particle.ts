// Particle provider — podcast dialogue search and transcripts (particle.pro).
//
// Particle transcribes and speaker-labels a large podcast corpus. Two calls
// are used here:
//   - episodes/search with keyword_search (BM25 over dialogue; every unquoted
//     term must appear by default), which matches social_search's keyword
//     guidance. Each result is one episode segment with windows of dialogue
//     around the matching lines.
//   - episodes/{id}/transcript?format=dialogue, the full speaker-attributed
//     transcript, served through fetch_page for a radar.particle.pro episode URL
//     — the same "read the URL to get what was said" pattern as YouTube.
//
// Verified against the live API 2026-11-22: X-API-Key auth; the transcript
// endpoint accepts the episode slug from a web_url as well as the id; errors
// are RFC 7807 JSON with a `detail` field. The Individual plan bills overage
// per call, so every call here consumes the daily budget.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { ScrapedPage, SearchResult } from './types';

const API_BASE = 'https://api.particle.pro/v1';
const TEXT_MAX = 600;

interface Line {
	speaker?: string;
	role?: string;
	start_seconds?: number;
	text?: string;
	is_match?: boolean;
}

interface SearchItem {
	episode?: {
		id?: string;
		title?: string;
		published_at?: string;
		web_url?: string;
		podcast?: { title?: string };
	};
	segment?: { title?: string };
	windows?: Array<{ lines?: Line[] }>;
}

interface TranscriptResponse {
	episode_id?: string;
	language?: string;
	duration_seconds?: number;
	lines?: Line[];
}

async function particleGet(env: Env, path: string, params?: URLSearchParams): Promise<unknown> {
	if (!env.PARTICLE_API_KEY) {
		throw new ProviderError('PARTICLE_API_KEY is not configured, so podcast search is unavailable.');
	}
	await consumeBudget(env, 'particle');
	const res = await fetch(`${API_BASE}${path}${params ? `?${params}` : ''}`, {
		headers: { 'X-API-Key': env.PARTICLE_API_KEY }
	});
	if (res.ok) return res.json();

	const text = await res.text();
	let detail = text.slice(0, 200);
	try {
		const body = JSON.parse(text) as { detail?: string };
		if (body.detail) detail = body.detail;
	} catch {
		// Keep the raw text.
	}
	if (res.status === 401 || res.status === 403) {
		throw new ProviderError(`Particle rejected the API key — check PARTICLE_API_KEY. (${detail})`);
	}
	if (res.status === 404) throw new ProviderError(`Particle: ${detail}.`);
	if (res.status === 429) {
		const retry = res.headers.get('retry-after');
		throw new ProviderError(
			`Particle rate limit hit${retry ? ` — retry after ${retry} seconds` : ' — retry shortly'}. (${detail})`
		);
	}
	throw new ProviderError(`Particle API error (${res.status}): ${detail}`);
}

/** 1627.9 → "27:07"; over an hour → "1:02:03". */
function clock(seconds: number | undefined): string {
	const s = Math.max(0, Math.floor(seconds ?? 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, '0');
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function trim(text: string, max: number): string {
	const clean = text.trim();
	return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function publishedAfter(time: string): string | null {
	const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const n = days[time];
	return n ? new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) : null;
}

export async function particleSearch(
	env: Env,
	opts: { query: string; time: string; sort: string; limit: number }
): Promise<SearchResult[]> {
	const params = new URLSearchParams({
		keyword_search: opts.query,
		limit: String(opts.limit),
		sort: opts.sort === 'new' ? 'recency' : 'relevance'
	});
	const since = publishedAfter(opts.time);
	if (since) params.set('since', since);

	const data = (await particleGet(env, '/podcasts/episodes/search', params)) as {
		data?: SearchItem[];
	};

	return (data.data ?? []).map((item) => {
		const lines = (item.windows ?? []).flatMap((w) => w.lines ?? []);
		const firstMatch = lines.find((l) => l.is_match);
		const excerpt = (item.windows ?? [])
			.map((w) => {
				const ls = w.lines ?? [];
				if (ls.length === 0) return '';
				return `[${clock(ls[0].start_seconds)}] ` + ls.map((l) => `${l.speaker ?? '?'}: ${l.text ?? ''}`).join(' ');
			})
			.filter(Boolean)
			.join(' … ');
		const episode = item.episode ?? {};
		const title = [episode.title, item.segment?.title].filter(Boolean).join(' — ');
		return {
			platform: 'podcasts' as const,
			id: episode.id ?? '',
			title,
			text: trim(excerpt, TEXT_MAX),
			author: firstMatch?.speaker ?? '',
			date: (episode.published_at ?? '').slice(0, 10),
			url: episode.web_url ?? '',
			...(episode.podcast?.title ? { community: episode.podcast.title } : {})
		};
	});
}

/** radar.particle.pro/podcasts/{podcast}/episodes/{episode} */
export function particleEpisodeSlug(url: URL): string | null {
	if (url.hostname.toLowerCase() !== 'radar.particle.pro') return null;
	const m = url.pathname.match(/^\/podcasts\/([^/]+)\/episodes\/([^/]+)\/?$/);
	return m ? decodeURIComponent(m[2]) : null;
}

function humanise(slug: string): string {
	return slug
		.split('-')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

/**
 * Full transcript as markdown. Consecutive lines by the same speaker are
 * merged into one turn, which roughly halves the size against one line per
 * utterance and keeps the timestamps useful.
 */
export async function particleTranscript(env: Env, url: URL): Promise<ScrapedPage> {
	const slug = particleEpisodeSlug(url);
	if (!slug) throw new ProviderError(`Not a Particle episode URL: ${url}`);
	const podcastSlug = url.pathname.split('/')[2] ?? '';

	const data = (await particleGet(
		env,
		`/podcasts/episodes/${encodeURIComponent(slug)}/transcript`,
		new URLSearchParams({ format: 'dialogue' })
	)) as TranscriptResponse;

	const turns: string[] = [];
	let speaker: string | null = null;
	let current: string[] = [];
	let start: number | undefined;
	let role = '';
	const flush = (): void => {
		if (speaker === null || current.length === 0) return;
		const who = role ? `${speaker} (${role.toLowerCase()})` : speaker;
		turns.push(`**[${clock(start)}] ${who}:** ${current.join(' ')}`);
	};
	for (const line of data.lines ?? []) {
		const name = line.speaker ?? 'Unknown';
		if (name !== speaker) {
			flush();
			speaker = name;
			role = line.role ?? '';
			start = line.start_seconds;
			current = [];
		}
		if (line.text) current.push(line.text.trim());
	}
	flush();

	if (turns.length === 0) {
		return {
			finalUrl: url.toString(),
			title: humanise(slug),
			status: 200,
			content: '',
			note: 'Particle has no transcript for this episode yet.'
		};
	}

	const header =
		`# ${humanise(slug)}\n\n` +
		`Podcast: ${humanise(podcastSlug)} · Duration: ${clock(data.duration_seconds)}` +
		(data.language ? ` · Language: ${data.language}` : '') +
		'\n\n';
	return {
		finalUrl: url.toString(),
		title: humanise(slug),
		status: 200,
		content: header + turns.join('\n\n')
	};
}
