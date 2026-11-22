// Alexandria provider — FireCrawl's catalogue of structured-data providers
// (SEC EDGAR, Fiscal.ai, BLS, ClinicalTrials.gov, USPTO, arXiv, FireCrawl's
// own research and government indexes, and hundreds more), reached with the
// ordinary FIRECRAWL_API_KEY.
//
// Everything goes through POST /v2/scrape with an `alexandria` array instead of
// a URL. "Find tools" is the same call addressed to provider "firecrawl",
// capability "find-tools" — that address is not in FireCrawl's docs; it comes
// from their published JS SDK (findTools → scrapeAlexandria), verified live
// 2026-11-22. find-tools with a `query` ranks as well as /v2/search with
// sources:["alexandria"], honours `limit`, and also returns each tool's price,
// so `find` uses it.
//
// Verified live 2026-11-22:
//   - find and inspect cost 0 credits; a call reports its cost in
//     data.creditsCost, which matched the account balance exactly.
//   - A wrong option is a free per-item error listing the valid options.
//   - Some tools are priced per record (`perRecord: true`, e.g. 300 credits a
//     record), so a call's cost is only known afterwards. The daily cap is
//     checked before and charged after; every call is also written to a usage
//     log so an expensive one can be traced (owner's choice, 2026-11-22).
//   - Every item carries a `nextStep` instruction telling the agent to rate the
//     result "before you answer the user". It is FireCrawl's feedback-refund
//     scheme, not the caller's task, so it is dropped along with the feedback
//     token and internal ids.

import type { Env } from '../env';
import { assertBudget, recordUsage } from '../budget';
import { ProviderError } from './errors';

const API_URL = 'https://api.firecrawl.dev/v2/scrape';
const API_TIMEOUT_MS = 60000; // passed to FireCrawl (its own cap is 120 s)
const ABORT_MS = 75000; // our side, a margin past FireCrawl's deadline
const LOG_TTL_SECONDS = 90 * 86400;
const LOG_OPTIONS_MAX = 300;

interface ItemError {
	code?: string;
	message?: string;
	status?: number;
	requiresAction?: { url?: string };
}

interface RawItem {
	provider?: string;
	capability?: string;
	data?: unknown;
	error?: ItemError;
	requiresAction?: { url?: string };
	creditsCost?: number;
	records?: number;
	upstreamStatus?: number;
	attribution?: string;
	sourceAttribution?: { name?: string; url?: string; text?: string } | null;
}

interface RawResponse {
	success?: boolean;
	error?: string;
	data?: { alexandria?: RawItem[]; creditsCost?: number };
}

interface RawTool {
	id?: string;
	provider?: string;
	capability?: string;
	name?: string;
	description?: string;
	creditsCost?: number;
	perRecord?: boolean;
	requiresOneOf?: unknown;
	billing?: unknown;
	options?: unknown;
	response?: unknown;
	examples?: unknown;
	attribution?: string;
	sourceAttribution?: { name?: string; url?: string; text?: string } | null;
}

export interface ToolSummary {
	provider: string;
	capability: string;
	name?: string;
	description: string;
	credits_cost?: number;
	per_record?: boolean;
	requires_one_of?: unknown;
	billing?: unknown;
}

export interface ToolDetail extends ToolSummary {
	options?: unknown;
	response?: unknown;
	examples?: unknown;
	source?: string;
}

export interface CallResult {
	provider: string;
	capability: string;
	credits_used: number;
	records?: number;
	source?: string;
	truncated?: boolean;
	total_chars?: number;
	data?: unknown;
	/** Present instead of `data` when the JSON exceeded max_chars. */
	data_truncated?: string;
}

/** A per-item failure: FireCrawl's own message, plus what was charged. */
export class AlexandriaCallError extends ProviderError {}

async function post(env: Env, item: Record<string, unknown>): Promise<RawResponse> {
	if (!env.FIRECRAWL_API_KEY) {
		throw new ProviderError('FIRECRAWL_API_KEY is not configured, so Alexandria is unavailable.');
	}
	const res = await fetch(API_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
			'Content-Type': 'application/json',
			'x-request-id': crypto.randomUUID()
		},
		body: JSON.stringify({ alexandria: [item], timeout: API_TIMEOUT_MS }),
		signal: AbortSignal.timeout(ABORT_MS)
	}).catch((err: unknown) => {
		const timedOut = err instanceof Error && err.name === 'TimeoutError';
		throw new ProviderError(
			timedOut
				? `Alexandria did not answer within ${ABORT_MS / 1000} seconds — try narrower options.`
				: `Could not reach Alexandria: ${err instanceof Error ? err.message : String(err)}`
		);
	});

	if (!res.ok) {
		const text = await res.text();
		if (res.status === 401 || res.status === 403) {
			throw new ProviderError('FireCrawl rejected the API key, or this team has no Alexandria access.');
		}
		if (res.status === 402) {
			throw new ProviderError('FireCrawl credits exhausted — top up at firecrawl.dev.');
		}
		if (res.status === 429) {
			const retry = res.headers.get('retry-after');
			throw new ProviderError(
				`FireCrawl rate limit hit${retry ? ` — retry after ${retry} seconds` : ' — retry shortly'}.`
			);
		}
		throw new ProviderError(`Alexandria API error (${res.status}): ${text.slice(0, 300)}`);
	}
	const body = (await res.json()) as RawResponse;
	if (!body.success) {
		throw new ProviderError(`Alexandria request failed: ${body.error ?? 'unknown error'}`);
	}
	return body;
}

/** The single item of a one-call request, or a readable error. */
function firstItem(body: RawResponse): RawItem {
	const item = body.data?.alexandria?.[0];
	if (!item) throw new ProviderError('Alexandria returned no result.');
	return item;
}

function itemErrorMessage(item: RawItem, charged: number): string {
	const e = item.error ?? {};
	const where = `${item.provider ?? '?'}/${item.capability ?? '?'}`;
	if (e.code === 'THIRD_PARTY_DATA_TERMS_REQUIRED') {
		const url = e.requiresAction?.url ?? item.requiresAction?.url;
		return (
			`${where} needs its data terms accepted before first use. An admin of the FireCrawl team must ` +
			`review and accept them${url ? ` at ${url}` : ' in FireCrawl settings → Data sources'}. ` +
			'Tell the user and ask them to do it; never accept terms yourself. No credits were charged.'
		);
	}
	const base = `${where}: ${e.message ?? 'unknown error'}${e.code ? ` (${e.code})` : ''}`;
	return charged > 0 ? `${base} — ${charged} credits were charged.` : `${base} — no credits were charged.`;
}

function sourceLine(item: { attribution?: string; sourceAttribution?: RawItem['sourceAttribution'] }): string | undefined {
	const sa = item.sourceAttribution;
	if (sa?.text || sa?.url) return [sa.text ?? sa.name, sa.url].filter(Boolean).join(' — ');
	return item.attribution?.trim() || undefined;
}

function summarise(t: RawTool): ToolSummary {
	return {
		provider: t.provider ?? '',
		capability: t.capability ?? '',
		...(t.name ? { name: t.name } : {}),
		description: t.description ?? '',
		...(typeof t.creditsCost === 'number' ? { credits_cost: t.creditsCost } : {}),
		...(typeof t.perRecord === 'boolean' ? { per_record: t.perRecord } : {}),
		...(t.requiresOneOf !== undefined ? { requires_one_of: t.requiresOneOf } : {}),
		...(t.billing !== undefined ? { billing: t.billing } : {})
	};
}

async function findTools(env: Env, options: Record<string, unknown>): Promise<{ items: RawTool[]; total?: number }> {
	const item = firstItem(
		await post(env, { provider: 'firecrawl', capability: 'find-tools', options })
	);
	if (item.error) throw new AlexandriaCallError(itemErrorMessage(item, 0));
	const data = (item.data ?? {}) as { items?: RawTool[]; total?: number };
	return { items: data.items ?? [], total: data.total };
}

/** Ranked tools for a described need, with prices. Free. */
export async function alexandriaFind(
	env: Env,
	args: { query: string; limit: number }
): Promise<{ tools: ToolSummary[]; total?: number }> {
	const { items, total } = await findTools(env, {
		query: args.query,
		level: 'tools',
		limit: args.limit
	});
	return { tools: items.map(summarise), ...(typeof total === 'number' ? { total } : {}) };
}

/** One tool's inputs, response fields and price. Free. */
export async function alexandriaInspect(
	env: Env,
	args: { provider: string; capability: string; examples: boolean }
): Promise<ToolDetail> {
	const { items } = await findTools(env, {
		providers: [args.provider],
		capabilities: [args.capability],
		level: 'tools',
		expand: args.examples ? ['options', 'response', 'examples'] : ['options', 'response']
	});
	const tool = items.find((t) => t.capability === args.capability) ?? items[0];
	if (!tool) {
		throw new ProviderError(
			`No Alexandria tool ${args.provider}/${args.capability} — use action "find" to look it up.`
		);
	}
	const source = sourceLine(tool);
	return {
		...summarise(tool),
		...(tool.options !== undefined ? { options: tool.options } : {}),
		...(tool.response !== undefined ? { response: tool.response } : {}),
		...(tool.examples !== undefined ? { examples: tool.examples } : {}),
		...(source ? { source } : {})
	};
}

interface LogEntry {
	t: string;
	provider: string;
	capability: string;
	credits: number;
	records?: number;
	outcome: string;
	options: string;
}

/**
 * Appends one entry to today's usage log (KV key alexandria:log:YYYY-MM-DD,
 * kept 90 days). Read with:
 *   npx wrangler kv key get alexandria:log:2026-11-22 --binding KV --remote
 * Not atomic — two simultaneous calls can drop an entry — which is acceptable
 * for a single-user worker; the budget counter is the cost guard.
 */
async function logCall(env: Env, entry: LogEntry): Promise<void> {
	const key = `alexandria:log:${entry.t.slice(0, 10)}`;
	try {
		const existing = JSON.parse((await env.KV.get(key)) ?? '[]') as LogEntry[];
		existing.push(entry);
		await env.KV.put(key, JSON.stringify(existing), { expirationTtl: LOG_TTL_SECONDS });
	} catch {
		// Logging must never fail the call it records.
	}
}

/** Runs one tool. Charged at its listed price; counted against the daily credit cap. */
export async function alexandriaCall(
	env: Env,
	args: { provider: string; capability: string; options: Record<string, unknown>; maxChars: number }
): Promise<CallResult> {
	await assertBudget(env, 'alexandria');

	const started = new Date().toISOString();
	const optionsText = JSON.stringify(args.options);
	const base = {
		t: started,
		provider: args.provider,
		capability: args.capability,
		options: optionsText.length > LOG_OPTIONS_MAX ? optionsText.slice(0, LOG_OPTIONS_MAX) + '…' : optionsText
	};

	let body: RawResponse;
	try {
		body = await post(env, {
			provider: args.provider,
			capability: args.capability,
			options: args.options
		});
	} catch (err) {
		await logCall(env, {
			...base,
			credits: 0,
			outcome: `request_failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`
		});
		throw err;
	}

	const item = firstItem(body);
	const charged = body.data?.creditsCost ?? item.creditsCost ?? 0;
	await recordUsage(env, 'alexandria', charged);
	await logCall(env, {
		...base,
		credits: charged,
		...(typeof item.records === 'number' ? { records: item.records } : {}),
		outcome: item.error ? item.error.code ?? 'error' : 'ok'
	});

	if (item.error) throw new AlexandriaCallError(itemErrorMessage(item, charged));

	const source = sourceLine(item);
	const json = JSON.stringify(item.data ?? null);
	const result: CallResult = {
		provider: item.provider ?? args.provider,
		capability: item.capability ?? args.capability,
		credits_used: charged,
		...(typeof item.records === 'number' ? { records: item.records } : {}),
		...(source ? { source } : {})
	};
	if (json.length > args.maxChars) {
		return {
			...result,
			truncated: true,
			total_chars: json.length,
			data_truncated: json.slice(0, args.maxChars) + ' … [truncated]'
		};
	}
	return { ...result, data: item.data ?? null };
}
