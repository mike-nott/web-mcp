// Transcript provider (Supadata) — the only working route to what is actually
// said in a video. The official YouTube API is a dead end here: captions.download
// needs the video owner's OAuth and auto-generated captions aren't exposed at
// all, while scraping the watch page from a datacenter IP returns player chrome
// and a 401 (verified 2026-08-04).
//
// Also covers TikTok, Instagram, X and Facebook video through the same endpoint.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { ScrapedPage } from './types';

const API_BASE = 'https://api.supadata.ai/v1';
const POLL_BUDGET_MS = 25000; // stay inside MCP client tool timeouts (no SSE keepalive)
const POLL_INTERVAL_MS = 1500;
const JOB_TTL_SECONDS = 3600; // matches Supadata's 1h result retention

interface TranscriptResponse {
	content?: string;
	lang?: string;
	availableLangs?: string[];
	jobId?: string;
	status?: 'queued' | 'active' | 'completed' | 'failed';
	error?: string;
}

/** youtube.com/watch, youtu.be, shorts, plus the other platforms Supadata supports. */
export function isVideoUrl(url: URL): boolean {
	const host = url.hostname.replace(/^www\./, '').toLowerCase();
	const path = url.pathname;
	if (host === 'youtu.be') return true;
	if (host.endsWith('youtube.com')) {
		return path === '/watch' || path.startsWith('/shorts/') || path.startsWith('/live/');
	}
	if (host.endsWith('tiktok.com')) return /\/video\/|^\/t\//.test(path) || path.startsWith('/@');
	if (host.endsWith('instagram.com')) return /^\/(reel|reels|tv|p)\//.test(path);
	if (host === 'x.com' || host.endsWith('twitter.com')) return /\/status(?:es)?\/\d+/.test(path);
	return false;
}

async function supadataGet(env: Env, path: string): Promise<{ status: number; body: TranscriptResponse }> {
	const res = await fetch(`${API_BASE}${path}`, {
		headers: { 'x-api-key': env.SUPADATA_API_KEY }
	});
	let body: TranscriptResponse = {};
	try {
		body = (await res.json()) as TranscriptResponse;
	} catch {
		// Non-JSON error bodies fall through to the status checks below.
	}
	return { status: res.status, body };
}

function mapError(status: number, body: TranscriptResponse, generate: boolean): ProviderError {
	if (status === 206) {
		return new ProviderError(
			'This video has no existing transcript or captions. Retry with generate: true to have one ' +
				'produced by speech recognition — note that costs substantially more (billed per minute of video).'
		);
	}
	if (status === 404) return new ProviderError('Video not found, or it is private.');
	if (status === 403) {
		return new ProviderError('Video is restricted or requires authentication, so it cannot be transcribed.');
	}
	if (status === 402) {
		return new ProviderError('Transcript service credits exhausted — top up at supadata.ai.');
	}
	if (status === 429) return new ProviderError('Transcript service rate limit hit — retry shortly.');
	const detail = body.error ? `: ${body.error}` : '';
	return new ProviderError(
		`Transcript request failed (HTTP ${status})${detail}${generate ? '' : ''}`
	);
}

async function pollJob(env: Env, jobId: string, deadline: number): Promise<string | null> {
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		const { status, body } = await supadataGet(env, `/transcript/${jobId}`);
		if (status !== 200) throw mapError(status, body, false);
		if (body.status === 'completed') return body.content ?? '';
		if (body.status === 'failed') {
			throw new ProviderError(`Transcript generation failed: ${body.error ?? 'unknown error'}`);
		}
	}
	return null; // still running when the budget ran out
}

/**
 * Fetches a video transcript. Videos over ~20 minutes are processed
 * asynchronously: we poll within the request budget, and if it is still running
 * we persist the jobId so a retry resumes the SAME job rather than starting —
 * and paying for — a second one.
 */
export async function fetchTranscript(
	env: Env,
	url: string,
	opts: { generate: boolean }
): Promise<ScrapedPage> {
	if (!env.SUPADATA_API_KEY) {
		throw new ProviderError(
			'SUPADATA_API_KEY is not configured, so video transcripts are unavailable.'
		);
	}
	const deadline = Date.now() + POLL_BUDGET_MS;
	const jobKey = `transcript:job:${url}`;

	// Resume an in-flight job from a previous call before starting a new one.
	const existingJob = await env.KV.get(jobKey);
	if (existingJob) {
		const resumed = await pollJob(env, existingJob, deadline);
		if (resumed !== null) {
			await env.KV.delete(jobKey);
			return { finalUrl: url, title: '', status: 200, content: resumed };
		}
		throw new ProviderError(
			'Transcript is still being processed for this long video. Call fetch_page again in a minute — ' +
				'the existing job will be resumed, not restarted, so it will not be charged twice.'
		);
	}

	await consumeBudget(env, 'supadata');

	// mode=native (1 credit) rather than Supadata's default auto, which silently
	// falls back to AI generation billed per minute — a long talk can cost more
	// than an entire month's plan. Generation must be asked for explicitly.
	const params = new URLSearchParams({
		url,
		text: 'true',
		mode: opts.generate ? 'auto' : 'native'
	});
	const { status, body } = await supadataGet(env, `/transcript?${params}`);

	if (status === 200) {
		const content = (body.content ?? '').trim();
		if (!content) throw new ProviderError('The transcript came back empty — no speech was detected.');
		return {
			finalUrl: url,
			title: '',
			status: 200,
			content,
			...(body.lang ? { note: `Transcript language: ${body.lang}` } : {})
		};
	}

	if (status === 202 && body.jobId) {
		await env.KV.put(jobKey, body.jobId, { expirationTtl: JOB_TTL_SECONDS });
		const result = await pollJob(env, body.jobId, deadline);
		if (result !== null) {
			await env.KV.delete(jobKey);
			return { finalUrl: url, title: '', status: 200, content: result };
		}
		throw new ProviderError(
			'This video is long enough to need background processing. Call fetch_page again in a minute — ' +
				'the job is already running and will be resumed, not charged again.'
		);
	}

	throw mapError(status, body, opts.generate);
}
