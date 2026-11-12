# Accounts HTTP API

`Accounts.route(request)` answers these requests under its prefix, `/api/accounts` by default. `AccountClient` wraps all of them; this page is for clients written in other languages, and for debugging.

Bodies are JSON (`Content-Type: application/json`). A signed-in request carries the session either as the cookie (`tf_session` by default) or as `Authorization: Bearer <session token>`.

## Endpoints

| Method and path | Body | Needs | Answer |
| --- | --- | --- | --- |
| `POST /guest` | none, or `{ token }` to renew | nothing | `{ id, token, expiresAt, renewAt }` |
| `POST /register` | `{ name, password, email?, guestToken? }` | nothing | 201 `{ account, token }`, sets the cookie |
| `POST /login` | `{ name, password }` | nothing | `{ account, token }`, sets the cookie |
| `POST /logout` | none | a session | 204, clears the cookie |
| `GET /me` | | a session | the account |
| `DELETE /me` | `{ password }` | a session | 204: the account and everything in it is deleted |
| `POST /password` | `{ current, next }` | a session | `{ account, token }`: every other session ends |
| `POST /name` | `{ name }` | a session | the account |
| `POST /email` | `{ password, email }` | a session | the account. `email: null` removes it |
| `GET /export` | | a session | everything stored about the player, as a JSON download |
| `POST /token` | `{ scope? }` | a session | `{ token, expiresAt }`: a join token with the account name |
| `GET /data/:key` | | a session | `{ key, value }`, or 404 |
| `PUT /data/:key` | `{ value }` | a session; key with `write: "owner"` | `{ key, value }` |
| `DELETE /data/:key` | | a session; key with `write: "owner"` | 204 |
| `GET /players/:id` | | nothing | the public profile, or 404 |
| `GET /leaderboards/:stat?limit=&offset=` | | nothing | `{ stat, entries, total }`. `limit` is 1 to 100, default 20 |

Times are epoch milliseconds. Join and guest tokens go in the `token` query parameter when connecting to a room or a queue.

### Guests

`POST /guest` without a body makes up a new player. With `{ token }`, where `token` is a guest token that is still valid, it returns a fresh token for the same player. Renew once `renewAt` has passed; a token past `expiresAt` can't be renewed.

`POST /register` with `guestToken` creates the account under the guest's player id, so what the guest earned stays theirs.

### The account

`GET /me` and the endpoints that change the account return:

```json
{
  "id": "4b7c…",
  "name": "Ada",
  "email": null,
  "createdAt": 1767225600000,
  "data": { "settings": { "music": false } },
  "stats": { "wins": 12, "games": 30 }
}
```

A public profile (`GET /players/:id`) has the same shape without `email`, and with only the public data keys.

## Errors

Errors are JSON, with a machine-readable code:

```json
{ "error": "name_taken", "message": "That name is taken." }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | The body or URL is malformed |
| 400 | `invalid_name` | The name breaks the name rules |
| 400 | `weak_password` | The password is shorter than 8 characters |
| 400 | `invalid_email` | The email address is not one |
| 400 | `invalid_key` | A data key must be 1 to 64 letters, digits, dots, dashes or underscores |
| 400 | `invalid_value` | The data value is not JSON, or a stat is not a finite number |
| 400 | `invalid_stat` | A stat name must be 1 to 64 letters, digits, dots, dashes or underscores |
| 401 | `not_signed_in` | The request needs a session and has none that is valid |
| 401 | `invalid_credentials` | Wrong name or password |
| 403 | `wrong_password` | The password given to confirm a change is wrong |
| 403 | `read_only` | Players can't write this data key |
| 403 | `origin_not_allowed` | The request came from a page on an origin not in `allowedOrigins` |
| 404 | `not_found` | No such endpoint, player or data key |
| 409 | `name_taken` | Someone has that name |
| 409 | `account_exists` | This player id already has an account, e.g. a guest who registered before |
| 409 | `too_many_keys` | The player has `maxDataKeys` keys already |
| 413 | `value_too_large` | The value is over `maxDataBytes` |
| 415 | `json_required` | The body must be JSON |
| 429 | `too_many_attempts` | Too many failed sign-ins: wait and try again |
