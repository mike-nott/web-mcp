// Runtime provider failures surface to the calling model as isError tool
// results (readable text), never as JSON-RPC protocol errors.

export class ProviderError extends Error {}

export class BudgetExceededError extends Error {}
