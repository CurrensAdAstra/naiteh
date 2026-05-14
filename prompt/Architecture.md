# Current Implementation Prompt

This prompt extends the root `architecture.md` for the current auth/admin
and legal RAG source work.

## Required behavior

1. The initial screen at the app dev port is a user login screen.
2. `/admin` is not a separate unauthenticated surface. It uses the same
   login screen and only reveals account management after an admin login.
3. Seed two local users:
   - `admin` with role `Admin`
   - `mgkyung` with role `User`
4. Admin users can view users, enable or disable non-admin accounts, and
   review audit logs.
5. Login attempts and selected work actions must be written to a local log.
6. The South Korean legal RAG source must use
   `https://github.com/legalize-kr/legalize-kr` as a whole managed Git
   repository.
7. The legal documents must live outside the user's vault at
   `<app-data-dir>/naiteh/rag/legalize-kr/repo`; the retrieval document root
   is `<app-data-dir>/naiteh/rag/legalize-kr/repo/kr`.

## Storage

- Account config belongs in backend-only `auth.json` under the OS app-config
  directory.
- Password hashes stay backend-only and never cross the IPC boundary.
- Audit records are append-only JSONL at `<app-config-dir>/audit-log.jsonl`.
- The generated law Markdown repository is app-managed data, not user notes.
  It must not be stored under a vault, and updates should fetch/reset the
  managed clone because the upstream repository may be rewritten.

## Implementation order

1. Update the architecture/spec first.
2. Add Rust auth and audit IPC.
3. Add TypeScript API wrappers and auth session state.
4. Gate `App` behind the login screen.
5. Add admin-only account/log sections to Settings.
6. Add legal RAG source status/sync IPC and Settings UI.
7. Add focused tests and verify the app at the dev URL.
