// Shared provider shapes. Every platform normalises into these, so the calling
// model sees one consistent structure regardless of source — and the engagement
// signals (score, comments, date) survive intact for it to weigh.

export type Platform = 'reddit' | 'x' | 'youtube';

export interface SearchResult {
	platform: Platform;
	id: string;
	title?: string;
	text: string;
	/** Upvotes on Reddit, likes on X and YouTube. */
	score: number;
	/** Comment count on Reddit/YouTube, reply count on X. */
	comments: number;
	/** u/user, @handle, or channel name. */
	author: string;
	date: string;
	url: string;
	/** Subreddit on Reddit, channel on YouTube; absent for X. */
	community?: string;
	/** Views — YouTube only; the other platforms don't expose it. */
	views?: number;
}

export interface ThreadComment {
	score: number;
	author: string;
	date: string;
	/** Nesting level. Reddit nests; X replies and YouTube top-level comments are flat (0). */
	depth: number;
	text: string;
}

export interface Thread extends SearchResult {
	replies: ThreadComment[];
	note?: string;
}

/**
 * An open-web result. Deliberately NOT a SearchResult: pages carry no
 * engagement signals, and inventing a score/comment count would mislead the
 * calling model into weighing them like community-endorsed posts.
 */
export interface WebResult {
	title: string;
	url: string;
	published?: string;
	author?: string;
	highlights?: string[];
	text?: string;
}

/** Shared contract for keyword search engines (Brave, Tavily). */
export interface KeywordArgs {
	query: string;
	time: string;
	limit: number;
	content: 'highlights' | 'text' | 'none';
	includeDomains?: string[];
	excludeDomains?: string[];
}

export interface KeywordResponse {
	results: WebResult[];
	/** Caveats worth passing to the caller (clamped limits, unsupported options). */
	notes: string[];
	/** Which engine served this, for transparency. */
	engine: 'brave' | 'tavily';
	/** Credits consumed, if the engine reports them. Neither currently does. */
	creditsUsed?: number;
}

export interface ScrapedPage {
	finalUrl: string;
	title: string;
	status: number;
	content: string;
	note?: string;
}
