# Lead Routes — Request Payload Reference

Base paths:
- **External API:** `/api/leads` — authenticated via `x-api-key` header
- **Browser / SSO:** `/api/ui/leads` — authenticated via `access_token` cookie (JWT)

---

## POST `/api/leads` — Create lead(s)
## POST `/api/leads/:collection` — Create lead(s) under a specific collection

### Without merge — always creates a new document

```json
{
  "data": {
    "name": "Dinesh",
    "email": "dinesh@example.com",
    "phone": "+91-9876543210",
    "address": "123 Main St",
    "interest": "chatbot"
  }
}
```

### With merge — upsert by specified fields (no duplicate if match found)

```json
{
  "config": {
    "merge": {
      "properties": ["email"]
    }
  },
  "data": {
    "name": "Dinesh",
    "email": "dinesh@example.com",
    "phone": "+91-9876543210",
    "interest": "chatbot"
  }
}
```

Multi-field merge example:

```json
{
  "config": {
    "merge": {
      "properties": ["name", "interest"]
    }
  },
  "data": {
    "name": "Dinesh",
    "address": "123 Main St",
    "interest": "chatbot"
  }
}
```

### Array — create multiple leads at once

Without merge (each item always becomes a new document):

```json
{
  "data": [
    { "name": "Dinesh", "email": "dinesh@example.com", "interest": "chatbot" },
    { "name": "Priya",  "email": "priya@example.com",  "interest": "AI" }
  ]
}
```

With merge (single `bulkWrite` round-trip; each item upserted by merge fields):

```json
{
  "config": {
    "merge": {
      "properties": ["email"]
    }
  },
  "data": [
    { "name": "Dinesh", "email": "dinesh@example.com", "interest": "chatbot" },
    { "name": "Priya",  "email": "priya@example.com",  "interest": "AI" }
  ]
}
```

### Collection via URL param

The `:collection` segment in `POST /api/leads/:collection` sets the lead collection.  
Alternatively, include `collection` inside `data`:

```json
{
  "data": {
    "collection": "enterprise",
    "name": "Dinesh",
    "email": "dinesh@example.com"
  }
}
```

> **Rules**
> - `data` is **mandatory**. A missing or empty `data` returns `400`.
> - `config` is **fully optional**. Omitting it always creates new documents.
> - If a merge property listed in `config.merge.properties` is absent from `data`, that field is silently excluded from the upsert filter — no error is thrown.

---

## PUT `/api/leads/:id` — Update a lead

### Without merge — updates the specific document by `:id` (ownership enforced)

```json
{
  "data": {
    "name": "Dinesh Updated",
    "phone": "+91-9999999999"
  }
}
```

### With merge — same upsert behaviour as POST; `:id` in the URL is **ignored**

```json
{
  "config": {
    "merge": {
      "properties": ["email"]
    }
  },
  "data": {
    "name": "Dinesh Updated",
    "email": "dinesh@example.com",
    "interest": "automation"
  }
}
```

> The merge path resolves the account from the authenticated context, then upserts by the merge fields + `acctId`. No ownership check by document ID is performed in this mode.

---

## GET `/api/leads` — Retrieve leads (grid)

No request body. All parameters are query strings.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | number | `1` | Page number |
| `limit` | number | `10` | Items per page |
| `sortBy` | string | `updatedAt` | Field to sort by |
| `sortOrder` | `asc` \| `desc` \| number | `-1` (desc) | Sort direction |
| `collectionId` | string | — | Filter by collection |
| `search` | string | — | Full-text search across all string fields |
| any lead field | string | — | Exact field filter (applied as case-insensitive regex) |

Example:

```
GET /api/leads?page=2&limit=20&collectionId=abc123&search=chatbot
```

> `createdAt` and `updatedAt` are **excluded** from the response data.

---

## DELETE `/api/leads/:id` — Delete a lead

No request body. Ownership is enforced — the lead must belong to the authenticated account.

---

## GET `/api/leads/collections` — List collections

No request body or query parameters required.

---

## PUT `/api/leads/collections/:collectionId/default` — Set default collection

No request body. Marks the specified collection as the default for the account.

---

## Recommended MongoDB indexes for merge performance

Create these indexes manually in MongoDB for production workloads that use merge:

| Merge fields | Index |
|---|---|
| `email` | `{ acctId: 1, email: 1 }` |
| `phone` | `{ acctId: 1, phone: 1 }` |
| `name` + `interest` | `{ acctId: 1, name: 1, interest: 1 }` |
| `name` + `email` | `{ acctId: 1, name: 1, email: 1 }` |
